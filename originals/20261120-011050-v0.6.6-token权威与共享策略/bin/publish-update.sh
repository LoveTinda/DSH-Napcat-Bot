#!/system/bin/sh
# 目的：把当前版本发布成模块管理器能自动更新的形态：重建 zip、同步 update.json、
#       把 zip 强推到 dist 分支（孤儿分支，只放一个文件，不涨历史）。
# 边界：不改版本号（以 module.prop 为准）、不刷机、不建 GitHub Release、不替人提交 main。
# 依赖：git、python3、ssh 推送权限、bin/make-module.sh。
# 失败：缺 module.prop / 打包失败 / 推送失败 → 非 0，并说明哪一步。
# 副作用：重写 update.json；在 /tmp 建临时仓库；强推 origin/dist。
MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$MODDIR" || exit 1

VER=$(sed -n 's/^version=//p' module.prop | head -1)
CODE=$(sed -n 's/^versionCode=//p' module.prop | head -1)
[ -n "$VER" ] && [ -n "$CODE" ] || { echo "FAIL module.prop 缺 version/versionCode"; exit 1; }
SLUG=$(git remote get-url origin | sed -E 's#.*[:/]([^/]+)/([^/]+)$#\1/\2#' | sed 's/\.git$//')
[ -n "$SLUG" ] || { echo "FAIL 解析不出 GitHub 仓库名"; exit 1; }
RAW="https://raw.githubusercontent.com/$SLUG"

sh bin/make-module.sh || { echo "FAIL 打包失败"; exit 1; }
ZIP="/sdcard/Download/DSH-Go/tinda-bot-$VER-magisk.zip"
[ -f "$ZIP" ] || { echo "FAIL 找不到 $ZIP"; exit 1; }

printf '{\n  "version": "%s",\n  "versionCode": %s,\n  "zipUrl": "%s/dist/tinda-bot-magisk.zip",\n  "changelog": "%s/main/CHANGELOG.md"\n}\n' \
  "$VER" "$CODE" "$RAW" "$RAW" > update.json
echo "update.json → $VER ($CODE)"

TMP=$(mktemp -d) || exit 1
cp "$ZIP" "$TMP/tinda-bot-magisk.zip" || { echo "FAIL 复制 zip"; exit 1; }
( cd "$TMP" && git init -q && git checkout -q -b dist && git add -A && \
  git -c user.name=tinda -c user.email=tinda@localhost commit -q -m "dist: $VER" && \
  git remote add origin "$(cd "$MODDIR" && git remote get-url origin)" && \
  GIT_SSH_COMMAND="ssh -4" git push -f origin dist ) || { echo "FAIL 推送 dist"; exit 1; }
rm -rf "$TMP"
echo "dist 已更新：$RAW/dist/tinda-bot-magisk.zip"
echo "别忘了把 update.json / module.prop / CHANGELOG.md 提交到 main"
