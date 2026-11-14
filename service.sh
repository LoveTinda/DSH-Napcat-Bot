#!/system/bin/sh
# 目的：开机后等系统就绪，拉起 supervisor。
# 边界：只做启动；重启策略在 supervisor 内。
# 失败：启动失败写日志，不影响开机流程。

MODDIR=${0%/*}
DATA=/data/adb/tinda-bot

until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 2; done
sleep 20

mkdir -p "$DATA/logs"
echo "$(date '+%Y-%m-%dT%H:%M:%S') [info] service.sh 拉起 supervisor" >> "$DATA/logs/supervisor.log"
MODDIR="$MODDIR" sh "$MODDIR/bin/supervisor.sh" start
