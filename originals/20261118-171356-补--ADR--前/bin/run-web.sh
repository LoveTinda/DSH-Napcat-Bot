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

NODE="$MODDIR/bin/node"; [ -x "$NODE" ] || NODE=$(command -v node)
[ -n "$NODE" ] || { log error "缺 node"; exit 78; }

TOKEN_FILE="$DATA/secrets/web.token"
# 空文件也算没有：网关会拒绝空 token 启动，所以这里必须把空文件补成真 token。
if [ ! -s "$TOKEN_FILE" ]; then
  _tmp="$TOKEN_FILE.tmp.$$"
  umask 077
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$_tmp" || { log error "生成 web.token 失败"; rm -f "$_tmp"; exit 78; }
  mv -f "$_tmp" "$TOKEN_FILE" || { rm -f "$_tmp"; log error "写入 web.token 失败"; exit 78; }
  chmod 600 "$TOKEN_FILE" 2>/dev/null
  log info "已生成新的 web.token（32 位十六进制）"
fi

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

export WEB_TOKEN="$(cat "$TOKEN_FILE")"
export WEB_BIND="$(conf_get WEB_BIND 0.0.0.0)"
export WEB_PORT="$(conf_get WEB_PORT 8443)"
export WEB_REDIRECT_PORT="$(conf_get WEB_REDIRECT_PORT 8088)"
# 证书装不进信任库时的逃生口；默认 0 = 关。
export WEB_HTTP_PORT="$(conf_get WEB_HTTP_PORT 0)"
# 各面板的「根路径端口」：DSH 和 NapCat 前端写死绝对路径 /api、/assets、/webui，
# 只有给它们各自的端口才能正常加载。0 = 不开。
export WEB_DSH_ORIGIN_PORT="$(conf_get WEB_DSH_ORIGIN_PORT 8444)"
export WEB_NAPCAT_ORIGIN_PORT="$(conf_get WEB_NAPCAT_ORIGIN_PORT 8445)"
# 桥接面板没有独立配置键：它和桥接器共用监听端口，网关从这里推导上游。
_BRIDGE_LISTEN="$(conf_get BRIDGE_LISTEN 127.0.0.1:6700)"
export BRIDGE_PANEL_PORT="$(printf '%s' "$_BRIDGE_LISTEN" | sed 's/.*://')"
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
