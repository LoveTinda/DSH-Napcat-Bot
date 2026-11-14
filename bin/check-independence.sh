#!/system/bin/sh
# 目的：把“独立”变成可执行检查，防止单元互相伸手。
# 检查：unit.conf 必需字段、是否存在跨单元路径引用、单元目录内是否有跨单元 import。
MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
UNITS=${UNITS:-$MODDIR/units}
bad=0

for d in "$UNITS"/*/; do
  u=$(basename "$d"); f="$d/unit.conf"
  [ -f "$f" ] || { echo "FAIL $u: 缺 unit.conf"; bad=$((bad+1)); continue; }
  for k in NAME TYPE PID_FILE LOG_FILE STATE_DIR CONTRACT; do
    grep -q "^$k=" "$f" || { echo "FAIL $u: 缺 $k"; bad=$((bad+1)); }
  done
  # 跨单元引用：本单元的 conf 里出现别的单元状态/日志路径
  for other in "$UNITS"/*/; do
    o=$(basename "$other")
    [ "$o" = "$u" ] && continue
    if grep -qE "state/$o|logs/$o\.|run/$o\.pid" "$f" 2>/dev/null; then
      echo "FAIL $u: 引用了 $o 的私有路径"; bad=$((bad+1))
    fi
  done
  # 单元目录内不得 import 别的单元
  for src in $(find "$d" -name '*.js' -o -name '*.sh' 2>/dev/null); do
    for other in "$UNITS"/*/; do
      o=$(basename "$other"); [ "$o" = "$u" ] && continue
      grep -qE "(\.\./)+$o/|$UNITS/$o" "$src" 2>/dev/null && {
        echo "FAIL $(basename "$src"): 跨单元引用 $o"; bad=$((bad+1)); }
    done
  done
done

[ "$bad" -eq 0 ] && echo "ok 所有单元独立" || echo "共 $bad 处违规"
exit $([ "$bad" -eq 0 ] && echo 0 || echo 1)
