#!/system/bin/sh
# 目的：安装时建立运行态目录、初始化配置、摆好权限，并**立刻起一次 web**，
#       让用户刷完就能打开控制台，不用先重启。
# 边界：只起 web；bridge/napcat 不在这里起（依赖 QQ/NapCat 登录，留给手动或开机）。
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

# 刷完就想能用：模块目录要重启才生效，但 web 只依赖 $DATA 和模块代码，
# 直接从安装暂存目录（$MODPATH）起一次，不必先重启。setsid 让它脱离安装进程，
# 安装器退出后继续跑；重启后由 service.sh 接管，不会起第二个（PID 文件就是锁）。
AUTO=$(grep -E '^AUTO_START=' "$DATA/etc/tinda.conf" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')
# 旧配置没有这个键：必须按默认 web 处理，否则升级用户刷完还是什么都没有。
grep -q '^AUTO_START=' "$DATA/etc/tinda.conf" 2>/dev/null || AUTO=web
case "$AUTO" in
  ''|off|none|0)
    ui_print "- AUTO_START=off：不自动起面板，重启后也不会起"
    ;;
  *)
    ui_print "- 立即启动 web（不用等重启）"
    if command -v setsid >/dev/null 2>&1; then
      ( MODDIR="$MODPATH" DATA="$DATA" nohup setsid sh "$MODPATH/bin/unit.sh" start web >/dev/null 2>&1 & )
    else
      ( MODDIR="$MODPATH" DATA="$DATA" nohup sh "$MODPATH/bin/unit.sh" start web >/dev/null 2>&1 & )
    fi
    sleep 2
    PORT=$(grep -E '^WEB_PORT=' "$DATA/etc/tinda.conf" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')
    [ -n "$PORT" ] || PORT=8443
    LAN=$(grep -E '^WEB_LAN_IP=' "$DATA/etc/tinda.conf" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')
    [ -n "$LAN" ] || LAN=$(ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)
    TOKEN=$(cat "$DATA/secrets/web.token" 2>/dev/null)
    if [ -n "$TOKEN" ]; then
      ui_print "  控制台：https://${LAN:-<手机IP>}:$PORT/?k=$TOKEN"
    else
      ui_print "  面板没起来（见 $DATA/logs/web.log）；重启后会自动再试，或点模块的「操作」"
    fi
    ;;
esac

ui_print "- 完成（重启后由 service.sh 按 AUTO_START 拉起）"
