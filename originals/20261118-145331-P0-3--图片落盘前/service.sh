#!/system/bin/sh
# 目的：开机后按单元逐个拉起（Magisk / KernelSU / SukiSU 都用这一份），并把过程写进 module.log。
# 边界：只调用 bin/unit.sh，不认识具体业务；不依赖 customize.sh —— KernelSU 系列不保证会执行它，
#       所以目录与配置在这里再初始化一次（幂等）。
# 依赖：Android sh、getprop、bin/unit.sh、etc/tinda.conf.example。
# 失败：某个单元起不来不影响其它单元；缺 node/rootfs 只记日志，由单元自己按失败关闭。
# 副作用：建 $DATA 目录、补配置、写 $DATA/logs/module.log、拉起单元进程。

MODDIR=${0%/*}
[ -d "$MODDIR/bin" ] || MODDIR=/data/adb/modules/tinda-bot
DATA=/data/adb/tinda-bot
LOG="$DATA/logs/module.log"

mkdir -p "$DATA/logs" "$DATA/state" "$DATA/run" "$DATA/secrets" "$DATA/etc" 2>/dev/null
chmod 700 "$DATA/secrets" "$DATA/state" 2>/dev/null
[ -f "$DATA/etc/tinda.conf" ] || {
  cp "$MODDIR/etc/tinda.conf.example" "$DATA/etc/tinda.conf" 2>/dev/null && chmod 600 "$DATA/etc/tinda.conf"
}
chmod 600 "$DATA/etc/tinda.conf" 2>/dev/null

log() {
  _ts=$(date '+%Y-%m-%dT%H:%M:%S')
  printf '%s %s\n' "$_ts" "$*" >> "$LOG" 2>/dev/null
  echo "$_ts $*"
}

# 等开机完成，但不要无限等：Magisk 的 late_start 有时很早，最多等 3 分钟。
_i=0
while [ "$(getprop sys.boot_completed 2>/dev/null)" != "1" ]; do
  _i=$((_i + 1))
  [ "$_i" -ge 90 ] && { log "warn: 等不到 sys.boot_completed，继续启动"; break; }
  sleep 2
done
# 给 NapCat/QQ 与网络留出时间；这个数在 RUNBOOK 里有说明，改它要同步文档。
sleep 20

log "service.sh 启动：MODDIR=$MODDIR"
[ -d /data/adb ] && log "形态：Android root（/data/adb 存在）" || log "warn: 没有 /data/adb，不是模块形态"

ROOTFS=/data/adb/tinda-bot/rootfs
if [ -d "$ROOTFS/usr" ]; then
  log "rootfs：$ROOTFS（单元会走 chroot）"
else
  log "rootfs：未初始化（单元走宿主直装；见 docs/安装-Magisk.md §5）"
fi
# 有 rootfs 就看 rootfs 里的 node（那才是单元真正会用到的），否则才看 Android 的 PATH。
if [ -d "$ROOTFS/usr" ]; then
  if chroot "$ROOTFS" /bin/sh -lc 'command -v node' >/dev/null 2>&1; then
    log "node：$(chroot "$ROOTFS" /bin/sh -lc 'node -v' 2>/dev/null)（rootfs 内）"
  else
    log "warn: rootfs 里没有 node —— 单元会 exit 78（apt install nodejs）"
  fi
elif command -v node >/dev/null 2>&1; then
  log "node：$(node -v 2>/dev/null)（PATH）"
elif [ -x "$MODDIR/bin/node" ]; then
  log "node：$MODDIR/bin/node"
else
  log "warn: 找不到 node —— 单元会 exit 78，直到装好运行时（S-4）"
fi

# 顺序：NapCat（OneBot 服务端）→ dsh（外部，只提示）→ bridge（找 3001）→ web（找 bridge 面板口）。
for u in napcat dsh bridge web; do
  _out=$(MODDIR="$MODDIR" sh "$MODDIR/bin/unit.sh" start "$u" 2>&1 | tail -2)
  log "$u: $(printf '%s' "$_out" | tr '\n' ' ')"
done
log "service.sh 结束"
exit 0
