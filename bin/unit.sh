#!/system/bin/sh
# 目的：**唯一**的单元管理入口。每个单元由 units/<name>/unit.conf 声明，行为完全一致。
# 边界：不实现业务；不认识任何具体单元的名字；不跨单元读写。
# 依赖：units/*/unit.conf、bin/lib.sh、bin/make-private.sh、POSIX sh 与进程信号。
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
    exec|proot|chroot|external|auto) ;;
    *) log error "$u: TYPE=$TYPE 不认识（exec|proot|chroot|external|auto）"; exit 78 ;;
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
# 输入：无（读 $TYPE、/data/adb、rootfs、unshare 是否存在）；输出："exec"、"proot" 或 "chroot:<rootfs>"。
# 失败：显式 chroot 但 rootfs 不存在 → 仍输出 chroot:<路径>，由 spawn 报 78（失败关闭）。
# 副作用：无。
# 目的：判断当前 Android 环境有没有 unshare；没有就不进 chroot，避免挂载泄漏。
has_unshare() { command -v unshare >/dev/null 2>&1; }

# 目的：在真正挂载前做一次最小探针：unshare 可用、namespace 真的换了、传播能设为不回传宿主。
# 失败：返回非 0，调用方退回 exec；不创建任何业务挂载。
chroot_usable() {
  has_unshare || return 1
  command -v chroot >/dev/null 2>&1 || return 1
  [ -f "$MODDIR/bin/make-private.sh" ] || return 1
  _sh=/system/bin/sh
  [ -x "$_sh" ] || _sh=sh
  _pns=$(readlink /proc/self/ns/mnt 2>/dev/null) || return 1
  [ -n "$_pns" ] || return 1
  MODDIR="$MODDIR" PROBE_NS="$_pns" "$(command -v unshare)" -m "$_sh" -c '
    now=$(readlink /proc/self/ns/mnt 2>/dev/null) || exit 1
    [ -n "$now" ] && [ "$now" != "$PROBE_NS" ] || exit 1
    [ -f "$MODDIR/bin/make-private.sh" ] || exit 1
    "$MODDIR/bin/make-private.sh" >/dev/null 2>&1
  '
}

resolve_mode() {
  _rf=${TINDA_ROOTFS:-/data/adb/tinda-bot/rootfs}
  case "$TYPE" in
    exec|proot|external) echo "$TYPE" ;;
    chroot) echo "chroot:$_rf" ;;
    auto)
      # 判据是「Android root + 有 rootfs + unshare/namespace/传播探针通过」；proot 里 /data/adb 不存在，自然退回 exec。
      if [ -d /data/adb ] && [ -d "$_rf/usr" ] && chroot_usable; then echo "chroot:$_rf"; else echo "exec"; fi ;;
  esac
}

spawn_exec() { sh -c "$CMD"; }

# 目的：在 Magisk 的 root 环境里把模块代码与状态挂进 Linux rootfs，再 chroot 执行单元命令。
# 输入：$1 = rootfs 路径；用 $CMD 作为 rootfs 内的命令。
# 失败：rootfs 缺 /usr、缺 unshare/chroot、mount 失败 → 78（失败关闭，不在宿主留下挂载）。
# 副作用：在**私有 mount namespace** 里 bind proc/dev/sys/模块代码/状态目录；namespace 退出即销毁。
#       不 bind /data/adb，不挂 /sdcard；不再出现 /data/adb → 自己子目录的递归挂载。
spawn_chroot() {
  _rf=$1
  [ -d "$_rf/usr" ] || { log error "$NAME: rootfs 未初始化：$_rf（跑 bin/magisk-provision.sh）"; return 78; }
  command -v chroot >/dev/null 2>&1 || { log error "$NAME: 没有 chroot 命令（Android 太老或缺 busybox）"; return 78; }
  has_unshare || { log error "$NAME: 没有 unshare，拒绝 chroot（否则挂载会泄漏到宿主）"; return 78; }
  # 旧版把 /data/adb bind 进 rootfs 的 /data/adb；如果这次还没重启，目标仍是挂载点，拒绝再叠。
  if mountpoint -q "$_rf/data/adb" 2>/dev/null; then
    log error "$NAME: 检测到旧版 /data/adb 挂载，请重启后再启动（拒绝递归挂载）"
    return 78
  fi
  [ -f "$MODDIR/bin/unit.sh" ] || { log error "$NAME: 宿主代码目录缺失：$MODDIR"; return 78; }
  _unshare=$(command -v unshare)
  _sh=/system/bin/sh
  [ -x "$_sh" ] || _sh=sh
  _pns=$(readlink /proc/self/ns/mnt 2>/dev/null) || { log error "$NAME: 读不到 mount namespace，拒绝 chroot"; return 78; }
  [ -n "$_pns" ] || { log error "$NAME: 读不到 mount namespace，拒绝 chroot"; return 78; }
  MODDIR="$MODDIR" DATA="$DATA" TINDA_RF="$_rf" TINDA_MODDIR="$MODDIR" TINDA_DATA="$DATA" TINDA_CMD="$CMD" TINDA_NAME="$NAME" TINDA_NS="$_pns" \
    "$_unshare" -m "$_sh" -c '
      set -eu
      rf=$TINDA_RF
      mod=$TINDA_MODDIR
      data=$TINDA_DATA
      cmd=$TINDA_CMD
      name=$TINDA_NAME

      # 先证明真的换了 namespace，再改传播/挂载；证明不了就失败关闭。
      now=$(readlink /proc/self/ns/mnt 2>/dev/null) || {
        echo "[$name] 读不到子进程 mount namespace，拒绝 chroot" >&2; exit 78; }
      [ -n "$now" ] && [ "$now" != "$TINDA_NS" ] || {
        echo "[$name] 仍在宿主 mount namespace，拒绝 chroot" >&2; exit 78; }

      # 不要求 toybox 支持 --make-rprivate：helper 会试多种写法，
      # 但必须确认全树没有 shared 传播才返回 0。
      [ -f "$mod/bin/make-private.sh" ] || {
        echo "[$name] 缺 bin/make-private.sh，拒绝 chroot" >&2; exit 78; }
      "$mod/bin/make-private.sh" || {
        echo "[$name] 无法建立不回传宿主的传播，拒绝 chroot" >&2; exit 78; }

      # 只清私有 namespace 里从父进程继承的同名挂载；不影响宿主。
      for m in "$rf/proc" "$rf/dev" "$rf/sys" "$rf/opt/tinda-bot" "$rf/var/tinda"; do
        if mountpoint -q "$m" 2>/dev/null; then umount "$m" 2>/dev/null || true; fi
      done

      mkdir -p "$rf/proc" "$rf/dev" "$rf/sys" "$rf/opt/tinda-bot" "$rf/var/tinda" \
        "$rf/data/adb/modules" "$rf/data/adb/modules_update" 2>/dev/null

      bind_mount() {
        src=$1; dst=$2; opts=$3
        mount -o bind "$src" "$dst" || return 1
        if [ -n "$opts" ]; then
          # 不同 toybox/内核接受两种 remount 语法；都失败就失败关闭。
          mount -o remount,"$opts" "$dst" 2>/dev/null || \
            mount -o remount,bind,"$opts" "$dst" 2>/dev/null || return 1
        fi
        return 0
      }

      mount -t proc -o nosuid,nodev,noexec proc "$rf/proc" || {
        echo "[$name] 挂 /proc 失败" >&2; exit 78; }
      bind_mount /dev "$rf/dev" "nosuid,noexec" || {
        echo "[$name] 挂 /dev 失败" >&2; exit 78; }
      # /sys 不是必需品：有些内核不允许对 sysfs 的 bind 再做 ro remount，
      # 硬失败会让整个单元 78（真机日志里就是「挂 /sys（只读）失败」）。
      # 失败就撤掉半成品挂载、跳过 /sys，让业务继续。
      if ! bind_mount /sys "$rf/sys" "ro,nosuid,nodev,noexec"; then
        umount "$rf/sys" 2>/dev/null || true
        echo "[$name] 警告：/sys 只读挂载失败，已跳过（业务不依赖 /sys）" >&2
      fi
      # 不挂 /sdcard：桥接/web 不需要；少一个可写外部面。
      # 模块代码要能读；ro 只是加分项。有些内核拒绝给 bind 再 remount ro（真机日志
      # 「挂模块代码失败」就是这个），依次退让：ro → 非 ro 的加固 → 普通 bind，最后才 78。
      if bind_mount "$mod" "$rf/opt/tinda-bot" "ro,nosuid,nodev,noexec"; then
        :
      elif bind_mount "$mod" "$rf/opt/tinda-bot" "nosuid,nodev,noexec"; then
        echo "[$name] 警告：模块代码没挂成只读（内核拒绝 ro remount），已用 nosuid,nodev,noexec" >&2
      elif mount -o bind "$mod" "$rf/opt/tinda-bot" 2>/dev/null; then
        echo "[$name] 警告：模块代码只能普通 bind（内核拒绝 remount），已记录" >&2
      else
        echo "[$name] 挂模块代码失败（bind 本身就不成功）" >&2; exit 78
      fi

      # 状态只挂目录，不挂 /data/adb 祖先；这样不会出现 /data/adb → 自己子目录的递归。
      for d in etc state logs run secrets; do
        mkdir -p "$data/$d" "$rf/var/tinda/$d" 2>/dev/null
        bind_mount "$data/$d" "$rf/var/tinda/$d" "nosuid,nodev,noexec" || {
          echo "[$name] 挂状态目录 $d 失败" >&2; exit 78; }
      done

      # 让 CMD/MODDIR/DATA 这些宿主路径在 chroot 里也能解析：用符号链接，不再 bind /data/adb。
      for p in "$rf/data/adb/modules/tinda-bot" "$rf/data/adb/modules_update/tinda-bot"; do
        if [ -e "$p" ] && [ ! -L "$p" ]; then
          echo "[$name] $p 已存在且不是符号链接，拒绝覆盖" >&2; exit 78
        fi
        ln -sfn /opt/tinda-bot "$p" || { echo "[$name] 建模块符号链接失败" >&2; exit 78; }
      done
      if [ -e "$rf/data/adb/tinda-bot" ] && [ ! -L "$rf/data/adb/tinda-bot" ]; then
        echo "[$name] $rf/data/adb/tinda-bot 已存在且不是符号链接，拒绝覆盖" >&2; exit 78
      fi
      ln -sfn /var/tinda "$rf/data/adb/tinda-bot" || {
        echo "[$name] 建状态符号链接失败" >&2; exit 78; }

      exec chroot "$rf" /bin/sh -lc "cd '$mod' && exec /bin/sh '$cmd'"
    '
}

spawn() {
  _mode=$(resolve_mode)
  case "$_mode" in
    exec) log info "$NAME: 启动方式 exec（宿主直装）"; spawn_exec ;;
    proot) log info "$NAME: 启动方式 proot（独立 node，假 root）"; spawn_exec ;;
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
      # 78 是「环境不成立」：缺 proot/rootfs/node、参数拼不起来、bind 源不存在。
      # 这种错重试 20 次也只是把同一行日志刷 20 遍（真机上见过），直接停。
      if [ "$rc" = "78" ]; then
        log fatal "$NAME 退出 78（环境不成立），不再重试"
        mkdir -p "${MIRROR_DIR:-/sdcard/Bridge/Logs}" 2>/dev/null
        redact < "$LOG_FILE" > "${MIRROR_DIR:-/sdcard/Bridge/Logs}/$NAME.log" 2>/dev/null
        break
      fi
      fails=$((fails+1))
      if [ "$fails" -ge "$RESTART_MAX" ]; then
        log fatal "$NAME 连续失败 $fails 次，停止重试"
        # 放弃重试时把整份单元日志脱敏放一份到共享存储：proot/node 的原始报错都在里面，
        # 不用 root 也能直接读，省得只看到被截断的尾巴。
        mkdir -p "${MIRROR_DIR:-/sdcard/Bridge/Logs}" 2>/dev/null
        redact < "$LOG_FILE" > "${MIRROR_DIR:-/sdcard/Bridge/Logs}/$NAME.log" 2>/dev/null
        break
      fi
      log warn "$NAME 退出 rc=$rc（第 $fails 次），退避重启"
      # 退出原因只写在单元日志里（例如 proot 起不来、端口占用、node 报错）。
      # 把尾部带回 supervisor，log() 会镜像到 /sdcard/Bridge/Logs，没有 root 也能看。
      # 40 行是因为 proot 的报错块本身就有 7 行（possible causes + fatal error），
      # 只带 6 行会把最关键的 execve 那行截掉。
      tail -n 40 "$LOG_FILE" 2>/dev/null | while IFS= read -r _l; do
        [ -n "$_l" ] && log warn "[$NAME] $_l"
      done
      sleep $(( fails < 5 ? fails * 3 : BACKOFF_MAX ))
    done
    rm -f "$PID_FILE"
  ) >/dev/null 2>&1 &
  echo $! > "$PID_FILE"
  # 启动确认：进程一起来就返回，不再固定 sleep 1（手机上这 1 秒是白等的）。
  _i=0
  while [ "$_i" -lt 10 ]; do
    running && break
    _i=$((_i + 1))
    sleep 0.1 2>/dev/null || { sleep 1; break; }
  done
  if running; then
    log info "$NAME 已启动 pid=$(cat "$PID_FILE")"
  else
    log warn "$NAME 未确认运行，见 $LOG_FILE"
    # 失败原因往往只在单元日志里（例如 chroot 的「挂模块代码失败」）。把尾部带回
    # supervisor，log() 会把它镜像到 /sdcard/Bridge/Logs/，没有 root 也能看到。
    tail -n 30 "$LOG_FILE" 2>/dev/null | while IFS= read -r _l; do
      [ -n "$_l" ] && log warn "[$NAME] $_l"
    done
    # 整份单元日志也脱敏放一份到共享存储：DSH App 能直接读，不用 root 捞 /data/adb。
    mkdir -p "${MIRROR_DIR:-/sdcard/Bridge/Logs}" 2>/dev/null
    redact < "$LOG_FILE" > "${MIRROR_DIR:-/sdcard/Bridge/Logs}/$NAME.log" 2>/dev/null
  fi
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
