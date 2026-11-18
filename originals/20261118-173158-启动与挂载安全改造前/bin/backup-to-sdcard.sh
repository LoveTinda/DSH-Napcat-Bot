#!/system/bin/sh
# 目的：每次发版后，把整个模块目录**完整**拷到 /sdcard/backup/，对抗“本机全没”。
# 边界：只读源目录；不加密、不压缩（要的是可直接打开的原样副本）。
# 依赖：/sdcard 可写；模块目录含 .git 与 originals 快照。
# 失败：/sdcard 不可写 → 退出 78；拷贝后文件数为 0 → 删除半成品并退出 1。
# 保留策略：默认保留最近 20 份完整备份，最新一份永不删除。

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
DEST_ROOT=${DEST_ROOT:-/sdcard/backup}
KEEP=${KEEP:-20}

VER=$(grep '^version=' "$MODDIR/module.prop" 2>/dev/null | cut -d= -f2 | tr -d '\r')
[ -n "$VER" ] || VER=unknown
TS=$(date '+%Y%m%d-%H%M%S')
DEST="$DEST_ROOT/tinda-bot-$VER-$TS"

[ -d "$DEST_ROOT" ] || mkdir -p "$DEST_ROOT" || { echo "FAIL 无法创建 $DEST_ROOT"; exit 78; }
[ -w "$DEST_ROOT" ] || { echo "FAIL $DEST_ROOT 不可写"; exit 78; }

# 先把 git 的散对象收紧：不收紧的话每提交一次就多几十个文件，
# 备份里的「681 个文件」有一大半是 .git/objects 的小碎片。
if [ -d "$MODDIR/.git" ] && command -v git >/dev/null 2>&1; then
  git -C "$MODDIR" gc --quiet --prune=now 2>/dev/null || true
fi

mkdir -p "$DEST"
# 完整拷贝：脚本、文档、契约、originals、.git 全要（.runtime 是临时运行态，排除）
# .runtime 里有 700MB 的 NapCat rootfs 和 secrets，绝不能进备份。
tar cf - -C "$MODDIR" --exclude=./.runtime . 2>/dev/null | tar xf - -C "$DEST" 2>/dev/null || \
  cp -a "$MODDIR"/. "$DEST"/ 2>/dev/null || true
rm -rf "$DEST/.runtime" 2>/dev/null

# 再补一个单文件 bundle：/sdcard 是 FUSE 挂载，直接把 .git 拿回来 clone 会被
# "dubious ownership" 挡住；bundle 没有这个问题，一条 git clone 就能还原历史。
if [ -d "$MODDIR/.git" ] && command -v git >/dev/null 2>&1; then
  git -C "$MODDIR" bundle create "$DEST/repo.bundle" --all 2>/dev/null \
    && echo "   repo.bundle 已生成（恢复：git clone repo.bundle <目录>）"
fi

COUNT=$(find "$DEST" -type f | wc -l | tr -d ' ')
if [ "$COUNT" -eq 0 ]; then rm -rf "$DEST"; echo "FAIL 备份为空，已回滚"; exit 1; fi

( cd "$DEST" && find . -type f ! -name SHA256SUMS -print0 | xargs -0 sha256sum 2>/dev/null | sort > "$DEST_ROOT/.sums.$$" && mv "$DEST_ROOT/.sums.$$" SHA256SUMS )

{
  echo "## $(date '+%Y-%m-%d %H:%M:%S') — $VER"
  echo "- 路径：$DEST"
  echo "- 文件数：$COUNT"
  echo "- 大小：$(du -sh "$DEST" 2>/dev/null | awk '{print $1}')"
  echo "- 校验：$DEST/SHA256SUMS"
  echo
} >> "$DEST_ROOT/INDEX.md"

# 保留策略：只删本工具创建的目录，且永不删最新一份
ls -1dt "$DEST_ROOT"/tinda-bot-* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  case "$old" in
    "$DEST_ROOT"/tinda-bot-*) [ "$old" != "$DEST" ] && rm -rf "$old" ;;
  esac
done

echo "OK $DEST"
echo "   $COUNT 个文件，$(du -sh "$DEST" 2>/dev/null | awk '{print $1}')"
