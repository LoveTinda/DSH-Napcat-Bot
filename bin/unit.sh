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
  case "$TYPE" in
    exec|chroot|external|auto) ;;
    *) log error "$u: TYPE=$TYPE 不认识（exec|chroot|external|auto）"; exit 78 ;;
  esac
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

# 目的：算出这个单元实际该怎么起——exec（宿主直装）还是 chroot（Magisk 下的 Linux rootfs）。
# 输入：无（读 $TYPE 与 /data/adb 是否存在）；输出：echo "exec" 或 "chroot:<rootfs>"。
# 失败：chroot 但 rootfs 不存在 → 输出 chroot:<路径>，由 spawn 报 78。
# 副作用：无。
resolve_mode() {
  _rf=${TINDA_ROOTFS:-/data/adb/tinda-bot/rootfs}
  case "$TYPE" in
    exec|external) echo "$TYPE" ;;
    chroot) echo "chroot:$_rf" ;;
    auto)
      # 判据是「Android root 环境 + 有 rootfs」：proot 里 /data/adb 不存在，自然退回 exec。
      if [ -d /data/adb ] && [ -d "$_rf/usr" ]; then echo "chroot:$_rf"; else echo "exec"; fi ;;
  esac
}

spawn_exec() { sh -c "$CMD"; }

# 目的：在 Magisk 的 root 环境里把模块代码与状态挂进 Linux rootfs，再 chroot 执行单元命令。
# 输入：$1 = rootfs 路径；用 $CMD 作为 rootfs 内的命令。
# 失败：rootfs 缺 /usr 或缺代码目录 → 78；mount 失败只 warn（可能已挂过/内核不支持，让后续命令自己报错）。
# 副作用：在 rootfs 里建挂载点并 bind mount proc/dev/sys/sdcard/data；退出时由内核随进程结束保留。
spawn_chroot() {
  _rf=$1
  [ -d "$_rf/usr" ] || { log error "$NAME: rootfs 未初始化：$_rf（跑 bin/magisk-provision.sh）"; return 78; }
  command -v chroot >/dev/null 2>&1 || { log error "$NAME: 没有 chroot 命令（Android 太老或缺 busybox）"; return 78; }
  mkdir -p "$_rf/proc" "$_rf/dev" "$_rf/sys" "$_rf/sdcard" "$_rf/data/adb" 2>/dev/null
  mountpoint -q "$_rf/proc" || mount -t proc proc "$_rf/proc" 2>/dev/null || log warn "$NAME: 挂 proc 失败"
  mount -o bind /dev "$_rf/dev" 2>/dev/null || log warn "$NAME: 挂 /dev 失败"
  mount -o bind /sys "$_rf/sys" 2>/dev/null || log warn "$NAME: 挂 /sys 失败"
  [ -d /sdcard ] && { mount -o bind /sdcard "$_rf/sdcard" 2>/dev/null || log warn "$NAME: 挂 /sdcard 失败"; }
  mount -o bind /data/adb "$_rf/data/adb" 2>/dev/null || log warn "$NAME: 挂 /data/adb 失败"
  # 模块代码与状态都在 /data/adb 下，已经随上面的 bind 进 rootfs；这里只确认路径真的可达。
  [ -d "$_rf/data/adb" ] || { log error "$NAME: rootfs 里看不到 /data/adb"; return 78; }
  [ -f "$_rf$MODDIR/bin/unit.sh" ] || { log error "$NAME: 代码没进 rootfs：$MODDIR"; return 78; }
  # 脚本首行是 #!/system/bin/sh（Android 路径），rootfs 里没有它；显式用 /bin/sh 跑。
  chroot "$_rf" /bin/sh -lc "cd '$MODDIR' && exec /bin/sh '$CMD'"
}

spawn() {
  _mode=$(resolve_mode)
  case "$_mode" in
    exec) log info "$NAME: 启动方式 exec（宿主直装）"; spawn_exec ;;
    chroot:*) log info "$NAME: 启动方式 chroot（rootfs=$_mode）"; spawn_chroot "${_mode#chroot:}" ;;
    external) log info "$NAME: 外部单元，由 DSH 自己托管"; return 0 ;;
    *) log error "$NAME: 未知启动方式 $_mode"; return 78 ;;
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
[ -n "$act" ] && [ -n "$name" ] || { echo "用法: $0 start|stop|restart|status|explain|logs <unit> [n]"; exit 2; }
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
  explain)
    # 只解释「会怎么起」，不启动任何东西；用来在刷机前确认 auto 到底选了哪条路。
    echo "$name: TYPE=$TYPE → $(resolve_mode)"
    echo "  CMD=$CMD"
    echo "  DATA=$DATA"
    exit 0 ;;
  logs) tail -n "${3:-40}" "$LOG_FILE" 2>/dev/null || echo "无日志" ;;
  *) echo "未知动作：$act"; exit 2 ;;
esac
