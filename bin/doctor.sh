#!/system/bin/sh
# 目的：一条命令看清「为什么没起来」（O-1）。只读诊断，不改任何东西。
# 输出：环境、目录、配置、进程、socket、磁盘、最近错误各一节。
# 边界：不自动修复，不重启服务。

MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
. "$MODDIR/bin/lib.sh"

echo "== 环境"
echo "uid: $(id -u)  设备: $(getprop ro.product.model)  Android: $(getprop ro.build.version.sdk)"
echo "SELinux: $(getenforce 2>/dev/null)"

echo "== 目录"
for d in "$DATA" "$DATA/state" "$DATA/logs" "$DATA/secrets"; do
  [ -d "$d" ] && echo "ok   $d" || echo "缺   $d"
done

echo "== 配置"
[ -f "$CONF" ] && echo "ok   $CONF" || echo "缺   $CONF（照 etc/tinda.conf.example 复制一份）"
echo "RUN_AS_UID=$(conf_get RUN_AS_UID '')  LOG_MAX_MB=$(conf_get LOG_MAX_MB 50)"

echo "== 进程"
if [ -f "$DATA/run/supervisor.pid" ] && kill -0 "$(cat "$DATA/run/supervisor.pid")" 2>/dev/null; then
  echo "supervisor: running pid=$(cat "$DATA/run/supervisor.pid")"
else
  echo "supervisor: stopped"
fi
[ -x "$MODDIR/bin/node" ] && echo "运行时: ok" || echo "运行时: 缺（P1 未完成）"

echo "== socket"
SOCK=$(conf_get SOCKET_PATH "$DATA/run/bridge.sock")
[ -S "$SOCK" ] && echo "ok   $SOCK $(stat -c %a "$SOCK" 2>/dev/null)" || echo "缺   $SOCK"

echo "== 磁盘"
df -h /data 2>/dev/null | tail -1
[ -f "$DATA/logs/supervisor.log" ] && echo "日志大小: $(stat -c %s "$DATA/logs/supervisor.log") 字节"

echo "== 最近错误"
[ -f "$DATA/logs/supervisor.log" ] && grep -E '\[(error|fatal|warn)\]' "$DATA/logs/supervisor.log" | tail -5 || echo "无日志"
