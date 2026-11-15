#!/system/bin/sh
# 目的：兼容入口。桥接器的实现全部在 units/bridge/ 与 bin/unit.sh，这里只做转发。
# 边界：只转发到 unit.sh，不实现任何逻辑。
# 依赖：bin/unit.sh。
# 失败：单元未声明时由 unit.sh 返回 2。
MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
exec sh "$MODDIR/bin/unit.sh" "${1:-status}" bridge "$2"
