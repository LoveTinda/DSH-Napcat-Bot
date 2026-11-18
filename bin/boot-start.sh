#!/system/bin/sh
# 目的：开机后在后台等 boot_completed，再按 AUTO_START 列表把单元拉起来；由 service.sh 以
#       nohup 后台调用，所以等待发生在脚本自身，service.sh 仍然立刻退出。
# 边界：只调 bin/unit.sh；不判断业务是否健康、不重启、不 chroot、不 mount、不碰网络配置。
# 依赖：Android sh、getprop（可选）、$DATA/etc/tinda.conf 的 AUTO_START、bin/unit.sh。
# 失败：等 boot_completed 最多 90 秒，超时继续；单个单元起不来只记日志不重试；
#       本脚本无论如何都 exit 0，绝不阻塞或拖慢开机。
if [ -z "$MODDIR" ]; then
  MODDIR=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
fi
. "$MODDIR/bin/lib.sh"
ensure_dirs

UNITS=$(conf_get AUTO_START web)
case "$UNITS" in
  ''|off|none|0) log info "boot-start: AUTO_START 为空或关闭，不启动任何单元"; exit 0 ;;
esac

# 只在 Android 上等开机完成；开发机/容器里没有 getprop，直接跳过，免得白等 90 秒。
if [ -d /data/adb ] && command -v getprop >/dev/null 2>&1; then
  log info "boot-start: 等待 sys.boot_completed（最多 90 秒）"
  _i=0
  while [ "$(getprop sys.boot_completed 2>/dev/null)" != "1" ]; do
    _i=$((_i + 1))
    if [ "$_i" -ge 45 ]; then
      log warn "boot-start: 等不到 sys.boot_completed，继续启动"
      break
    fi
    sleep 2
  done
fi

log info "boot-start: 开机自启列表：$UNITS"
for _u in $UNITS; do
  case "$_u" in
    ''|*[!a-z0-9_-]*) log warn "boot-start: 跳过非法单元名 '$_u'"; continue ;;
  esac
  # 只认识 units/ 下真实存在的单元，避免配置写错时把任意字符串传给 unit.sh。
  if [ ! -d "$MODDIR/units/$_u" ]; then
    log warn "boot-start: 没有这个单元：$_u"
    continue
  fi
  _out=$(MODDIR="$MODDIR" DATA="$DATA" sh "$MODDIR/bin/unit.sh" start "$_u" 2>&1 | tail -3)
  log info "boot-start: $_u: $(printf '%s' "$_out" | tr '\n' ' ')"
done
log info "boot-start: 结束"
exit 0
