#!/system/bin/sh
# 目的：以「降权后的普通应用 uid」拉起桥接器，root 只留在 supervisor 里。
# 边界：只负责 exec；不重试（supervisor 负责）；不读业务配置。
# 输入：tinda.conf 的 RUN_AS_UID / NODE_MAX_OLD_SPACE_MB
# 失败：未配置 UID 或 uid 非 root 时直接退出 78（宁可不起，也不要 root 跑业务）
# 副作用：切换 uid、设置资源上限、写启动日志

MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
. "$MODDIR/bin/lib.sh"
ensure_dirs
log_rotate

NODE="$MODDIR/bin/node"
APP="$MODDIR/app/src/index.js"
UID_TARGET=$(conf_get RUN_AS_UID "")
HEAP=$(conf_get NODE_MAX_OLD_SPACE_MB 512)

[ "$(id -u)" = "0" ] || { log error "supervisor 必须以 root 运行"; exit 78; }
[ -n "$UID_TARGET" ] || { log error "未配置 RUN_AS_UID：业务进程不允许以 root 运行"; exit 78; }
[ -x "$NODE" ] || { log error "运行时缺失：$NODE（P1 阶段加入，见 docs/生产就绪清单.md S-4）"; exit 78; }
[ -f "$APP" ] || { log error "入口缺失：$APP"; exit 78; }

log info "以 uid=$UID_TARGET 启动桥接器"

# 最小环境：不继承 root 的 PATH/变量；不传任何密钥（由进程自己从 secrets 读）
exec su "$UID_TARGET" -c "
  umask 077
  ulimit -n 1024 2>/dev/null
  ulimit -c 0 2>/dev/null
  cd '$MODDIR/app' || exit 78
  export HOME='$DATA'
  export PATH='/system/bin:/system/xbin'
  export NODE_OPTIONS='--max-old-space-size=$HEAP --disable-proto=throw'
  exec '$NODE' --enable-source-maps '$APP'
"
