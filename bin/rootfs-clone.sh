#!/system/bin/sh
# 目的：把一个目录树克隆成新 rootfs——普通文件用硬链接（省空间、瞬时），符号链接重建（Android 禁止对符号链接建硬链接）。
# 边界：只做目录树复制，不装包、不改内容、不碰源目录；不做增量同步（重跑前自己删干净目标）。
# 输入：<源目录> <目标目录>
# 失败：目标已存在且非空 → 78；单个文件硬链接失败 → 退化为复制并记 warn，不中断。
# 副作用：创建目标目录树；硬链接与源共享 inode（源目标任一被原地改写两边都会变）。

set -u

SRC=${1:?用法: rootfs-clone.sh <源目录> <目标目录>}
DST=${2:?用法: rootfs-clone.sh <源目录> <目标目录>}

[ -d "$SRC" ] || { echo "源目录不存在：$SRC" >&2; exit 78; }
if [ -d "$DST" ] && [ -n "$(ls -A "$DST" 2>/dev/null)" ]; then
  echo "目标已存在且非空：$DST（先删掉再跑）" >&2
  exit 78
fi
mkdir -p "$DST" || exit 78
# 后面要 cd 进源目录，目标必须转成绝对路径，否则会落到源目录里面
DST=$(cd "$DST" && pwd) || exit 78

TMP=$(mktemp -d) || exit 78
trap 'rm -rf "$TMP"' EXIT INT TERM
export DST TMP

cd "$SRC" || exit 78

# 1) 目录
find . -type d -exec sh -c 'for d do mkdir -p "$DST/$d" || exit 78; done' sh {} + || exit 78

# 2) 符号链接（原样重建，不跟随）
find . -type l -exec sh -c '
for l do
  t=$(readlink "$l") || continue
  mkdir -p "$(dirname "$DST/$l")"
  ln -sfn "$t" "$DST/$l" || echo "warn: 符号链接失败 $l" >&2
  echo x >> "$TMP/sym"
done' sh {} +

# 3) 普通文件：硬链接优先，失败就复制
find . -type f -exec sh -c '
for f do
  mkdir -p "$(dirname "$DST/$f")"
  if ln "$f" "$DST/$f" 2>/dev/null; then
    echo x >> "$TMP/link"
  elif cp -p "$f" "$DST/$f" 2>/dev/null; then
    echo x >> "$TMP/copy"
  else
    echo "warn: 复制失败 $f" >&2
  fi
done' sh {} +

cnt() { [ -f "$TMP/$1" ] && wc -l < "$TMP/$1" | tr -d ' ' || echo 0; }
echo "rootfs-clone: 硬链接 $(cnt link)，复制 $(cnt copy)，符号链接 $(cnt sym) → $DST"
exit 0
