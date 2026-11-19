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

# 管理器「更新」时新代码默认落在 modules_update/<id>，要下次重启才搬到 modules/<id>。
# KernelSU / SukiSU 的模块规格里有官方的「热安装」：customize.sh 里导出
#   MODULE_HOT_INSTALL_REQUEST=true  +  MODULE_HOT_RUN_SCRIPT=hotinstall.sh
# 管理器就会装完立即换目录，并以 boot 脚本同样的方式跑 hotinstall.sh（旧版本不会帮你停，
# 文档明确要求有守护进程的模块自己在那个脚本里停旧起新）。我们的 web/bridge 正是守护进程。
# 老版本管理器没有这个能力（$KSU_HAS_HOT_INSTALL 不是 true）时，退回自己同步运行目录。
USE_HOT=0
if [ "${KSU_HAS_HOT_INSTALL:-false}" = "true" ]; then
  export MODULE_HOT_INSTALL_REQUEST=true
  export MODULE_HOT_RUN_SCRIPT=hotinstall.sh
  chmod 755 "$MODPATH/hotinstall.sh" 2>/dev/null
  [ -f "$MODPATH/hotinstall.sh" ] || \
    ui_print "  ! 安装包里没有 hotinstall.sh：热安装不会停旧实例（打包脚本白名单漏了？）"
  USE_HOT=1
  ui_print "- 已请求热安装：装完立即生效（由 hotinstall.sh 停旧起新），不需要重启"
fi

TARGET=/data/adb/modules/tinda-bot
RUN_DIR="$MODPATH"
if [ "$USE_HOT" = "0" ] && [ -n "$MODPATH" ] && [ "$MODPATH" != "$TARGET" ] && [ -d "$TARGET" ]; then
  if [ -f "$TARGET/remove" ] || [ -f "$TARGET/disable" ]; then
    ui_print "- 运行目录在管理器里是禁用/待删除状态，跳过同步"
  else
    ui_print "- 把新代码同步进运行目录（免重启生效）"
    if cp -a "$MODPATH/." "$TARGET/" 2>/dev/null; then
      RUN_DIR="$TARGET"
      chmod 755 "$TARGET"/bin/*.sh 2>/dev/null
    else
      ui_print "  ! 同步失败：这次更新要重启才生效"
    fi
  fi
fi
VER=$(sed -n 's/^version=//p' "$MODPATH/module.prop" 2>/dev/null | head -1)
printf '%s\n' "${VER:-unknown}" > "$DATA/run/installed.version" 2>/dev/null
ui_print "- 版本：${VER:-unknown}（运行目录 $RUN_DIR）"

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
    if [ "$USE_HOT" = "1" ]; then
      # 热安装：管理器换完目录后会跑 hotinstall.sh，由它停旧起新。这里别再起一次。
      ui_print "- web 交给热安装钩子启动（hotinstall.sh）"
    else
      ui_print "- 立即启动 web（不用等重启）"
      if command -v setsid >/dev/null 2>&1; then
        ( MODDIR="$RUN_DIR" DATA="$DATA" nohup setsid sh "$RUN_DIR/bin/unit.sh" restart web >/dev/null 2>&1 & )
      else
        ( MODDIR="$RUN_DIR" DATA="$DATA" nohup sh "$RUN_DIR/bin/unit.sh" restart web >/dev/null 2>&1 & )
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
    fi
    ;;
esac

ui_print "- 完成（重启后由 service.sh 按 AUTO_START 拉起）"
