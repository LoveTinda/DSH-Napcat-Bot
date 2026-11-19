#!/system/bin/sh
# 目的：在 Magisk / KernelSU 里点模块的「操作」按钮时，一键把 web 控制台拉起来，
#       并把访问地址和 token 直接打印出来——手机上不用开终端、不用记命令。
# 边界：只调 bin/unit.sh start web；不装依赖、不改配置、不常驻、不碰 bridge/napcat。
# 依赖：bin/unit.sh、bin/lib.sh、$DATA/etc/tinda.conf、$DATA/secrets/web.token。
# 失败：单元起不来就打印 web.log 末尾；本脚本总是 exit 0（Magisk 只负责展示输出）。
MODDIR=${0%/*}
[ -d "$MODDIR/bin" ] || MODDIR=/data/adb/modules/tinda-bot
DATA=/data/adb/tinda-bot
. "$MODDIR/bin/lib.sh"
ensure_dirs

VER=$(sed -n 's/^version=//p' "$MODDIR/module.prop" 2>/dev/null | head -1)
echo "版本：${VER:-unknown}（$MODDIR）"
# 先跑一次 proot 探针并把结论打在这一屏：起不来时不用去翻日志猜
# （之前就是这样，只看到「已启动」然后端口一直连不上）。
echo "proot 探针：$(MODDIR="$MODDIR" DATA="$DATA" sh "$MODDIR/bin/proot-run.sh" probe 2>&1 | tail -2 | tr '\n' ' ')"

# 用 restart 而不是 start：卡住的旧实例会让 start 直接「已在运行」返回，点了没反应。
# 必须脱离管理器的进程组：管理器跑完 action.sh 会整组收尾，之前就是「启动了、也听过
# 端口、几秒后无声消失」，日志里连退出码都没有。
# 就绪标记从「镜像到共享存储的那份」看：proot 里的 $DATA 可能和这里不是同一个目录，
# 盯着宿主 $DATA/logs/web.log 会一直等不到 listening，按钮白等 30 秒。
_CONSOLE="$(dirname "$MIRROR_DIR")/Logs/web-console.log"
_sz=$(stat -c %s "$_CONSOLE" 2>/dev/null || echo 0)
if command -v setsid >/dev/null 2>&1; then
  ( MODDIR="$MODDIR" DATA="$DATA" nohup setsid sh "$MODDIR/bin/unit.sh" restart web >/dev/null 2>&1 & )
else
  ( MODDIR="$MODDIR" DATA="$DATA" nohup sh "$MODDIR/bin/unit.sh" restart web >/dev/null 2>&1 & )
fi
# 等就绪标记真的出现（最多 30 秒），别刚起就回「已启动」骗自己。
_i=0
while [ "$_i" -lt 60 ]; do
  tail -c +$(( _sz + 1 )) "$_CONSOLE" 2>/dev/null | grep -qF '[web] listening' && break
  _i=$((_i+1))
  sleep 0.5 2>/dev/null || sleep 1
done

# 桥接器才是面板里真正的内容。只起 web 的话，面板永远显示「这个面板还没起来」。
if [ -d "$MODDIR/units/bridge" ]; then
  if command -v setsid >/dev/null 2>&1; then
    ( MODDIR="$MODDIR" DATA="$DATA" nohup setsid sh "$MODDIR/bin/unit.sh" start bridge >/dev/null 2>&1 & )
  else
    ( MODDIR="$MODDIR" DATA="$DATA" nohup sh "$MODDIR/bin/unit.sh" start bridge >/dev/null 2>&1 & )
  fi
  echo "桥接器：已发起启动（面板顶部三个点会显示它的状态）"
fi

PORT=$(conf_get WEB_PORT 8443)
IP=$(conf_get WEB_LAN_IP "")
[ -n "$IP" ] || IP=$(/system/bin/ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)
# 优先读共享存储那份：proot 里网关读到的 $DATA 可能和这里不是同一个目录（实测过）。
TOKEN=$(cat "$(dirname "$MIRROR_DIR")/web.token" 2>/dev/null | tr -d '\r\n')
[ -n "$TOKEN" ] || TOKEN=$(cat "$DATA/secrets/web.token" 2>/dev/null)
# token 指纹（sha256 前 8 位）：和 /__info 里的一比，就知道网关读的是不是同一份文件。
# 之前正是这条线索缺失，才出现「这里印的 token 在那个网关上永远不对」。
FP=""
if [ -n "$TOKEN" ] && command -v sha256sum >/dev/null 2>&1; then
  FP=$(printf '%s' "$TOKEN" | sha256sum | cut -c1-8)
fi

echo ""
if [ -n "$TOKEN" ]; then
  URL="https://${IP:-<手机IP>}:$PORT/module/?k=$TOKEN"
  echo "token 指纹：${FP:-?}（/__info 里应完全相同；不同 = 网关读的是另一份 token）"
  echo "模块信息：$URL"
  echo "控制台：https://${IP:-<手机IP>}:$PORT/?k=$TOKEN"
  # Magisk 没有 WebUI 容器，直接拉起浏览器；失败也不影响面板已经起来。
  if command -v am >/dev/null 2>&1; then
    am start --user 0 -a android.intent.action.VIEW -d "$URL" >/dev/null 2>&1 \
      && echo "（已用浏览器打开模块信息页）" \
      || echo "（自动打开失败：手动复制上面的地址）"
  fi
else
  echo "还没生成 token：先看 $DATA/logs/web.log"
fi
# 顺手把日志导一份到共享存储，出问题不用 root 也能看
sh "$MODDIR/bin/export-logs.sh" 2>/dev/null
echo "状态：$(sh "$MODDIR/bin/unit.sh" status web 2>&1 | tail -1)"
echo "网关日志（最后 5 行，来自共享存储）："
tail -5 "$_CONSOLE" 2>/dev/null
exit 0
