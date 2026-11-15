#!/system/bin/sh
# 目的：把工作树改动自动提交进 bare 仓库，让每一次修改都有迹可循。
# 边界：不解决冲突；不做 rebase；推送失败只记日志（离线不阻断）。
# 输入：--once "<message>"  或  （无参）常驻监听模式
# 副作用：git 提交、可能的 push、$DATA/logs/git.log

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
. "$MODDIR/bin/lib.sh"
ensure_dirs

GITDIR="$DATA/repo.git"
[ -d "$GITDIR" ] || { log error "仓库不存在，先跑 bin/setup-git.sh"; exit 78; }
G="git --git-dir=$GITDIR --work-tree=$MODDIR"

msg_of() {
  turn=$(cat "$DATA/state/turn" 2>/dev/null || echo "-")
  sess=$(cat "$DATA/state/session-id" 2>/dev/null || echo "-")
  echo "${1:-chore: 自动提交}

why: 工作树检测到改动，自动留痕
turn: $turn
session: $sess"
}

do_once() {
  dirty=$($G status --porcelain 2>/dev/null)
  [ -z "$dirty" ] && { log info "无改动，跳过"; return 0; }
  msg_of "$1" | $G commit -F - -a >/dev/null 2>&1
  log info "已提交：$(echo "$dirty" | wc -l | tr -d ' ') 个文件"
  if $G remote | grep -q origin; then
    $G push -q origin HEAD >/dev/null 2>&1 || {
      log warn "推送失败，生成 bundle"
      mkdir -p "$DATA/pending"
      $G bundle create "$DATA/pending/$(date +%s).bundle" --all >/dev/null 2>&1
    }
  fi
}

case "${1:-}" in
  --once) do_once "$2" ;;
  "")
    log info "监听模式启动"
    last=""
    while :; do
      cur=$($G status --porcelain 2>/dev/null)
      if [ -n "$cur" ] && [ "$cur" != "$last" ]; then
        sleep 5
        do_once "chore: 自动提交"
        last=$($G status --porcelain 2>/dev/null)
      fi
      sleep 5
    done ;;
  *) echo "用法: $0 [--once \"message\"]"; exit 2 ;;
esac
