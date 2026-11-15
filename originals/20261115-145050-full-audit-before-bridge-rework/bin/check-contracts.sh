#!/system/bin/sh
# 目的：提交前的契约一致性门禁（Q-2 + 接口适配规则）。
# 边界：只在有 node 时执行；没有 node 时跳过并告警，不阻断提交。
MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
if command -v node >/dev/null 2>&1; then
  node "$MODDIR/app/tools/check-contracts.mjs"
else
  echo "warn 无 node，跳过契约检查"
fi
