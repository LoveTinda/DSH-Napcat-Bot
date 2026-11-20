#!/system/bin/sh
# 目的：以最小权限启动统一 Web 入口；有证书就走 HTTPS，没有就退回 HTTP。
# 边界：只准备 token/证书/端口并 exec，不实现代理逻辑。
# 依赖：node、openssl（生成证书时）；配置来自 $DATA/etc/tinda.conf。
# 失败：缺 node 退出 78；token 写不进去退出 78；证书生成失败则退回 HTTP 并告警。
# 安全：token 与私钥都从 secrets 读，不出现在命令行；没有 token 文件就生成 16 字节随机值。
if [ -z "$MODDIR" ]; then
  MODDIR=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
fi
. "$MODDIR/bin/lib.sh"
ensure_dirs

# 业务进程一律不进宿主：宿主 root 域只留 unit.sh/supervisor，web 和 bridge 一样在
# DSH App 的 proot 里跑。理由：宿主是 Android root 域，跑 node 等于把整片 /data 和
# root 权限交给业务代码；proot 至少只给它 bind 进来的那几个目录。
# proot 的参数、探测和报错全部在 bin/proot-run.sh（web 与 bridge 共用一份，照抄 DSH
# App 自己启动 proot 的命令行）；proot-run.sh 会给 guest 导出 TINDA_IN_PROOT=1，
# 所以这里只要能看见这个变量就说明已经在 proot 里，直接往下跑，不再套一层。
# token 的权威是**宿主**：宿主生成后以 WEB_TOKEN 传进 guest，并写一份到共享存储给人看。
# 为什么不能反过来：宿主和 proot 里的 /data 实测可能是两份不同内容（同名不同物），
# 谁写谁读就对不上；共享存储 /sdcard 两边都看得见，适合当「贴给人看」的那一份。
TOKEN_FILE="$DATA/secrets/web.token"
SHARED_TOKEN="$(dirname "$MIRROR_DIR")/web.token"
_ensure_token() {
  _v=""
  if [ -s "$TOKEN_FILE" ]; then
    _v=$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n')
  elif [ -s "$SHARED_TOKEN" ]; then
    _v=$(cat "$SHARED_TOKEN" 2>/dev/null | tr -d '\r\n')
    umask 077
    printf '%s' "$_v" > "$TOKEN_FILE" 2>/dev/null
  else
    _tmp="$TOKEN_FILE.tmp.$$"
    umask 077
    head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$_tmp" || { log error "生成 web.token 失败"; rm -f "$_tmp"; return 1; }
    mv -f "$_tmp" "$TOKEN_FILE" || { rm -f "$_tmp"; log error "写入 web.token 失败"; return 1; }
    _v=$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n')
    log info "已生成新的 web.token（32 位十六进制）"
  fi
  [ -n "$_v" ] || { log error "token 为空：$TOKEN_FILE"; return 1; }
  WEB_TOKEN=$_v
  export WEB_TOKEN
  chmod 600 "$TOKEN_FILE" 2>/dev/null
  { printf '%s' "$_v" > "$SHARED_TOKEN"; chmod 600 "$SHARED_TOKEN"; } 2>/dev/null
  return 0
}

if [ "${TINDA_IN_PROOT:-0}" != "1" ] && [ -z "${TINDA_RF:-}" ]; then
  log info "web: 启动方式 proot（DSH App runtime rootfs）"
  exec sh "$MODDIR/bin/proot-run.sh" /bin/sh "$MODDIR/bin/run-web.sh"
fi

# 宿主侧先生成/读取 token，再进 proot：guest 只认这个值，不自己另造一份。
_ensure_token || exit 78

# 进到 guest：宿主已经通过 WEB_TOKEN 给过值，直接沿用；没有（例如宿主直跑）才现场准备。
[ -n "${WEB_TOKEN:-}" ] || _ensure_token || exit 78

NODE=/usr/local/bin/node
[ -x "$NODE" ] || NODE=$(command -v node)
[ -n "$NODE" ] || { log error "受限 rootfs 里没有 node（缺 /usr/local/bin/node）"; exit 78; }

# WEB_TOKEN 由上面的 _ensure_token 设置并导出；这里不再从 $DATA 重读，避免覆盖成 guest 本地那份。

WEB_LAN_IP=$(conf_get WEB_LAN_IP 192.168.1.3)
CERT="$DATA/secrets/tls.crt"; KEY="$DATA/secrets/tls.key"

# 证书 SAN 里至少要有当前局域网地址和回环；手机换 Wi-Fi 后旧证书会失效，
# 这里检测到不覆盖就重签，而不是让浏览器一直报证书错误。
_san="IP:127.0.0.1,IP:$WEB_LAN_IP,DNS:localhost"
_seen="127.0.0.1,$WEB_LAN_IP"
for _ip in $(hostname -I 2>/dev/null); do
  case "$_ip" in *:*) continue ;; esac
  case ",$_seen," in *",$_ip,"*) continue ;; esac
  _seen="$_seen,$_ip"
  _san="IP:$_ip,$_san"
done

_cert_ok=0
if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    _cert_ok=1
  elif openssl x509 -in "$CERT" -noout -checkend 86400 >/dev/null 2>&1 && \
       openssl x509 -in "$CERT" -noout -text 2>/dev/null | grep -qF "IP Address:$WEB_LAN_IP"; then
    _cert_ok=1
  fi
fi

if [ "$_cert_ok" -ne 1 ] && command -v openssl >/dev/null 2>&1; then
  if [ -f "$CERT" ] || [ -f "$KEY" ]; then
    mv -f "$CERT" "$CERT.old" 2>/dev/null
    mv -f "$KEY" "$KEY.old" 2>/dev/null
    log warn "证书不覆盖 $WEB_LAN_IP 或即将过期，已重签（旧文件保留为 .old）"
  fi
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$KEY" -out "$CERT" \
    -subj "/CN=tinda.local" -addext "subjectAltName=$_san" >/dev/null 2>&1 \
    || log warn "自签证书生成失败，退回 HTTP"
  chmod 600 "$KEY" "$CERT" 2>/dev/null
fi

# 网关自己的 console 输出只进 $DATA/logs/web.log（root 才能读）。把镜像目录
# （proot 里已 bind 成可写）告诉它，让它顺手写一份到共享存储，外面才看得到
# 「[web] listening」或者崩溃堆栈。
export TINDA_MIRROR_LOG="${MIRROR_DIR:-/sdcard/Bridge/Logs}/web-console.log"

# 模块信息页要读 module.prop / 配置 / pid / 日志；chroot 里这些路径同样可达
# （/data/adb/tinda-bot 是指向 /var/tinda 的符号链接，模块目录是指向 /opt/tinda-bot 的）。
export TINDA_DATA="$DATA"
export TINDA_MODDIR="$MODDIR"
# （token 已在 _ensure_token 里导出）
export WEB_BIND="$(conf_get WEB_BIND 0.0.0.0)"
export WEB_PORT="$(conf_get WEB_PORT 8443)"
export WEB_REDIRECT_PORT="$(conf_get WEB_REDIRECT_PORT 8088)"
# 证书装不进信任库时的逃生口；默认 0 = 关。
export WEB_HTTP_PORT="$(conf_get WEB_HTTP_PORT 0)"
# 各面板的「根路径端口」：DSH 和 NapCat 前端写死绝对路径 /api、/assets、/webui，
# 只有给它们各自的端口才能正常加载。0 = 不开。
export WEB_DSH_ORIGIN_PORT="$(conf_get WEB_DSH_ORIGIN_PORT 8444)"
export WEB_NAPCAT_ORIGIN_PORT="$(conf_get WEB_NAPCAT_ORIGIN_PORT 8445)"
# 桥接面板的端口（app 的 panel.port，默认 6702）。
# 为什么不能像以前那样从 BRIDGE_LISTEN(6700) 推导：6700 是 OneBot 事件入口，forward-ws 模式下
# 根本没人监听它，推导出来的上游永远是死的——控制台就一直是「桥接器不可达」。
# 端口若因残留实例顺延，桥接器会把真实值写进 state/app/endpoints.json，网关按那份文件跟随。
export BRIDGE_PANEL_PORT="$(conf_get BRIDGE_PANEL_PORT 6702)"
# 校验：端口必须是 1–65535 的整数；不合法就退回 6702 并留话（配置写错不该让网关起不来）。
case "$BRIDGE_PANEL_PORT" in
  ''|*[!0-9]*) log warn "BRIDGE_PANEL_PORT 不是数字（$BRIDGE_PANEL_PORT），改用 6702"; BRIDGE_PANEL_PORT=6702 ;;
esac
if [ "$BRIDGE_PANEL_PORT" -lt 1 ] || [ "$BRIDGE_PANEL_PORT" -gt 65535 ]; then
  log warn "BRIDGE_PANEL_PORT 越界（$BRIDGE_PANEL_PORT），改用 6702"
  BRIDGE_PANEL_PORT=6702
fi
export BRIDGE_PANEL_PORT
[ -f "$CERT" ] && { export WEB_TLS_CERT="$CERT"; export WEB_TLS_KEY="$KEY"; }

# NapCat 的 WebUI 有自己的一套 token，网关自动带给它，用户不用再手输一次。
NAPCAT_WEBUI_JSON="$(conf_get NAPCAT_WEBUI_JSON /opt/napcat/config/webui.json)"
if [ -f "$NAPCAT_WEBUI_JSON" ]; then
  _napcat_token=$("$NODE" -e 'try{const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(j&&j.token)process.stdout.write(String(j.token))}catch(e){}' "$NAPCAT_WEBUI_JSON" 2>/dev/null)
  [ -n "$_napcat_token" ] && export NAPCAT_WEBUI_TOKEN="$_napcat_token"
fi

# 资源上限（T-4）：网关只做转发，堆不需要大；上限防异常响应把手机内存吃光。
HEAP="$(conf_get WEB_HEAP_MB 192)"
case "$HEAP" in ''|*[!0-9]*) HEAP=192 ;; esac
[ "$HEAP" -lt 64 ] && HEAP=64
[ "$HEAP" -gt 2048 ] && HEAP=2048

# fd 上限（T-4）：node 的文件/套接字句柄数量有上限，先抬到配置值；抬不上去就保留系统值并告警。
FDS="$(conf_get UNIT_MAX_OPEN_FILES 4096)"
case "$FDS" in ''|*[!0-9]*) FDS=4096 ;; esac
ulimit -n "$FDS" 2>/dev/null || log warn "fd 上限抬到 $FDS 失败，继续用系统值"

log info "启动网关 cert=$([ -f "$CERT" ] && echo on || echo off) port=$WEB_PORT bridge=:$BRIDGE_PANEL_PORT heap=${HEAP}MB"
exec "$NODE" --max-old-space-size="$HEAP" "$MODDIR/units/web/gateway.mjs"
