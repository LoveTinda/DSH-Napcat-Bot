# 目的：安装时建立运行态目录、初始化配置、摆好权限。
# 边界：不启动服务（由 service.sh 在开机时做）。
# 失败：缺目录或 chmod 失败时 abort，让安装显式失败而不是半装。

SKIPUNZIP=0
DATA=/data/adb/tinda-bot

ui_print "- Tinda Bot：创建运行态目录"
mkdir -p "$DATA/state" "$DATA/logs" "$DATA/run" "$DATA/secrets" "$DATA/etc"
chmod 700 "$DATA/secrets"

if [ ! -f "$DATA/etc/tinda.conf" ]; then
  cp "$MODPATH/etc/tinda.conf.example" "$DATA/etc/tinda.conf"
  chmod 600 "$DATA/etc/tinda.conf"
  ui_print "- 已生成 $DATA/etc/tinda.conf"
fi

chmod 755 "$MODPATH"/bin/*.sh 2>/dev/null
ui_print "- 完成（服务在开机时由 service.sh 拉起）"
