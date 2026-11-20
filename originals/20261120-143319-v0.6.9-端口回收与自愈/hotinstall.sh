#!/system/bin/sh
# 目的：KernelSU / SukiSU 的「热安装」钩子。规格见 modules 文档 Hot install 一节：
#       安装器（含 customize.sh）跑完后，管理器把 modules_update/<id> 换成 modules/<id>，
#       然后以 boot 脚本同样的方式执行本脚本（全局 mount namespace、cwd=脚本目录、
#       stdin=/dev/null、忽略 SIGPIPE、最多等 30 秒）。
#       文档明确要求：**旧版本不会帮你停**，有守护进程的模块要在本脚本里先停旧的再起新的。
# 边界：只停/起本模块自己的单元；不装依赖、不改配置、不碰别人的模块。
# 依赖：bin/lib.sh、bin/unit.sh、$DATA/etc/tinda.conf。
# 失败：单元起不来就打印 web.log 尾巴；本脚本总是 exit 0（安装结果不能因为服务没起来而失败）。
# 副作用：停掉旧实例、在后台拉起新实例、写一条安装日志到 $DATA/logs/module.log。

MODDIR=${0%/*}
[ -d "$MODDIR/bin" ] || MODDIR=/data/adb/modules/tinda-bot
DATA=/data/adb/tinda-bot
[ -f "$DATA/etc/tinda.conf" ] || mkdir -p "$DATA/etc" "$DATA/logs" "$DATA/run" 2>/dev/null
LOG="$DATA/logs/module.log"

say() {
  _ts=$(date '+%Y-%m-%dT%H:%M:%S')
  printf '%s %s\n' "$_ts" "$*" >> "$LOG" 2>/dev/null
  echo "$_ts $*"
}

VER=$(sed -n 's/^version=//p' "$MODDIR/module.prop" 2>/dev/null | head -1)
say "hotinstall: 模块已换成 ${VER:-unknown}（$MODDIR）"

# 旧实例可能正是卡死的那个：新版 unit.sh 的 do_stop 会连整棵树一起收，杀不掉会明说。
# 先停 bridge：旧实例会在后台按退避不断重试，换新代码后仍在跑旧逻辑。
if sh "$MODDIR/bin/unit.sh" stop bridge >> "$LOG" 2>&1; then
  say "hotinstall: 旧 bridge 已停止"
fi
if sh "$MODDIR/bin/unit.sh" stop web >> "$LOG" 2>&1; then
  say "hotinstall: 旧 web 已停止"
else
  say "hotinstall: 旧 web 没停干净（看 $LOG）"
fi

# 文档要求：长期跑的服务放后台起，安装器最多等 30 秒。
( MODDIR="$MODDIR" DATA="$DATA" sh "$MODDIR/bin/unit.sh" start web >> "$LOG" 2>&1 & )
say "hotinstall: 新版 web 已在后台启动（日志 $DATA/logs/web.log）"
# 桥接器一起拉起：只起 web 时面板会一直显示「这个面板还没起来」。
if [ -d "$MODDIR/units/bridge" ]; then
  ( MODDIR="$MODDIR" DATA="$DATA" sh "$MODDIR/bin/unit.sh" start bridge >> "$LOG" 2>&1 & )
  say "hotinstall: 桥接器已在后台启动"
fi
exit 0
