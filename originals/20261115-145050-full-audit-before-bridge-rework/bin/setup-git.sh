#!/system/bin/sh
# 目的：一次性初始化 bare 仓库、.gitignore、首次提交，并可选绑定云端远端。
# 边界：不创建远端仓库（需要凭据与网络，人工做）。
# 输入：$1 = 远端 URL（可选，如 git@github.com:you/tinda-bot.git）
# 副作用：创建 $DATA/repo.git、修改 app/.gitignore、首次提交

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
. "$MODDIR/bin/lib.sh"
ensure_dirs

GITDIR="$DATA/repo.git"
if [ ! -d "$GITDIR" ]; then
  git init --bare -q "$GITDIR"
  git --git-dir="$GITDIR" config user.name "tinda-bot"
  git --git-dir="$GITDIR" config user.email "bot@localhost"
  log info "bare 仓库已建：$GITDIR"
fi

cat > "$MODDIR/app/.gitignore" <<'IGN'
state/
logs/
secrets/
node_modules/
*.log
IGN

G="git --git-dir=$GITDIR --work-tree=$MODDIR"
$G add -A app docs etc module.prop README.md bin 2>/dev/null
$G commit -m "chore: 初始导入（含 originals 快照）

why: 建立可追溯基线
" >/dev/null 2>&1

if [ -n "$1" ]; then
  $G remote remove origin 2>/dev/null
  $G remote add origin "$1"
  log info "远端已设置：$1"
fi
log info "完成。提交数：$($G rev-list --count HEAD 2>/dev/null || echo 0)"
