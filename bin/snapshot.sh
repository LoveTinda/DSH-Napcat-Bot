#!/system/bin/sh
# 目的：在任何修改之前，把「原文件」按原字节备份到 originals/，并登记哈希。
# 边界：只读源目录，不改源文件；不清理旧快照（由人工删）。
# 输入：$1 = 原因（写进目录名与 INDEX）
# 副作用：写 originals/<时间戳>-<原因>/ 与 originals/INDEX.md

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
. "$MODDIR/bin/lib.sh"
ensure_dirs

reason=${1:-manual}
stamp=$(date '+%Y%m%d-%H%M%S')
dest="$MODDIR/originals/$stamp-$reason"
mkdir -p "$dest"

for d in app docs etc; do
  [ -d "$MODDIR/$d" ] && cp -a "$MODDIR/$d" "$dest/" 2>/dev/null
done

count=$(find "$dest" -type f | wc -l | tr -d ' ')
sums=$(cd "$dest" && find . -type f -exec sha256sum {} + 2>/dev/null | sort)
echo "$sums" > "$dest/SHA256SUMS"

{
  echo "## $stamp — $reason"
  echo "- 文件数：$count"
  echo "- 目录：originals/$stamp-$reason"
  echo "- 清单：SHA256SUMS"
  echo
} >> "$MODDIR/originals/INDEX.md"

log info "快照完成：$dest（$count 个文件）"
