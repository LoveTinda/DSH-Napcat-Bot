#!/system/bin/sh
# 目的：把「在 DSH App 的 proot 里跑一条 guest 命令」收敛成唯一一份参数，web 和 bridge 共用。
# 边界：只探测 proot/rootfs、拼参数、exec；不 mount、不 chroot、不改配置、不写状态。
# 依赖：bin/lib.sh、bin/lib-proot.sh、tinda.conf 的 PROOT_PKG/PROOT_BIN/PROOT_ROOTFS。
# 失败：探测不到 proot/rootfs、guest 缺 /bin/sh 或 node、路径含空白 → 78（不回退宿主 exec）。
# 副作用：$DATA/run/proot.mode 记住探针通过的参数档；日志经 lib.sh 镜像到 /sdcard/Bridge/Logs。
#
# 为什么参数要照抄 DSH App 自己的命令行：
#   App 启动 proot 的那一份是这台机器上唯一被验证过能跑起来的。v0.4.6 少了
#   --link2symlink / --sysvipc / -L 和 /dev/fd 系列 bind，真机日志里 proot 一起来就打
#     * the program is a script but its interpreter (eg. /bin/sh) was not found;
#     * ...
#     fatal error: see \`libproot.so --help\`.
#   然后 rc=1，8443 根本没监听。探针就是为了下次再出这种事能直接看到 proot 的原始报错。
#
# 用法：
#   proot-run.sh probe              只测 proot 起不起得来（结果写日志，不启动业务）
#   proot-run.sh <程序> [参数…]      在 proot 里 exec 这条命令（不返回）

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}
. "$MODDIR/bin/lib.sh"
. "$MODDIR/bin/lib-proot.sh"
ensure_dirs

case "${1:-}" in
  probe|--probe) _is_probe=1; shift ;;
  *) _is_probe=0 ;;
esac

proot_detect || {
  log error "找不到可用的 DSH proot（PROOT_BIN=${PROOT_BIN:-}，PROOT_ROOTFS=${PROOT_ROOTFS:-}，包=${PROOT_PKG:-}）"
  log error "web/bridge 只允许在 proot 里跑，不回退宿主 exec。装好 DSH App 或改 PROOT_* 再试。"
  exit 78
}
_LIBDIR=${PROOT_LIBDIR:-$(dirname "$PROOT_BIN")}

# 宿主侧先确认 guest 里关键文件在：缺了就直说 rootfs 不对，别等 proot 报天书。
for _f in /bin/sh /usr/local/bin/node; do
  [ -e "$PROOT_ROOTFS$_f" ] || { log error "rootfs 里缺 $_f：$PROOT_ROOTFS"; exit 78; }
done

# 参数靠词分割拼接，路径里有空白会拼错；这些路径都是模块固定的，出现空白说明环境异常。
for _p in "$MODDIR" "$DATA" "$PROOT_BIN" "$PROOT_ROOTFS"; do
  case "$_p" in
    *[[:space:]]*)
      log error "路径里有空白字符，proot 参数拼不起来：$_p"
      exit 78 ;;
  esac
done

# 唯一一份 proot 参数：一行一个，调用方按词分割拼进 argv。
# full = DSH App 用的完整扩展参数；minimal = 只有基础参数（万一换上别的 proot 构建）。
# 额外 bind 由调用方用 TINDA_EXTRA_BINDS="src:dst src:dst" 传进来（bridge 挂 app/state/配置）。
_proot_flags() {
  printf '%s\n' --kill-on-exit
  [ "$1" = full ] && printf '%s\n' --link2symlink --sysvipc -L
  printf '%s\n' -0 "--rootfs=$PROOT_ROOTFS" --cwd=/root
  printf '%s\n' -b /dev -b /dev/urandom:/dev/random -b /proc \
    -b /proc/self/fd:/dev/fd -b /proc/self/fd/0:/dev/stdin \
    -b /proc/self/fd/1:/dev/stdout -b /proc/self/fd/2:/dev/stderr \
    -b /sys -b /system -b /apex \
    -b "$MODDIR:$MODDIR" -b "$DATA:$DATA"
  # /sys/fs/selinux 拿空目录盖住，/dev/shm 用 rootfs 自己的：这两条 DSH App 也这么做。
  [ -d "$PROOT_ROOTFS/var/lib/dsh-app/empty" ] && \
    printf '%s\n' -b "$PROOT_ROOTFS/var/lib/dsh-app/empty:/sys/fs/selinux"
  [ -d "$PROOT_ROOTFS/var/lib/dsh-app/shm" ] && \
    printf '%s\n' -b "$PROOT_ROOTFS/var/lib/dsh-app/shm:/dev/shm"
  for _bd in ${TINDA_EXTRA_BINDS:-}; do printf '%s\n' -b "$_bd"; done
  return 0
}

_oneline() { printf '%s' "$1" | tr '\n' ' ' | cut -c1-600; }

# 探针：跑一条 /bin/sh -c，成功会打印 PROOT_OK；失败把 proot 的原始报错和退出码原样返回。
# 带上 rc 是为了区分「proot 一声不吭退出」和「proot 打印了报错」这两种失败。
_probe() {
  set -f
  set -- $(_proot_flags "$1") /bin/sh -c 'echo PROOT_OK'
  set +f
  _po=$(LD_LIBRARY_PATH="$_LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$PROOT_BIN" "$@" 2>&1)
  _prc=$?
  printf '%s\n[rc=%s]' "$_po" "$_prc"
}

MODE_CACHE="$DATA/run/proot.mode"
_mode=""
if [ "$_is_probe" = 0 ] && [ -s "$MODE_CACHE" ]; then
  _mode=$(cat "$MODE_CACHE" 2>/dev/null)
  case "$_mode" in full|minimal) ;; *) _mode="" ;; esac
fi

if [ -z "$_mode" ]; then
  _out=$(_probe full)
  case "$_out" in
    *PROOT_OK*)
      _mode=full
      log info "proot 探针通过（完整参数）rootfs=$PROOT_ROOTFS" ;;
    *)
      log warn "proot 探针失败（完整参数）：$(_oneline "$_out")"
      _out=$(_probe minimal)
      case "$_out" in
        *PROOT_OK*)
          _mode=minimal
          log warn "proot 退回基础参数可用（这份 proot 不认扩展选项）" ;;
        *)
          log error "proot 起不来，两种参数都试过：$(_oneline "$_out")"
          log error "proot=$PROOT_BIN rootfs=$PROOT_ROOTFS"
          exit 78 ;;
      esac ;;
  esac
  printf '%s\n' "$_mode" > "$MODE_CACHE" 2>/dev/null
fi

if [ "$_is_probe" = 1 ]; then
  log info "proot 探针完成：mode=$_mode（未启动业务）"
  exit 0
fi

[ "$#" -ge 1 ] || { log error "用法：proot-run.sh [probe|<程序> [参数…]]"; exit 78; }

set -f
set -- $(_proot_flags "$_mode") "$@"
set +f
log info "proot 启动：mode=$_mode pkg=${PROOT_PKG:-} rootfs=$PROOT_ROOTFS"
# guest 环境在这里定死：宿主 PATH 里的 Android 工具不该漏进去。
TINDA_IN_PROOT=1 \
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
HOME=/root TMPDIR=/tmp LANG=C.UTF-8 TERM=xterm-256color TZ=Asia/Shanghai \
LD_LIBRARY_PATH="$_LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
exec "$PROOT_BIN" "$@"
