#!/system/bin/sh
# 目的：一条命令看清「现在这套到底通不通」：配置、单元、端口、OneBot、桥接器、网关、证书、备份、git。
# 边界：只读诊断，不改配置、不重启任何东西；连不上就报「连不上」，不猜原因。
# 依赖：bin/lib.sh、node（探活）、openssl（查证书 SAN，可选）。
# 失败：任何一项不过 → 退出码 1；全过 → 0。手机上没有 curl/wget，探活用模块自带 node。

if [ -z "$MODDIR" ]; then
  MODDIR=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
fi
. "$MODDIR/bin/lib.sh"
ensure_dirs

NODE="$MODDIR/bin/node"; [ -x "$NODE" ] || NODE=$(command -v node)
BAD=0
ok()   { echo "ok    $*"; }
warn() { echo "warn  $*"; }
bad()  { echo "FAIL  $*"; BAD=1; }

echo "== 环境"
echo "uid=$(id -u)  MODDIR=$MODDIR  DATA=$DATA"
if [ -d /data/adb/modules/tinda-bot ]; then echo "形态：Magisk 模块"; else echo "形态：仓库内直跑（无 /data/adb）"; fi
echo "node=$([ -n "$NODE" ] && "$NODE" -v 2>/dev/null || echo 缺)"

echo "== 资源与依赖"
# S-9：零第三方依赖是设计约束，不是口号；这道门禁和 pre-commit 跑的是同一份。
if [ -f "$MODDIR/bin/check-deps.mjs" ] && [ -n "$NODE" ]; then
  _deps=$("$NODE" "$MODDIR/bin/check-deps.mjs" 2>&1 | tail -1)
  case "$_deps" in
    ok*) ok "$_deps" ;;
    *) bad "$_deps" ;;
  esac
else
  warn "缺 bin/check-deps.mjs，跳过依赖检查"
fi
_disk=$(df -P "$DATA" 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}')
case "$_disk" in
  ''|*[!0-9]*) warn "读不到 $DATA 所在分区使用率" ;;
  *) if [ "$_disk" -ge 90 ]; then warn "数据分区已用 ${_disk}%（DISK_ALERT_PERCENT 阈值 90%）"; else ok "数据分区已用 ${_disk}%"; fi ;;
esac
# T-4：堆上限看进程命令行，fd 上限看 /proc/<pid>/limits —— 都是「实际生效」而不是「配置里写了」。
# PID 文件里是看守 subshell，不是 node；真实进程要按入口路径在 /proc 里找。
node_pid() {
  for _d in /proc/[0-9]*; do
    _p=${_d#/proc/}
    [ "$_p" = "$$" ] && continue
    _c=$(tr '\0' ' ' < "$_d/cmdline" 2>/dev/null)
    case "$_c" in
      *node*"$1"*) echo "$_p"; return ;;
    esac
  done
}
for u in bridge web; do
  case "$u" in
    bridge) _entry="units/bridge/bridge.mjs" ;;
    web) _entry="units/web/gateway.mjs" ;;
  esac
  _pid=$(node_pid "$_entry")
  if [ -z "$_pid" ] || [ ! -r "/proc/$_pid/limits" ]; then
    warn "$u 未运行，跳过资源上限核对"
    continue
  fi
  _heap=$(tr '\0' ' ' < "/proc/$_pid/cmdline" 2>/dev/null | sed -n 's/.*max-old-space-size=\([0-9][0-9]*\).*/\1/p')
  _fds=$(awk '/Max open files/ {print $4; exit}' "/proc/$_pid/limits" 2>/dev/null)
  [ -n "$_heap" ] && ok "$u heap=${_heap}MB（实际生效）" || bad "$u 没有 --max-old-space-size：HEAP 配置未生效，需重启 $u"
  [ -n "$_fds" ] && ok "$u fd 软上限=${_fds}" || warn "$u 读不到 fd 上限"
done

echo "== 配置"
if [ -f "$CONF" ]; then
  _mode=$(stat -c %a "$CONF" 2>/dev/null)
  [ "$_mode" = "600" ] && ok "$CONF ($_mode)" || warn "$CONF 权限是 $_mode，应为 600"
  _missing=0
  while IFS= read -r _line; do
    case "$_line" in ''|'#'*) continue ;; esac
    _key=$(printf '%s' "$_line" | cut -d= -f1 | tr -d '\r')
    case "$_key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    grep -qE "^$_key=" "$CONF" || _missing=$((_missing + 1))
  done < "$MODDIR/etc/tinda.conf.example"
  [ "$_missing" -eq 0 ] && ok "配置键与 example 对齐" || warn "配置缺 $_missing 个新键（ensure_dirs 会自动补；本项不影响已运行进程）"
  _unknown=0; _shown=0
  while IFS= read -r _line; do
    case "$_line" in ''|'#'*) continue ;; esac
    _key=$(printf '%s' "$_line" | cut -d= -f1 | tr -d '\r')
    case "$_key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    if ! grep -qE "^$_key=" "$MODDIR/etc/tinda.conf.example"; then
      _unknown=$((_unknown + 1))
      if [ "$_shown" -lt 5 ]; then warn "未知配置键：$_key（代码不读，删掉或补进 example/docs）"; _shown=$((_shown + 1)); fi
    fi
  done < "$CONF"
  [ "$_unknown" -gt 0 ] && warn "共有 $_unknown 个未知配置键；旧版配置残留会让排障误判"
else
  bad "缺 $CONF"
fi

BRIDGE_LISTEN=$(conf_get BRIDGE_LISTEN 127.0.0.1:6700)
BRIDGE_HOST=$(printf '%s' "$BRIDGE_LISTEN" | sed 's/:.*//')
BRIDGE_PORT=$(printf '%s' "$BRIDGE_LISTEN" | sed 's/.*://')
NAPCAT_API=$(conf_get NAPCAT_API http://127.0.0.1:3001)
API_HOST=$(printf '%s' "$NAPCAT_API" | sed -E 's#^[a-z]+://##; s#/.*$##; s#:[0-9]+$##')
API_PORT=$(printf '%s' "$NAPCAT_API" | sed -E 's#^.*:([0-9]+)/?$#\1#')
WEB_PORT=$(conf_get WEB_PORT 8443)
WEB_BIND=$(conf_get WEB_BIND 0.0.0.0)
WEB_DSH_ORIGIN_PORT=$(conf_get WEB_DSH_ORIGIN_PORT 8444)
WEB_NAPCAT_ORIGIN_PORT=$(conf_get WEB_NAPCAT_ORIGIN_PORT 8445)
WEB_REDIRECT_PORT=$(conf_get WEB_REDIRECT_PORT 8088)
WEB_HTTP_PORT=$(conf_get WEB_HTTP_PORT 0)
WEB_LAN_IP=$(conf_get WEB_LAN_IP 192.168.1.3)

echo "== 暴露面"
case "$BRIDGE_HOST" in 127.0.0.1|::1|localhost) ok "桥接器只绑回环（$BRIDGE_LISTEN）" ;; *) bad "桥接器监听 $BRIDGE_LISTEN：面板与 OneBot 入口会暴露到局域网" ;; esac
case "$API_HOST" in 127.0.0.1|::1|localhost) ok "NapCat OneBot API 只绑回环（$NAPCAT_API）" ;; *) warn "NapCat API 不是回环：$NAPCAT_API" ;; esac
case "$WEB_BIND" in 127.0.0.1|::1|localhost) ok "网关只绑回环（$WEB_BIND）" ;; *) ok "网关对外监听 $WEB_BIND:$WEB_PORT（需要 token）" ;; esac
if [ -s "$DATA/secrets/web.token" ]; then ok "web.token 非空"; else bad "web.token 为空：网关会拒绝启动"; fi

echo "== 目录与权限"
for d in "$DATA" "$DATA/state" "$DATA/logs" "$DATA/secrets" "$DATA/run"; do
  [ -d "$d" ] && ok "$d" || bad "缺 $d"
done
for f in "$DATA/secrets/web.token" "$DATA/secrets/napcat.token"; do
  if [ -f "$f" ]; then
    _m=$(stat -c %a "$f" 2>/dev/null)
    [ "$_m" = "600" ] && ok "$f ($_m)" || warn "$f 权限是 $_m，应为 600"
  else
    warn "缺 $f（网关/OneBot 首次启动会自动生成）"
  fi
done
CERT="$DATA/secrets/tls.crt"
if [ -f "$CERT" ]; then
  if command -v openssl >/dev/null 2>&1; then
    if openssl x509 -in "$CERT" -noout -checkend 86400 >/dev/null 2>&1; then
      if openssl x509 -in "$CERT" -noout -text 2>/dev/null | grep -qF "IP Address:$WEB_LAN_IP"; then
        ok "证书覆盖 $WEB_LAN_IP 且 24 小时内不过期"
      else
        warn "证书 SAN 不含 $WEB_LAN_IP：浏览器会报证书错误，重启 web 会自动重签"
      fi
    else
      warn "证书已过期或 24 小时内过期：重启 web 会自动重签"
    fi
  else
    warn "没有 openssl，跳过证书 SAN 检查"
  fi
else
  warn "没有 TLS 证书：网关会退回 HTTP"
fi

echo "== 单元"
for u in napcat bridge web dsh; do
  _s=$(sh "$MODDIR/bin/unit.sh" status "$u" 2>&1 | tail -1)
  case "$_s" in
    *running*) ok "$_s" ;;
    *) warn "$_s" ;;
  esac
done

check_port() {
  _h=$1; _p=$2; _label=$3
  case "$_p" in ''|0|*[!0-9]*) warn "$_label 端口无效：$_p"; return ;; esac
  if "$NODE" -e 'const net=require("net");const s=net.connect({host:process.argv[1],port:+process.argv[2]});s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1500)' "$_h" "$_p" 2>/dev/null; then
    ok "$_label $_h:$_p 在听"
  else
    bad "$_label $_h:$_p 没在听"
  fi
}

echo "== 端口"
check_port 127.0.0.1 "$API_PORT" "OneBot HTTP"
check_port 127.0.0.1 6099 "NapCat WebUI"
check_port 127.0.0.1 "$BRIDGE_PORT" "桥接器"
check_port 127.0.0.1 3080 "DSH"
check_port 127.0.0.1 "$WEB_PORT" "网关 HTTPS"
[ "$WEB_DSH_ORIGIN_PORT" != "0" ] && check_port 127.0.0.1 "$WEB_DSH_ORIGIN_PORT" "DSH 根路径端口"
[ "$WEB_NAPCAT_ORIGIN_PORT" != "0" ] && check_port 127.0.0.1 "$WEB_NAPCAT_ORIGIN_PORT" "NapCat 根路径端口"
[ "$WEB_REDIRECT_PORT" != "0" ] && check_port 127.0.0.1 "$WEB_REDIRECT_PORT" "明文跳转端口"
[ "$WEB_HTTP_PORT" != "0" ] && check_port 127.0.0.1 "$WEB_HTTP_PORT" "明文直连端口"

echo "== OneBot"
TOKEN=$(cat "$DATA/secrets/napcat.token" 2>/dev/null)
if [ -n "$TOKEN" ]; then
  OUT=$("$NODE" -e '
const t=process.argv[1];
fetch(process.argv[2]+"/get_login_info",{headers:{authorization:"Bearer "+t},signal:AbortSignal.timeout(4000)})
 .then(async r=>{const j=await r.json();const d=j.data||{};console.log((r.ok&&d.user_id?"ok ":"bad ")+"uid="+(d.user_id||"?")+" nick="+(d.nickname||"?"));})
 .catch(e=>console.log("bad "+e.message))' "$TOKEN" "$NAPCAT_API" 2>/dev/null)
  case "$OUT" in ok*) ok "OneBot $(printf '%s' "$OUT" | sed 's/^ok //')";; *) bad "OneBot $(printf '%s' "$OUT" | sed 's/^bad //')";; esac
else
  warn "没有 napcat.token，跳过 OneBot 登录态检查"
fi

echo "== 桥接器"
OUT=$("$NODE" -e '
fetch(process.argv[1]+"/panel/state.json",{signal:AbortSignal.timeout(4000)})
 .then(async r=>{if(!r.ok)throw new Error("HTTP "+r.status);const j=await r.json();console.log("ok backend="+j.backend+" 收到="+j.counts.incoming+" 成功="+j.counts.ok+" 失败="+j.counts.failed+" 跳过="+j.counts.skipped);})
 .catch(e=>console.log("bad "+e.message))' "http://127.0.0.1:$BRIDGE_PORT" 2>/dev/null)
case "$OUT" in ok*) ok "$OUT";; *) bad "$OUT";; esac

echo "== 网关"
W=$(cat "$DATA/secrets/web.token" 2>/dev/null)
if [ -n "$W" ]; then
  _scheme=http
  [ -f "$DATA/secrets/tls.crt" ] && _scheme=https
  OUT=$("$NODE" -e '
if(process.argv[3]==="https")process.env.NODE_TLS_REJECT_UNAUTHORIZED="0";
const k=process.argv[1];
fetch(process.argv[3]+"://127.0.0.1:"+process.argv[2]+"/_/status",{headers:{cookie:"tinda="+k},signal:AbortSignal.timeout(4000)})
 .then(async r=>{if(r.status===401){console.log("bad 401（端口上的实例 token 和 secrets/web.token 不一致）");return;}const t=await r.text();console.log(r.ok?"ok "+t:"bad HTTP "+r.status);})
 .catch(e=>console.log("bad "+e.message))' "$W" "$WEB_PORT" "$_scheme" 2>/dev/null)
  case "$OUT" in ok*) ok "网关 $(printf '%s' "$OUT" | sed 's/^ok //')";; *) bad "网关 $(printf '%s' "$OUT" | sed 's/^bad //')";; esac
else
  bad "没有 web.token，无法访问网关"
fi

echo "== 备份"
LATEST=$(ls -1dt /sdcard/backup/tinda-bot-* 2>/dev/null | head -1)
if [ -n "$LATEST" ]; then
  ok "最新备份 $(basename "$LATEST")（$(find "$LATEST" -type f 2>/dev/null | wc -l) 个文件）"
else
  warn "还没有 /sdcard/backup/tinda-bot-* 备份"
fi

echo "== git"
if [ -d "$MODDIR/.git" ]; then
  _d=$(cd "$MODDIR" && git status --porcelain 2>/dev/null | wc -l)
  [ "$_d" -eq 0 ] && ok "工作区干净 $(cd "$MODDIR" && git log --oneline -1)" || warn "有 $_d 个未提交改动"
else
  warn "不是 git 仓库"
fi

echo "== 最近错误"
_any=0
for _f in supervisor bridge web; do
  _p="$DATA/logs/$_f.log"
  [ -f "$_p" ] || continue
  _hits=$(tail -n 300 "$_p" 2>/dev/null | grep -E 'EADDRINUSE|Unhandled|fatal|\[error\]' | grep -v 'dbus' | tail -3)
  if [ -n "$_hits" ]; then
    warn "$_f.log 最近有错误："
    printf '%s\n' "$_hits"
    _any=1
  fi
done
[ "$_any" -eq 0 ] && echo "无 error/fatal"

echo
[ "$BAD" -eq 0 ] && echo "结论：主要链路都通" || echo "结论：有 FAIL 项，按上面的顺序逐项看"
exit "$BAD"
