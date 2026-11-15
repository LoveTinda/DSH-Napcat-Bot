#!/system/bin/sh
# 目的：开机后按单元逐个拉起。顺序不影响正确性（单元之间只通过契约与重连交互）。
# 边界：只调用 bin/unit.sh，不直接认识任何具体单元的业务。
# 失败：某个单元起不来不影响其它单元。

MODDIR=${0%/*}
DATA=/data/adb/tinda-bot

until [ "$(getprop sys.boot_completed)" = "1" ]; do sleep 2; done
sleep 20
mkdir -p "$DATA/logs"

# 顺序：NapCat（OneBot 服务端）→ 桥接器（找它要 3001）→ 网关（找桥接器要面板口）。
# dsh 是外部单元，start 只做提示，不拉起别人的进程。
for u in napcat dsh bridge web; do
  MODDIR="$MODDIR" sh "$MODDIR/bin/unit.sh" start "$u"
done
