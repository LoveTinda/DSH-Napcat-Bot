#!/system/bin/sh
# 目的：准备环境并 exec 桥接器（units/bridge/bridge.mjs），只做装配不碰业务。
# 边界：不重试、不探活（supervisor 负责）；不解释配置含义，只搬运。
# 输入：tinda.conf 的 BRIDGE_* / NAPCAT_* / DSH_* 键；token 从 secrets 读，不走命令行。
# 失败：缺 node 或入口 → 78；上游地址非法 → 78。
# 副作用：无（只读配置、导出环境变量）。

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
. "$MODDIR/bin/lib.sh"
ensure_dirs

NODE="$MODDIR/bin/node"; [ -x "$NODE" ] || NODE=$(command -v node)
[ -n "$NODE" ] || { log error "缺 node 运行时"; exit 78; }

ENTRY="$MODDIR/units/bridge/bridge.mjs"
[ -f "$ENTRY" ] || { log error "入口缺失：$ENTRY"; exit 78; }

export BRIDGE_LISTEN="$(conf_get BRIDGE_LISTEN 127.0.0.1:6700)"
export NAPCAT_API="$(conf_get NAPCAT_API http://127.0.0.1:3001)"
export BRIDGE_BACKEND="$(conf_get BRIDGE_BACKEND headless)"
export BRIDGE_ALLOW_GROUP="$(conf_get BRIDGE_ALLOW_GROUP 1)"
export BRIDGE_TIMEOUT_MS="$(conf_get BRIDGE_TIMEOUT_MS 180000)"
export BRIDGE_PERMISSION_MODE="$(conf_get BRIDGE_PERMISSION_MODE "")"
export BRIDGE_STATE_FILE="$DATA/state/bridge/sessions.json"
export DSH_NODE="$(conf_get DSH_NODE "$NODE")"
export DSH_BIN="$(conf_get DSH_BIN /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js)"
export DSH_HOME="$(conf_get DSH_HOME /root/.dsh)"

TOKEN_FILE="$DATA/secrets/napcat.token"
[ -f "$TOKEN_FILE" ] && export NAPCAT_TOKEN="$(cat "$TOKEN_FILE")"

unset NODE_OPTIONS

log info "启动桥接器 $BRIDGE_LISTEN backend=$BRIDGE_BACKEND napcat=$NAPCAT_API"
exec "$NODE" --enable-source-maps "$ENTRY"
