#!/system/bin/sh
# 目的：诊断这台 Android 的 toybox mount 能用哪种方式建立「挂载不回传宿主」的传播状态。
# 边界：不创建任何挂载、不写文件、不碰 /data/adb；每个候选命令都在新的 unshare -m 子进程里执行。
# 依赖：root、unshare、mount、readlink、awk。
# 输入：无。
# 失败：0=诊断跑完（看每个 rc）；2=未 root/没有 unshare；3=namespace 校验失败。
# 副作用：只在子 namespace 改传播标志；子进程退出即销毁，宿主不变。

set -u

say() { printf '%s\n' "$*"; }

[ "$(id -u 2>/dev/null)" = 0 ] || { say "SKIP  需要 root：su -c 'sh $0'"; exit 2; }
UNSHARE=$(command -v unshare 2>/dev/null || true)
[ -n "$UNSHARE" ] || { say "SKIP  没有 unshare"; exit 2; }
command -v mount >/dev/null 2>&1 || { say "SKIP  没有 mount"; exit 2; }
SH=/system/bin/sh
[ -x "$SH" ] || SH=$(command -v sh 2>/dev/null || true)
[ -n "$SH" ] || { say "SKIP  找不到 sh"; exit 2; }
PNS=$(readlink /proc/self/ns/mnt 2>/dev/null || true)
[ -n "$PNS" ] || { say "SKIP  读不到 /proc/self/ns/mnt"; exit 2; }

say "unshare=$UNSHARE"
say "mount=$(command -v mount)"
say "host_ns=$PNS"
say "只看 after 行里的 shared:/master:；没有 shared: 才可能不回传宿主。"

run() {
  label=$1
  shift
  say ""
  say "===== $label"
  PROBE_NS="$PNS" "$UNSHARE" -m "$SH" -c '
    say() { printf "%s\n" "$*"; }
    now=$(readlink /proc/self/ns/mnt 2>/dev/null || true)
    [ -n "$now" ] && [ "$now" != "$PROBE_NS" ] || { say "SKIP  未隔离，拒绝 mount"; exit 3; }
    say "before:"
    awk "\$5==\"/\" {print}" /proc/self/mountinfo
    mount "$@" 2>&1
    rc=$?
    say "rc=$rc"
    say "after:"
    awk "\$5==\"/\" {print}" /proc/self/mountinfo
  ' sh "$@"
  rc=$?
  say "child_rc=$rc"
  [ "$rc" -eq 3 ] && NS_BAD=1
}

NS_BAD=0
run "make-rprivate" --make-rprivate /
run "-o rprivate" -o rprivate /
run "-o remount,rprivate" -o remount,rprivate /
run "-o private" -o private /
run "-o remount,private" -o remount,private /

say ""
if [ "$NS_BAD" = 1 ]; then
  say "结论：namespace 校验失败；不要继续。"
  exit 3
fi
say "结论：诊断完成。只有 after 行没有 shared: 的候选，才可能用于 chroot。"
exit 0
