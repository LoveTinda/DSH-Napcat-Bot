#!/system/bin/sh
# 目的：把三道门禁装成 .git/hooks/pre-commit，避免「规范写了但没人跑」。
# 边界：只写 .git/hooks/pre-commit；不覆盖已有的非本工具钩子（检测到标记才覆盖）。
# 依赖：git、node（可选）、bin/check-*.sh。
# 失败：不在 git 仓库 → 78；写文件失败 → 78。
# 副作用：写 .git/hooks/pre-commit 并 chmod +x。
if [ -z "$MODDIR" ]; then
  MODDIR=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
fi
[ -d "$MODDIR/.git" ] || { echo "FAIL 不是 git 仓库：$MODDIR"; exit 78; }
hook="$MODDIR/.git/hooks/pre-commit"
if [ -f "$hook" ] && ! grep -q 'tinda-bot managed hook' "$hook"; then
  echo "FAIL 已存在非本工具的 pre-commit，未覆盖：$hook"
  exit 78
fi
mkdir -p "$MODDIR/.git/hooks" || exit 78
cat > "$hook" <<'HOOK'
#!/bin/sh
# tinda-bot managed hook —— 由 bin/install-hooks.sh 生成
set -e
ROOT=$(git rev-parse --show-toplevel)
MODDIR="$ROOT" sh "$ROOT/bin/check-headers.sh"
MODDIR="$ROOT" sh "$ROOT/bin/check-independence.sh"
MODDIR="$ROOT" sh "$ROOT/bin/check-contracts.sh" || echo "warn 契约检查未通过（0.x 允许告警，见输出）"
if command -v node >/dev/null 2>&1; then
  for f in $(find "$ROOT/units" "$ROOT/bin" -type f \( -name '*.mjs' -o -name '*.js' \) 2>/dev/null); do
    node --check "$f" >/dev/null || { echo "FAIL 语法：$f"; exit 1; }
  done
fi
HOOK
chmod +x "$hook" || exit 78
echo "OK 已安装 $hook"
