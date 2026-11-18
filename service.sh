#!/system/bin/sh
# 目的：开机做目录/配置初始化，再按 AUTO_START 把「等 boot_completed + 启动单元」交给
#       后台的 bin/boot-start.sh，自己立即退出；开机阶段不 mount、不 chroot。
# 边界：不直接调用 unit.sh、不在这里等 boot_completed；AUTO_START 为空时等同旧版零动作。
# 依赖：Android sh、etc/tinda.conf.example。
# 失败：目录/配置写不进去只记日志，进程仍退出 0；不阻塞开机。
# 副作用：建 $DATA 目录、补配置、写 $DATA/logs/module.log。

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

log "service.sh 启动：MODDIR=$MODDIR"
[ -d /data/adb ] && log "形态：Android root（/data/adb 存在）" || log "warn: 没有 /data/adb，不是模块形态"

# 开机自启：等待 boot_completed 和逐个拉起单元都放在后台的 boot-start.sh 里，
# service.sh 只负责 fork 出去，自己立刻退出——旧版在这里最多等 180 秒 + 20 秒，
# 在 service.sh 早于 boot_completed 执行的设备上会直接拖住开机。
#
# 升级兼容：旧配置里没有 AUTO_START 这个键。缺键必须当成默认的 web，而不是「关」——
# 否则从 v0.3.1 升上来的人刷完新版、重启，照样什么都没有（v0.3.2 就栽在这）。
# 只有显式写空 / off / none / 0 才是「开机零动作」。
if grep -q '^AUTO_START=' "$DATA/etc/tinda.conf" 2>/dev/null; then
  _auto=$(grep -E '^AUTO_START=' "$DATA/etc/tinda.conf" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')
else
  _auto=web
  printf '\nAUTO_START=web\n' >> "$DATA/etc/tinda.conf" 2>/dev/null
  log "配置里没有 AUTO_START，已补默认值 web"
fi
case "$_auto" in
  ''|off|none|0)
    log "开机自启：关闭（AUTO_START 为空或 off）"
    log "手动启动示例：su -c 'sh $MODDIR/bin/unit.sh start web'"
    ;;
  *)
    log "开机自启：$_auto（交给后台 boot-start.sh，service.sh 不等）"
    ( MODDIR="$MODDIR" DATA="$DATA" sh "$MODDIR/bin/boot-start.sh" >/dev/null 2>&1 & )
    ;;
esac
log "service.sh 结束"
exit 0
