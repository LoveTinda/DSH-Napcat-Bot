#!/system/bin/sh
# 目的：提交前的依赖门禁：本仓库只允许 node: 内置模块与相对路径，禁止第三方依赖。
# 边界：只在有 node 时执行；没有 node 时跳过并告警，不阻断提交。
# 依赖：node、bin/check-deps.mjs。
# 失败：发现外部依赖返回 1；没 node 返回 0 并告警。
MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
if command -v node >/dev/null 2>&1; then
  MODDIR="$MODDIR" node "$MODDIR/bin/check-deps.mjs"
else
  echo "warn 无 node，跳过依赖检查"
fi
