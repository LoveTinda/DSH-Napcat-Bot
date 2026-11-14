#!/system/bin/sh
# 目的：NapCat（QQ 侧）的**独立**生命周期——自己的容器、自己的 PID、自己的日志。
#       它和桥接器互不依赖：NapCat 重启不会带走 DSH；DSH 重启不会让 QQ 掉线。
# 边界：不安装 QQNT（安装是 init/on-device 步骤）；不做业务转发。
# 输入：init | start | stop | restart | status | logs [行数]
# 失败：容器缺失/挂载失败 → 退出 78（不可用），supervisor 层不重试安装。
# 副作用：bind mount /proc /dev /sys；写 $DATA/run/napcat.pid 与 logs/napcat.log

MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
. "$MODDIR/bin/lib.sh"
ensure_dirs

ROOTFS=$(conf_get NAPCAT_ROOTFS "$DATA/napcat/rootfs")
PIDFILE="$DATA/run/napcat.pid"
LOGF="$DATA/logs/napcat.log"
ENTRY="/opt/napcat/start.sh"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

do_init() {
  if [ -d "$ROOTFS/usr" ]; then log info "已存在 rootfs：$ROOTFS"; return 0; fi
  src=$(ls /sdcard/Download/ubuntu-base-*.tar.gz 2>/dev/null | head -1)
  [ -n "$src" ] || { log error "缺少 ubuntu-base 包（放一个 ubuntu-base-*.tar.gz 到 /sdcard/Download）"; exit 78; }
  mkdir -p "$ROOTFS"
  log info "解包 $src → $ROOTFS"
  tar xzf "$src" -C "$ROOTFS" || { log error "解包失败"; exit 78; }
  cp /etc/resolv.conf "$ROOTFS/etc/resolv.conf" 2>/dev/null || true
  log info "rootfs 就绪"
}

mounts() {
  mkdir -p "$ROOTFS/proc" "$ROOTFS/dev" "$ROOTFS/sys" "$ROOTFS/sdcard"
  mountpoint -q "$ROOTFS/proc" || mount -t proc proc "$ROOTFS/proc" 2>/dev/null
  mount -o bind /dev "$ROOTFS/dev" 2>/dev/null
  mount -o bind /sys "$ROOTFS/sys" 2>/dev/null
  mount -o bind /sdcard "$ROOTFS/sdcard" 2>/dev/null
}

do_start() {
  if running; then log info "已在运行 pid=$(cat "$PIDFILE")"; return 0; fi
  [ -d "$ROOTFS/usr" ] || { log error "容器未初始化：先跑 $0 init"; exit 78; }
  mounts
  log info "NapCat 启动（容器 $ROOTFS）"
  (
    echo $$ > "$PIDFILE"
    fails=0
    while :; do
      [ -f "$DATA/run/napcat.stop" ] && break
      chroot "$ROOTFS" /bin/bash -lc "exec $ENTRY" >> "$LOGF" 2>&1
      rc=$?
      [ -f "$DATA/run/napcat.stop" ] && break
      fails=$((fails+1))
      [ "$fails" -ge 10 ] && { log fatal "NapCat 连续失败 10 次，停止重试"; break; }
      log warn "NapCat 退出 rc=$rc，第 $fails 次重启"
      sleep $(( fails < 5 ? fails * 3 : 30 ))
    done
    rm -f "$PIDFILE"
  ) >/dev/null 2>&1 &
  sleep 2
  running && log info "NapCat 已启动 pid=$(cat "$PIDFILE")" || log error "NapCat 启动失败，看 $LOGF"
}

do_stop() {
  touch "$DATA/run/napcat.stop"
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
  _i=0
  while [ $_i -lt 8 ]; do running || break; sleep 1; _i=$((_i+1)); done
  [ -f "$PIDFILE" ] && kill -9 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null
  rm -f "$DATA/run/napcat.stop" "$PIDFILE"
  log info "NapCat 已停止（QQ 会掉线，这是独立生命周期的代价）"
}

case "${1:-status}" in
  init) do_init ;;
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) if running; then echo "napcat: running pid=$(cat "$PIDFILE")"; else echo "napcat: stopped"; fi ;;
  logs) tail -n "${2:-40}" "$LOGF" 2>/dev/null || echo "无日志" ;;
  *) echo "用法: $0 init|start|stop|restart|status|logs [n]"; exit 2 ;;
esac
