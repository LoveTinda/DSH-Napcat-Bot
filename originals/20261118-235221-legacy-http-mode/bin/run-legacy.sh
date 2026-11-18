#!/system/bin/sh
# 目的：启动原版 napcat-dsh-bridge（opt-in 单元），只做环境装配。
# 边界：TYPE=exec，不 chroot、不 mount；不自动改配置；不改 v0.2.37 的启动安全层。
# 依赖：node、units/legacy/app/src/index.js、$DATA/etc/legacy.json。
# 失败：缺 node/入口 → 78；配置错误由 app 自己 fail fast，supervisor 退避重启。
# 副作用：首次用模板+bridge-policy 生成 $DATA/etc/legacy.json（0600），建 state/workspace。

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
. "$MODDIR/bin/lib.sh"
ensure_dirs

NODE="$MODDIR/bin/node"; [ -x "$NODE" ] || NODE=$(command -v node)
[ -n "$NODE" ] || { log error "缺 node 运行时"; exit 78; }

ENTRY="$MODDIR/units/legacy/app/src/index.js"
[ -f "$ENTRY" ] || { log error "入口缺失：$ENTRY"; exit 78; }

CONF="$DATA/etc/legacy.json"
if [ ! -f "$CONF" ]; then
  POLICY=$(conf_get BRIDGE_POLICY_FILE "$DATA/etc/bridge-policy.json")
  API=$(conf_get NAPCAT_API "http://127.0.0.1:3001")
  "$NODE" "$MODDIR/bin/legacy-config.mjs" \
    "$MODDIR/units/legacy/app/config.example.json" "$CONF" "$POLICY" "$API" || exit 78
  chmod 600 "$CONF" 2>/dev/null
  log warn "已生成 $CONF；白名单来自 $POLICY，没取到就手动改"
fi

# 与 NapCat 的 HTTP API 共用同一个 token；legacy 走 ws://127.0.0.1:3001。
if [ -f "$DATA/secrets/napcat.token" ]; then
  ONEBOT_ACCESS_TOKEN=$(cat "$DATA/secrets/napcat.token" 2>/dev/null)
  export ONEBOT_ACCESS_TOKEN
fi

export BRIDGE_STATE_DIR="$DATA/state/legacy"
export BRIDGE_WORKSPACE="$DATA/state/legacy/workspace"
mkdir -p "$BRIDGE_STATE_DIR" "$BRIDGE_WORKSPACE" 2>/dev/null
chmod 700 "$BRIDGE_STATE_DIR" 2>/dev/null

exec "$NODE" "$ENTRY" "$CONF"
