#!/system/bin/sh
# 目的：真正拉起桥接器进程（P1 阶段接自带的 node 运行时）。
# 边界：只负责 exec，不重试；重试由 supervisor 负责。
# 当前状态：占位实现——运行时未就位时睡眠并记日志，避免 supervisor 空转。
# 失败：exec 失败直接退出非 0，supervisor 会退避重启。

MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
. "$MODDIR/bin/lib.sh"
ensure_dirs

NODE="$MODDIR/bin/node"
APP="$MODDIR/app/src/index.js"
[ -x "$NODE" ] || { log error "运行时缺失：$NODE（P1 阶段加入）"; exit 78; }
[ -f "$APP" ] || { log error "入口缺失：$APP"; exit 78; }

log info "启动桥接器"
exec "$NODE" --enable-source-maps "$APP"
