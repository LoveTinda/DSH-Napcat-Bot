#!/system/bin/sh
# 目的：开机只做目录/配置初始化并立即退出；**不自动启动任何单元**，把开机风险降到最低。
# 边界：不调用 unit.sh、不等 boot_completed、不 chroot、不 mount；服务由人手动启动。
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

# 安全默认：开机阶段不启动任何单元，也不等 boot_completed、不 chroot、不挂载。
# 为什么：旧版在这里最多等 180 秒 + 20 秒，然后一次性拉起 4 个单元；在
# service.sh 早于 boot_completed 执行的设备上会直接拖住开机。需要服务时手动起：
#   su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh start web'
log "自动启动：关闭（安全默认）"
log "手动启动示例：su -c 'sh $MODDIR/bin/unit.sh start web'"
exit 0
