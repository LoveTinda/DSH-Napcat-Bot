#!/system/bin/sh
# 目的：把「每个源码文件必须有目的/边界/失败」变成可执行检查，而不是口头规范。
# 边界：只查注释关键字，不评估注释质量；不检查 .json/.md。
# 失败：有缺失返回 1，供提交前拦截。
MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
bad=0
for f in $(find "$MODDIR/bin" "$MODDIR/units" "$MODDIR/app/tools" -type f \( -name '*.sh' -o -name '*.mjs' -o -name '*.js' \) 2>/dev/null); do
  grep -q '目的：' "$f" || { echo "FAIL 缺目的：$(basename "$f")"; bad=$((bad+1)); }
  grep -qE '失败：|边界：' "$f" || { echo "FAIL 缺边界/失败：$(basename "$f")"; bad=$((bad+1)); }
done
[ "$bad" -eq 0 ] && echo "ok 头注释齐全" || echo "共 $bad 处缺失"
exit $([ "$bad" -eq 0 ] && echo 0 || echo 1)
