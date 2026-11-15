#!/system/bin/sh
# 目的：在任何修改之前，把「当前项目」按原字节备份到 originals/，并登记哈希。
# 边界：只读源目录，不改源文件；不清理旧快照（由人工删）；不备份 .runtime 里的 secrets。
# 依赖：tar、find、sha256sum（toybox/coreutils）。
# 失败：目录创建失败 → 78；快照文件数为 0 → 删除半成品并返回 1。
# 副作用：写 originals/<时间戳>-<原因>/、SHA256SUMS 与 originals/INDEX.md。
if [ -z "$MODDIR" ]; then
  MODDIR=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
fi
. "$MODDIR/bin/lib.sh"
ensure_dirs

reason=$1
[ -n "$reason" ] || reason=manual
stamp=$(date '+%Y%m%d-%H%M%S')
dest="$MODDIR/originals/$stamp-$reason"
mkdir -p "$dest" || { echo "FAIL 无法创建 $dest"; exit 78; }

# 全项目快照：以前只备份 app/docs/etc，漏掉 bin/ 与 units/，等于最该备份的代码没备份。
# .runtime 是运行态（含 0600 secrets），originals 自身排除避免递归。
tar cf - -C "$MODDIR" --exclude=./.runtime --exclude=./.git --exclude=./originals . 2>/dev/null \
  | tar xf - -C "$dest" 2>/dev/null || { echo "FAIL tar 失败"; rm -rf "$dest"; exit 1; }

count=$(find "$dest" -type f | wc -l | tr -d ' ')
if [ "$count" -eq 0 ]; then rm -rf "$dest"; echo "FAIL 快照为空，已回滚"; exit 1; fi
( cd "$dest" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + 2>/dev/null | sort > SHA256SUMS )

{
  echo "## $stamp — $reason"
  echo "- 文件数：$count"
  echo "- 目录：originals/$stamp-$reason"
  echo "- 清单：SHA256SUMS"
  echo
} >> "$MODDIR/originals/INDEX.md"

log info "快照完成：$dest（$count 个文件）"
