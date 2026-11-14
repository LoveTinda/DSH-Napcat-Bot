#!/system/bin/sh
# 目的：守护桥接器的生命周期——开机拉起、崩溃重启、日志轮转、优雅停止。
# 边界：不解释业务错误；不负责安装依赖。
# 输入：start | stop | status | restart
# 失败：连续崩溃超过阈值（10 次/5 分钟）后放弃并记 fatal，等人工介入。
# 副作用：写 $DATA/run/supervisor.pid、$DATA/logs/supervisor.log

MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
. "$MODDIR/bin/lib.sh"
ensure_dirs

PIDFILE="$DATA/run/supervisor.pid"
CHILD="$DATA/run/bot.pid"
MAX_BACKOFF=$(conf_get RESTART_BACKOFF_MAX 60)

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

cmd_start() {
  if running; then log info "已在运行 pid=$(cat "$PIDFILE")"; return 0; fi
  log info "supervisor 启动"
  (
    echo $$ > "$PIDFILE"
    fails=0
    while :; do
      [ -f "$DATA/run/stop" ] && { log info "收到 stop 标记，退出"; break; }
      sh "$MODDIR/bin/run-bot.sh" &
      echo $! > "$CHILD"
      wait $!
      rc=$?
      [ -f "$DATA/run/stop" ] && { log info "收到 stop 标记，退出"; break; }
      if [ "$rc" -eq 0 ]; then
        log info "子进程正常退出"
        fails=0
      else
        fails=$((fails+1))
        [ "$fails" -ge 10 ] && { log fatal "5 分钟内连续失败 $fails 次，停止重试"; break; }
        log warn "子进程异常退出 rc=$rc，第 $fails 次重启"
      fi
      sleep $(( fails < 5 ? fails * 2 : MAX_BACKOFF ))
    done
    rm -f "$PIDFILE" "$CHILD"
  ) >/dev/null 2>&1 &
  sleep 1
  running && log info "supervisor 已启动 pid=$(cat "$PIDFILE")"
}

cmd_stop() {
  touch "$DATA/run/stop"
  for f in "$CHILD" "$PIDFILE"; do
    [ -f "$f" ] && kill "$(cat "$f" 2>/dev/null)" 2>/dev/null
  done
  sleep 1
  log info "已停止"
  rm -f "$DATA/run/stop"
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)
    if running; then echo "running pid=$(cat "$PIDFILE")"; else echo "stopped"; fi ;;
  *) echo "用法: $0 start|stop|restart|status"; exit 2 ;;
esac
