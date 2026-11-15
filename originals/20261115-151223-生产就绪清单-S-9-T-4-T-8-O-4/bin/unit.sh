#!/system/bin/sh
# 目的：**唯一**的单元管理入口。每个单元由 units/<name>/unit.conf 声明，行为完全一致。
# 边界：不实现业务；不认识任何具体单元的名字；不跨单元读写。
# 依赖：units/*/unit.conf、bin/lib.sh、POSIX sh 与进程信号。
# 输入：start|stop|restart|status|logs <unit> [行数]
# 失败：单元未声明/入口缺失 → 78；外部单元不可 start → 明确拒绝。
# 副作用：写本单元的 PID/日志/状态目录（绝不碰别人的）。

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
UNITS=${UNITS:-$MODDIR/units}
. "$MODDIR/bin/lib.sh"
ensure_dirs

load() {
  u="$1"
  [ -f "$UNITS/$u/unit.conf" ] || { log error "未声明的单元：$u"; exit 2; }
  # shellcheck disable=SC1090
  . "$UNITS/$u/unit.conf"
  RESTART_MAX=${RESTART_MAX:-10}
  BACKOFF_MAX=${BACKOFF_MAX:-60}
  mkdir -p "$STATE_DIR"
}

running() {
  [ -f "$PID_FILE" ] || return 1
  _rp=$(cat "$PID_FILE" 2>/dev/null)
  [ -n "$_rp" ] && kill -0 "$_rp" 2>/dev/null || return 1
  case "$(pid_cmd "$_rp")" in
    *unit.sh*|*units/$NAME/*|*run-$NAME.sh*) return 0 ;;
  esac
  return 1
}

# 目的：读进程命令行，用来避免 PID 复用后误杀无关进程。
pid_cmd() {
  [ -n "$1" ] && [ -r "/proc/$1/cmdline" ] || return 0
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null
}

# 目的：递归收集某个进程的全部子孙 pid（supervisor → 子 shell → node → dsh）。
collect_tree() {
  local _p _c
  _p=$1
  for _c in $(cat "/proc/$_p/task/$_p/children" 2>/dev/null); do
    echo "$_c"
    collect_tree "$_c"
  done
}

# 目的：不依赖 PID 文件，按命令行找出本单元的所有进程（看守、node、run-*.sh）。
# 输入：全局 $NAME；输出：每行一个 pid；排除当前 unit.sh 自身。
find_unit_pids() {
  for _d in /proc/[0-9]*; do
    _pid=${_d#/proc/}
    [ "$_pid" = "$$" ] && continue
    [ "$_pid" = "$PPID" ] && continue
    _cmd=$(pid_cmd "$_pid")
    [ -n "$_cmd" ] || continue
    # 管道里执行 unit.sh 时 $$ 可能指向外层 shell，实际 unit.sh 是它的直接子进程；跳过。
    _ppid=$(awk '{print $4}' "/proc/$_pid/stat" 2>/dev/null)
    if [ "$_ppid" = "$$" ]; then
      case "$_cmd" in *unit.sh*) continue ;; esac
    fi
    # 跳过「cd … && sh unit.sh start …; …」这类包装命令行，否则会把调用者的 shell 当成单元进程。
    case "$_cmd" in *';'*|*'&&'*|*'||'*|*'cd '*) continue ;; esac
    case "$_cmd" in
      *"unit.sh start $NAME"*|*"unit.sh restart $NAME"*) echo "$_pid" ;;
      *"units/$NAME/"*|*"bin/run-$NAME.sh"*) echo "$_pid" ;;
    esac
  done
}

spawn() {
  case "$TYPE" in
    chroot)
      _rf=$(conf_get "$ROOTFS_KEY" "")
      [ -d "$_rf/usr" ] || { log error "$NAME: 容器未初始化"; return 78; }
      mkdir -p "$_rf/proc" "$_rf/dev" "$_rf/sys" "$_rf/sdcard"
      mountpoint -q "$_rf/proc" || mount -t proc proc "$_rf/proc" 2>/dev/null
      mount -o bind /dev "$_rf/dev" 2>/dev/null
      mount -o bind /sys "$_rf/sys" 2>/dev/null
      mount -o bind /sdcard "$_rf/sdcard" 2>/dev/null
      chroot "$_rf" /bin/bash -lc "exec $ENTRY" ;;
    exec) sh -c "$CMD" ;;
    external) log info "$NAME: 外部单元，由 DSH 自己托管"; return 0 ;;
    *) log error "$NAME: 未知 TYPE=$TYPE"; return 78 ;;
  esac
}

do_start() {
  [ "$TYPE" = "external" ] && { spawn; return 0; }
  if running; then log info "$NAME 已在运行 pid=$(cat "$PID_FILE")"; return 0; fi
  # PID 文件可能丢/写错；按命令行再查一次，避免旧实例占着端口时又起一个新的。
  _stray=$(find_unit_pids)
  if [ -n "$_stray" ]; then
    log warn "$NAME 有未登记的进程：$(printf '%s' "$_stray" | tr '\n' ' ')，先 unit.sh stop $NAME"
    return 1
  fi
  # 上次 stop 留下的标记会让新一轮循环立刻退出；启动前清掉。
  rm -f "$PID_FILE.stop"
  # 长跑进程不会自己轮转日志；每次启动前检查一次，避免日志无限增长。
  rotate_log_file "$LOG_FILE"
  log info "$NAME 启动"
  (
    fails=0
    while :; do
      [ -f "$PID_FILE.stop" ] && break
      spawn >> "$LOG_FILE" 2>&1 &
      echo $! > "$PID_FILE.child"
      wait $!
      rc=$?
      [ -f "$PID_FILE.stop" ] && break
      fails=$((fails+1))
      [ "$fails" -ge "$RESTART_MAX" ] && { log fatal "$NAME 连续失败 $fails 次，停止重试"; break; }
      log warn "$NAME 退出 rc=$rc（第 $fails 次），退避重启"
      sleep $(( fails < 5 ? fails * 3 : BACKOFF_MAX ))
    done
    rm -f "$PID_FILE"
  ) >/dev/null 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  running && log info "$NAME 已启动 pid=$(cat "$PID_FILE")" || log warn "$NAME 未确认运行，见 $LOG_FILE"
}

do_stop() {
  _sup=$(cat "$PID_FILE" 2>/dev/null)
  _child=$(cat "$PID_FILE.child" 2>/dev/null)
  touch "$PID_FILE.stop"

  # 只认自己的进程：supervisor 的命令行必须含 unit.sh；node 必须在本项目路径下。
  case "$(pid_cmd "$_sup")" in *unit.sh*) ;; *) _sup="" ;; esac
  case "$(pid_cmd "$_child")" in *tinda-bot*|*tinda*) ;; *) _child="" ;; esac

  # PID 文件可能丢/写错；按命令行补全本单元的所有进程，否则旧 node 会一直占端口。
  _found=$(find_unit_pids)
  _all="$_sup $_child $_found"

  # 先收集整棵子树再杀：只杀直接子进程会留下 node 及其 dsh 孙进程，端口一直被占。
  for _p in $_all; do
    [ -n "$_p" ] || continue
    _all="$_all $(collect_tree "$_p")"
  done
  for _p in $_all; do kill "$_p" 2>/dev/null; done

  _i=0
  while [ "$_i" -lt 5 ]; do
    _alive=0
    for _p in "$_sup" "$_child"; do [ -n "$_p" ] && kill -0 "$_p" 2>/dev/null && _alive=1; done
    [ "$_alive" -eq 0 ] && break
    sleep 1; _i=$((_i + 1))
  done
  for _p in $_all; do kill -9 "$_p" 2>/dev/null; done
  rm -f "$PID_FILE.stop" "$PID_FILE" "$PID_FILE.child"
  log info "$NAME 已停止（含子进程树）"
}

act="$1"; name="$2"
[ -n "$act" ] && [ -n "$name" ] || { echo "用法: $0 start|stop|restart|status|logs <unit> [n]"; exit 2; }
load "$name"
case "$act" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status)
    if running; then echo "$name: running pid=$(cat "$PID_FILE")"; exit 0; fi
    # 外部单元没有我们的 PID，只能探活；能连上就算在跑。
    # 本机没有 curl/wget，用 node 探（模块自带 node 优先）。
    if [ "$TYPE" = "external" ] && [ -n "${PROBE_URL:-}" ]; then
      _n="$MODDIR/bin/node"; [ -x "$_n" ] || _n=$(command -v node)
      if [ -n "$_n" ] && "$_n" -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))' "$PROBE_URL" 2>/dev/null; then
        echo "$name: running (external, $PROBE_URL 可连)"; exit 0
      fi
      echo "$name: stopped (external, $PROBE_URL 连不上)"; exit 0
    fi
    echo "$name: stopped" ;;
  logs) tail -n "${3:-40}" "$LOG_FILE" 2>/dev/null || echo "无日志" ;;
  *) echo "未知动作：$act"; exit 2 ;;
esac
