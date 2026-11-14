#!/system/bin/sh
# 目的：每次发版后，把整个模块目录**完整**拷到 /sdcard/backup/，对抗“本机全没”。
# 边界：只读源目录；不加密、不压缩（要的是可直接打开的原样副本）。
# 依赖：/sdcard 可写；模块目录含 .git 与 originals 快照。
# 失败：/sdcard 不可写 → 退出 78；拷贝后文件数为 0 → 删除半成品并退出 1。
# 保留策略：默认保留最近 20 份完整备份，最新一份永不删除。

MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
DEST_ROOT=${DEST_ROOT:-/sdcard/backup}
KEEP=${KEEP:-20}

VER=$(grep '^version=' "$MODDIR/module.prop" 2>/dev/null | cut -d= -f2 | tr -d '\r')
[ -n "$VER" ] || VER=unknown
TS=$(date '+%Y%m%d-%H%M%S')
DEST="$DEST_ROOT/tinda-bot-$VER-$TS"

[ -d "$DEST_ROOT" ] || mkdir -p "$DEST_ROOT" || { echo "FAIL 无法创建 $DEST_ROOT"; exit 78; }
[ -w "$DEST_ROOT" ] || { echo "FAIL $DEST_ROOT 不可写"; exit 78; }

mkdir -p "$DEST"
# 完整拷贝：脚本、文档、契约、originals、.git 全要（.runtime 是临时运行态，排除）
tar cf - -C "$MODDIR" --exclude=./.runtime . 2>/dev/null | tar xf - -C "$DEST" 2>/dev/null || \
  cp -a "$MODDIR"/. "$DEST"/ 2>/dev/null || true
rm -rf "$DEST/.runtime" 2>/dev/null

COUNT=$(find "$DEST" -type f | wc -l | tr -d ' ')
if [ "$COUNT" -eq 0 ]; then rm -rf "$DEST"; echo "FAIL 备份为空，已回滚"; exit 1; fi

( cd "$DEST" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + 2>/dev/null | sort > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS )

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
