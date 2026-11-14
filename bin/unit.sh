#!/system/bin/sh
# 目的：**唯一**的单元管理入口。每个单元由 units/<name>/unit.conf 声明，行为完全一致。
# 边界：不实现业务；不认识任何具体单元的名字；不跨单元读写。
# 输入：start|stop|restart|status|logs <unit> [行数]
# 失败：单元未声明/入口缺失 → 78；外部单元不可 start → 明确拒绝。
# 副作用：写本单元的 PID/日志/状态目录（绝不碰别人的）。

MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
UNITS=${UNITS:-$MODDIR/units}
. "$MODDIR/bin/lib.sh"
ensure_dirs

load() {
  u="$1"
  [ -f "$UNITS/$u/unit.conf" ] || { log error "未声明的单元：$u"; exit 2; }
  # shellcheck disable=SC1090
  . "$UNITS/$u/unit.conf"
  mkdir -p "$STATE_DIR"
}

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; }

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
  log info "$NAME 启动"
  (
    fails=0
    while :; do
      [ -f "$PID_FILE.stop" ] && break
      spawn >> "$LOG_FILE" 2>&1
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
  touch "$PID_FILE.stop"
  [ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null
  i=0; while [ $i -lt 5 ]; do running || break; sleep 1; i=$((i+1)); done
  [ -f "$PID_FILE" ] && kill -9 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null
  rm -f "$PID_FILE.stop" "$PID_FILE"
  log info "$NAME 已停止"
}

act="$1"; name="$2"
[ -n "$act" ] && [ -n "$name" ] || { echo "用法: $0 start|stop|restart|status|logs <unit> [n]"; exit 2; }
load "$name"
case "$act" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) if running; then echo "$name: running pid=$(cat "$PID_FILE")"; else echo "$name: stopped"; fi ;;
  logs) tail -n "${3:-40}" "$LOG_FILE" 2>/dev/null || echo "无日志" ;;
  *) echo "未知动作：$act"; exit 2 ;;
esac
