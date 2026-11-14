#!/system/bin/sh
# 目的：以最小权限启动统一 Web 入口；有证书就走 HTTPS，没有就退回 HTTP。
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
[ -f "$CERT" ] && { export WEB_TLS_CERT="$CERT"; export WEB_TLS_KEY="$KEY"; }

exec "$NODE" "$MODDIR/units/web/gateway.mjs"
