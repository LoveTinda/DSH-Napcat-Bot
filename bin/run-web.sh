#!/system/bin/sh
# 目的：以最小权限启动统一 Web 入口；有证书就走 HTTPS，没有就退回 HTTP。
# 边界：只准备 token/证书并 exec，不实现代理逻辑。
# 失败：缺 node 退出 78；证书生成失败则退回 HTTP 并在日志告警。
# 安全：token 与私钥都从 secrets 读，不出现在命令行；没有 token 文件就生成一个。
MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
. "$MODDIR/bin/lib.sh"
ensure_dirs

NODE="$MODDIR/bin/node"; [ -x "$NODE" ] || NODE=$(command -v node)
[ -n "$NODE" ] || { log error "缺 node"; exit 78; }

TOKEN_FILE="$DATA/secrets/web.token"
[ -f "$TOKEN_FILE" ] || { head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"; }

CERT="$DATA/secrets/tls.crt"; KEY="$DATA/secrets/tls.key"
if [ ! -f "$CERT" ] && command -v openssl >/dev/null 2>&1; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout "$KEY" -out "$CERT" \
    -subj "/CN=tinda.local" -addext "subjectAltName=IP:$(conf_get WEB_LAN_IP 192.168.1.3),IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
  chmod 600 "$KEY" "$CERT"
fi

export WEB_TOKEN="$(cat "$TOKEN_FILE")"
export WEB_BIND="$(conf_get WEB_BIND 0.0.0.0)"
export WEB_PORT="$(conf_get WEB_PORT 8443)"
export WEB_REDIRECT_PORT="$(conf_get WEB_REDIRECT_PORT 8088)"
# 各面板的「根路径端口」：DSH 和 NapCat 前端写死绝对路径 /api、/assets、/webui，
# 只有给它们各自的端口才能正常加载。0 = 不开。
export WEB_DSH_ORIGIN_PORT="$(conf_get WEB_DSH_ORIGIN_PORT 8444)"
export WEB_NAPCAT_ORIGIN_PORT="$(conf_get WEB_NAPCAT_ORIGIN_PORT 8445)"
[ -f "$CERT" ] && { export WEB_TLS_CERT="$CERT"; export WEB_TLS_KEY="$KEY"; }

# NapCat 的 WebUI 有自己的一套 token，网关自动带给它，用户不用再手输一次。
NAPCAT_WEBUI_JSON="$(conf_get NAPCAT_WEBUI_JSON /opt/napcat/config/webui.json)"
if [ -f "$NAPCAT_WEBUI_JSON" ]; then
  export NAPCAT_WEBUI_TOKEN="$(grep -oE '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$NAPCAT_WEBUI_JSON" | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
fi

exec "$NODE" "$MODDIR/units/web/gateway.mjs"
