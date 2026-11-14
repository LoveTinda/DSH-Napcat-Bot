#!/system/bin/sh
# 目的：兼容入口。桥接器的实现全部在 units/bridge/ 与 bin/unit.sh，这里只做转发。
MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
exec sh "$MODDIR/bin/unit.sh" "${1:-status}" bridge "$2"
