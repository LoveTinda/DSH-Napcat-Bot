#!/system/bin/sh
# 目的：用最小动作验证 chroot 方案依赖的挂载能力，回答「这台的 unshare/mount 到底行不行」。
# 边界：默认只验证 namespace 与私有传播，不创建任何挂载；--mount 才在私有 namespace 里做一次
#       bind/remount/umount。两种情况都不碰 /data/adb、模块、服务、/system。
# 依赖：root、unshare、mount、umount，以及同目录的 make-private.sh / tinda-make-private.sh。
# 输入：无参数=只读探测；--mount=额外验证 bind 与只读 remount；TMPBASE 可指定临时根。
# 失败：0=通过；2=环境不支持/未 root（跳过，不改系统）；3=能力验证失败。
# 副作用：默认只在临时目录写一个文件；--mount 的挂载全在 unshare -m 子进程内，退出即销毁。
#       若异常残留，只卸载本脚本自己的 $TMP/mnt。

set -u

MARK="tinda-mount-probe-$$"
BASE=${TMPBASE:-/data/local/tmp}
TMP=""
RC=0
MOUNT_TEST=0

case "${1:-}" in
  --mount) MOUNT_TEST=1 ;;
  --help|-h)
    echo "用法：sh $0 [--mount]"
    echo "  默认只验证 unshare -m 与 mount --make-rprivate，不创建挂载。"
    echo "  --mount 额外在私有 namespace 里 bind/remount/umount 一次。"
    exit 0 ;;
  "") ;;
  *) echo "FAIL  不认识的参数：$1（--help）"; exit 2 ;;
esac

say() { printf '%s\n' "$*"; }

cleanup() {
  # 只处理本次唯一路径；不遍历、不猜测别的挂载点。不是挂载点时 umount 失败也无害。
  if [ -n "$TMP" ]; then
    umount "$TMP/mnt" 2>/dev/null || true
    rm -rf "$TMP" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM

fail() { say "FAIL  $*"; RC=3; }
skip() { say "SKIP  $*"; exit 2; }

say "== tinda mount probe =="
[ "$(id -u 2>/dev/null)" = 0 ] || skip "需要 root：su -c 'sh $0'"

UNSHARE=$(command -v unshare 2>/dev/null || true)
[ -n "$UNSHARE" ] || skip "没有 unshare：这台不能走 chroot；exec 模式不受影响"
command -v mount >/dev/null 2>&1 && command -v umount >/dev/null 2>&1 || skip "缺少 mount/umount"

SH=/system/bin/sh
HELPER=$(dirname "$0")/make-private.sh
[ -f "$HELPER" ] || HELPER=$(dirname "$0")/tinda-make-private.sh
[ -f "$HELPER" ] || skip "缺 make-private.sh（和探针放同一目录）"
[ -x "$SH" ] || SH=$(command -v sh 2>/dev/null || true)
[ -n "$SH" ] || skip "找不到 sh"

[ -d "$BASE" ] && [ -w "$BASE" ] || BASE=${TMPDIR:-/tmp}
[ -d "$BASE" ] && [ -w "$BASE" ] || skip "没有可写临时目录（可试 TMPBASE=/data/local/tmp）"
TMP="$BASE/$MARK"
SRC="$TMP/src"
DST="$TMP/mnt"
mkdir -p "$SRC" "$DST" || skip "建临时目录失败：$TMP"
printf 'probe\n' > "$SRC/hello" || skip "写临时文件失败"
say "ok    临时目录 $TMP"
[ "$MOUNT_TEST" = 1 ] && say "模式  完整挂载验证（仅在私有 namespace 内）" || say "模式  只读探测（不创建挂载）"

PNS=$(readlink /proc/self/ns/mnt 2>/dev/null || true)
# 没有 namespace id 就无法证明隔离；此时一律不做 mount，避免在宿主上改传播。
[ -n "$PNS" ] || skip "读不到 /proc/self/ns/mnt，无法确认隔离；不执行任何 mount"
say "ok    当前 mount namespace：$PNS"

CHILD='
set -u
say() { printf "%s\n" "$*"; }
# 先证明已经换了 namespace，再碰 mount；读不到 id 就失败关闭。
now=$(readlink /proc/self/ns/mnt 2>/dev/null || true)
[ -n "$now" ] || { say "FAIL  读不到子进程 namespace id，拒绝 mount"; exit 19; }
[ "$now" != "${PROBE_NS:-}" ] || { say "FAIL  仍在宿主 mount namespace，拒绝 mount"; exit 11; }
say "ok    已进入新 mount namespace"
# 不要求 toybox 支持 --make-rprivate：helper 会试多种写法，但必须确认无 shared 才返回 0。
[ -f "$HELPER" ] || { say "FAIL  缺 make-private.sh"; exit 12; }
"$SH" "$HELPER" || { say "FAIL  无法建立不回传宿主的传播"; exit 12; }
say "ok    传播已确认不回传宿主"

[ "${MOUNT_TEST:-0}" = 1 ] || { say "ok    只读探测结束，未创建挂载"; exit 0; }

mount -o bind "$SRC" "$DST" || { say "FAIL  bind 挂载失败"; exit 13; }
say "ok    bind 挂载成功"
[ "$(cat "$DST/hello" 2>/dev/null)" = probe ] || { say "FAIL  读不到挂载内容"; exit 14; }
if ! mount -o remount,ro,nosuid,nodev,noexec "$DST" 2>/dev/null; then
  if ! mount -o remount,bind,ro,nosuid,nodev,noexec "$DST" 2>/dev/null; then
    say "FAIL  remount 只读失败"
    exit 15
  fi
fi
# 以 mountinfo 的挂载选项为准；不要用 touch 判断，proot 会拦截写操作导致误报。
line=$(grep -F " $DST " /proc/self/mountinfo 2>/dev/null | head -1)
case "$line" in
  *" ro,"*|*" ro "*) say "ok    remount 后挂载为 ro" ;;
  *) say "FAIL  remount 后仍不是 ro：$line"; exit 16 ;;
esac
umount "$DST" || { say "FAIL  umount 失败"; exit 17; }
[ -f "$DST/hello" ] && { say "FAIL  卸载后仍看到挂载内容"; exit 18; }
say "ok    卸载后目录已恢复"
exit 0
'

PROBE_NS="$PNS" SRC="$SRC" DST="$DST" MOUNT_TEST="$MOUNT_TEST" HELPER="$HELPER" SH="$SH" "$UNSHARE" -m "$SH" -c "$CHILD"
rc=$?
case $rc in
  0) say "ok    子进程全部通过" ;;
  11|12|13|14|15|16|17|18|19) fail "子进程返回 $rc（原因见上）" ;;
  *) fail "unshare 启动失败 rc=$rc（内核不支持或被 SELinux 拒绝）" ;;
esac

# 关键：父进程（宿主 namespace）不应看到任何本次挂载。正常时 unshare 退出即销毁。
if grep -qF "$MARK" /proc/self/mountinfo 2>/dev/null; then
  fail "宿主 mountinfo 仍有本次痕迹（退出时只卸载 $DST）"
else
  say "ok    宿主 mountinfo 无本次痕迹"
fi

if [ "$RC" -eq 0 ]; then
  if [ "$MOUNT_TEST" = 1 ]; then
    say "PASS  unshare/mount/私有传播/bind/只读 remount 均可用"
  else
    say "PASS  unshare/mount 私有传播可用（未做实际挂载）"
    say "      要验证 bind/remount，再跑一次：sh $0 --mount"
  fi
else
  say "结论：这台不要用 chroot；把 bridge/web 设为 TYPE=exec（宿主直装），开机不受影响"
fi
exit "$RC"