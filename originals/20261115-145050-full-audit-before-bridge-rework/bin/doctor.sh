#!/system/bin/sh
# 目的：一条命令看清「现在这套到底通不通」：单元、端口、OneBot、桥接器、网关、备份、git。
# 边界：只读诊断，不改配置、不重启任何东西；连不上就报「连不上」，不猜原因。
# 失败：任何一项不过 → 退出码 1；全过 → 0。手机上没有 curl/wget，探活用模块自带 node。

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
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

echo "== 单元"
for u in napcat bridge web dsh; do
  _s=$(sh "$MODDIR/bin/unit.sh" status "$u" 2>&1 | tail -1)
  case "$_s" in
    *running*) ok "$_s" ;;
    *) warn "$_s";;
  esac
done

echo "== 端口"
for hp in 127.0.0.1:3001 127.0.0.1:6099 127.0.0.1:6700 127.0.0.1:3080 0.0.0.0:8443; do
  _h=${hp%:*}; _p=${hp##*:}
  if "$NODE" -e 'const net=require("net");const s=net.connect({host:process.argv[1],port:+process.argv[2]});s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),1500)' "$_h" "$_p" 2>/dev/null; then
    ok "$hp 在听"
  else
    bad "$hp 没在听"
  fi
done

echo "== OneBot"
TOKEN=$(cat "$DATA/secrets/napcat.token" 2>/dev/null)
if [ -n "$TOKEN" ]; then
  OUT=$("$NODE" -e '
const t=process.argv[1];
fetch("http://127.0.0.1:3001/get_login_info",{headers:{authorization:"Bearer "+t},signal:AbortSignal.timeout(4000)})
 .then(async r=>{const j=await r.json();const d=j.data||{};console.log((r.ok&&d.user_id?"ok ":"bad ")+"uid="+(d.user_id||"?")+" nick="+(d.nickname||"?"));})
 .catch(e=>console.log("bad "+e.message))' "$TOKEN" 2>/dev/null)
  case "$OUT" in ok*) ok "OneBot ${OUT#ok }";; *) bad "OneBot ${OUT#bad }";; esac
else
  warn "没有 napcat.token，跳过 OneBot 登录态检查"
fi

echo "== 桥接器"
OUT=$("$NODE" -e '
fetch("http://127.0.0.1:6700/panel/state.json",{signal:AbortSignal.timeout(4000)})
 .then(async r=>{const j=await r.json();console.log("ok backend="+j.backend+" 收到="+j.counts.incoming+" 成功="+j.counts.ok+" 失败="+j.counts.failed);})
 .catch(e=>console.log("bad "+e.message))' 2>/dev/null)
case "$OUT" in ok*) ok "$OUT";; *) bad "$OUT";; esac

echo "== 网关"
W=$(cat "$DATA/secrets/web.token" 2>/dev/null)
OUT=$("$NODE" -e '
process.env.NODE_TLS_REJECT_UNAUTHORIZED="0";
const k=process.argv[1];
fetch("https://127.0.0.1:8443/_/status",{headers:{cookie:"tinda="+k},signal:AbortSignal.timeout(4000)})
 .then(async r=>{if(r.status===401){console.log("bad 401（端口上的实例 token 和 secrets/web.token 不一致）");return;}console.log("ok "+await r.text());})
 .catch(e=>console.log("bad "+e.message))' "$W" 2>/dev/null)
case "$OUT" in ok*) ok "8443 ${OUT#ok }";; *) bad "8443 ${OUT#bad }";; esac

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
if [ -f "$DATA/logs/supervisor.log" ]; then
  if grep -qE '\[(error|fatal)\]' "$DATA/logs/supervisor.log"; then
    grep -E '\[(error|fatal)\]' "$DATA/logs/supervisor.log" | tail -5
  else
    echo "无 error/fatal"
  fi
else
  echo "无日志"
fi

echo
[ "$BAD" -eq 0 ] && echo "结论：主要链路都通" || echo "结论：有 FAIL 项，按上面的顺序逐项看"
exit "$BAD"
