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

sh "$MODDIR/bin/unit.sh" start web
sleep 1

PORT=$(conf_get WEB_PORT 8443)
IP=$(conf_get WEB_LAN_IP "")
[ -n "$IP" ] || IP=$(/system/bin/ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)
TOKEN=$(cat "$DATA/secrets/web.token" 2>/dev/null)

echo ""
if [ -n "$TOKEN" ]; then
  URL="https://${IP:-<手机IP>}:$PORT/module/?k=$TOKEN"
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
echo "日志（最后 5 行）："
tail -5 "$DATA/logs/web.log" 2>/dev/null
exit 0
