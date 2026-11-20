#!/system/bin/sh
# 目的：把 $DATA/logs 下的日志脱敏后复制到 /sdcard/Bridge/Logs/，方便没有 root 时查看/外发。
# 边界：只复制 .log，不复制 secrets/state；输出只写共享存储，不改原日志。
# 依赖：bin/lib.sh（redact）、/sdcard 可写。
# 失败：/sdcard 不可写或没有日志 → 返回 0 并打印原因（导出是辅助手段，不该让主流程失败）。
# 副作用：写 /sdcard/Bridge/Logs/export/*.log。
MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
. "$MODDIR/bin/lib.sh"

OUT="${MIRROR_DIR:-/sdcard/Bridge/Logs}/export"
mkdir -p "$OUT" 2>/dev/null || { echo "导出失败：写不了 $OUT"; exit 0; }
n=0
for f in "$DATA"/logs/*.log; do
  [ -f "$f" ] || continue
  redact < "$f" > "$OUT/$(basename "$f")" 2>/dev/null && n=$((n + 1))
done
echo "已导出 $n 个日志到 $OUT"
exit 0
