#!/system/bin/sh
# 目的：准备环境并 exec 桥接器（units/bridge/bridge.mjs），只做装配不碰业务。
# 边界：不重试、不探活（supervisor 负责）；不解释配置含义，只搬运。
# 依赖：node、units/bridge/bridge.mjs、$DATA/etc/tinda.conf、secrets/napcat.token。
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
# 回复策略（①）：文件不存在就用默认策略（开放但标"未加固"），面板会显示来源。
export BRIDGE_POLICY_FILE="$(conf_get BRIDGE_POLICY_FILE "$DATA/etc/bridge-policy.json")"
# 补发队列（T-8）：回复发不出去时落盘，重启后继续补；过期由 BRIDGE_OUTBOX_TTL_MS 控制。
export BRIDGE_OUTBOX_FILE="$DATA/state/bridge/outbox.json"
# 去重窗口落盘（跨重启），以及重连补推旧事件的最大容忍时长（秒）。
export BRIDGE_SEEN_FILE="$DATA/state/bridge/seen.json"
export BRIDGE_MAX_EVENT_AGE_SEC="$(conf_get BRIDGE_MAX_EVENT_AGE_SEC 120)"
export BRIDGE_SEND_RETRY="$(conf_get BRIDGE_SEND_RETRY 3)"
export BRIDGE_SEND_DRAIN_MS="$(conf_get BRIDGE_SEND_DRAIN_MS 15000)"
export BRIDGE_OUTBOX_TTL_MS="$(conf_get BRIDGE_OUTBOX_TTL_MS 21600000)"
export DSH_NODE="$(conf_get DSH_NODE "$NODE")"
export DSH_BIN="$(conf_get DSH_BIN /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js)"
export DSH_HOME="$(conf_get DSH_HOME /root/.dsh)"

# 告警（O-4）：ALERT_QQ 为空就是关；阈值/冷却/磁盘阈值都夹在合理区间内。
export ALERT_QQ="$(conf_get ALERT_QQ "")"
export ALERT_FAIL_STREAK="$(conf_get ALERT_FAIL_STREAK 3)"
export ALERT_COOLDOWN_SEC="$(conf_get ALERT_COOLDOWN_SEC 1800)"
export DISK_ALERT_PERCENT="$(conf_get DISK_ALERT_PERCENT 90)"

TOKEN_FILE="$DATA/secrets/napcat.token"
[ -f "$TOKEN_FILE" ] && export NAPCAT_TOKEN="$(cat "$TOKEN_FILE")"

# 资源上限（T-4）：给 V8 一个明确的堆上限，异常输出/会话暴涨时先 GC 再杀进程，而不是把手机拖死。
# 下限 64MB 给得下 node 自身；上限 2048MB 是 8GB 手机的保守值，再高会触发系统 LMK。
HEAP="$(conf_get BRIDGE_HEAP_MB 256)"
case "$HEAP" in ''|*[!0-9]*) HEAP=256 ;; esac
[ "$HEAP" -lt 64 ] && HEAP=64
[ "$HEAP" -gt 2048 ] && HEAP=2048

# fd 上限（T-4）：node 的文件/套接字句柄数量有上限，先抬到配置值；抬不上去就保留系统值并告警。
FDS="$(conf_get UNIT_MAX_OPEN_FILES 4096)"
case "$FDS" in ''|*[!0-9]*) FDS=4096 ;; esac
ulimit -n "$FDS" 2>/dev/null || log warn "fd 上限抬到 $FDS 失败，继续用系统值"

unset NODE_OPTIONS

log info "启动桥接器 $BRIDGE_LISTEN backend=$BRIDGE_BACKEND napcat=$NAPCAT_API"
exec "$NODE" --max-old-space-size="$HEAP" --enable-source-maps "$ENTRY"
