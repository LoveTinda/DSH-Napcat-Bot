#!/system/bin/sh
# 目的：兼容旧入口名 run-bridge.sh；统一转到 proot 启动器。
# 边界：只做 exec 转发，不读配置、不解释参数。
# 依赖：bin/run-app-proot.sh、proot、DSH rootfs、app/src/index.js。
# 失败：run-app-proot.sh 的退出码原样返回（缺 proot/rootfs 为 78，不回落宿主）。
# 副作用：无（交给 run-app-proot.sh）。
MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
exec sh "$MODDIR/bin/run-app-proot.sh" "$@"
