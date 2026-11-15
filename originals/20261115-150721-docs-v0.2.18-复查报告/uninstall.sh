# 目的：卸载时停掉进程，保留运行态与 git 仓库（便于回滚/取证）。
# 边界：不删除 /data/adb/tinda-bot（人工确认后再删）。
MODDIR=${0%/*}
MODDIR="$MODDIR" sh "$MODDIR/bin/supervisor.sh" stop >/dev/null 2>&1
echo "- 已停止守护；运行态与仓库保留在 /data/adb/tinda-bot"
