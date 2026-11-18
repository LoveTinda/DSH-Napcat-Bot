#!/system/bin/sh
# 目的：兼容旧入口名 run-bridge.sh；单应用统一转到 run-app.sh。
# 边界：只做 exec 转发，不读配置、不解释参数。
# 依赖：bin/run-app.sh、node、app/src/index.js。
# 失败：run-app.sh 的退出码原样返回（缺 node/入口为 78）。
# 副作用：无（交给 run-app.sh）。
MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
exec sh "$MODDIR/bin/run-app.sh" "$@"
