#!/system/bin/sh
# 目的：把「每个源码文件必须有目的/边界/依赖/失败」变成可执行检查，而不是口头规范。
# 边界：只查注释关键字，不评估注释质量；不检查 .json/.md。
# 依赖：grep、find（POSIX/toybox）。
# 失败：有缺失返回 1，供提交前拦截。
if [ -z "$MODDIR" ]; then
  MODDIR=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
fi
bad=0
# units/legacy/app 是恢复出来的上游原版代码，保留原字节；不复刻本项目的头注释规范。
for f in $(find "$MODDIR/bin" "$MODDIR/units" -type f \( -name '*.sh' -o -name '*.mjs' -o -name '*.js' \) ! -path "$MODDIR/units/legacy/app/*" 2>/dev/null); do
  for k in 目的 边界 依赖 失败; do
    grep -q "$k：" "$f" || { echo "FAIL 缺 $k：$(basename "$f")"; bad=$((bad+1)); }
  done
done
[ "$bad" -eq 0 ] && echo "ok 头注释齐全（目的/边界/依赖/失败）" || echo "共 $bad 处缺失"
exit $([ "$bad" -eq 0 ] && echo 0 || echo 1)
