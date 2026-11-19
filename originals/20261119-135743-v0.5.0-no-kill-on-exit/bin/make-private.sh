#!/system/bin/sh
# 目的：把当前 mount namespace 的传播设为「新挂载不回传宿主」，供 chroot 前调用。
# 边界：只改传播标志，不创建任何挂载；必须在 unshare -m 的子进程内运行。
# 依赖：mount、grep、/proc/self/mountinfo；Android toybox 或 Magisk busybox。
# 失败：0=已确认没有 shared 传播；1=无法确认（调用方必须停止挂载，不能继续）。
# 副作用：只改当前 namespace 的传播；子进程退出即随 namespace 销毁。

set -u

die() { echo "FAIL  $*" >&2; exit 1; }

[ -r /proc/self/mountinfo ] || die "读不到 /proc/self/mountinfo"
command -v mount >/dev/null 2>&1 || die "没有 mount"
command -v grep >/dev/null 2>&1 || die "没有 grep"

# 防手滑：如果和 PID 1 在同一个 mount namespace，说明没 unshare，改的就是宿主。
_p1=$(readlink /proc/1/ns/mnt 2>/dev/null || true)
_self=$(readlink /proc/self/ns/mnt 2>/dev/null || true)
[ -n "$_p1" ] && [ -n "$_self" ] && [ "$_p1" != "$_self" ] || \
  die "不在独立 mount namespace，拒绝修改宿主传播"

# 已经是 private/slave 且全树没有 shared 时，不需要再改。
if ! grep -q ' shared:' /proc/self/mountinfo 2>/dev/null; then
  echo "ok    已无 shared 传播"
  exit 0
fi

# 首选标准写法；toybox 可能不认这个长选项。
if mount --make-rprivate / 2>/dev/null; then
  if ! grep -q ' shared:' /proc/self/mountinfo 2>/dev/null; then
    echo "ok    --make-rprivate"
    exit 0
  fi
fi

# Magisk 自带 busybox 时，先试它的 mount；不同 busybox 构建对传播选项支持不同。
for _bb in /data/adb/magisk/busybox /system/xbin/busybox; do
  [ -x "$_bb" ] || continue
  for _bopt in "--make-rprivate /" "-o remount,rprivate /" "-o rprivate /"; do
    if "$_bb" mount $_bopt 2>/dev/null; then
      if ! grep -q ' shared:' /proc/self/mountinfo 2>/dev/null; then
        echo "warn  toybox 不可用；busybox mount $_bopt 后已无 shared"
        exit 0
      fi
    fi
  done
done

# 绕开 toybox 不认 --make-rprivate 的情况：试它认得的 -o 写法。
# 注意：toybox 曾把 rprivate 映射成 MS_SLAVE|MS_REC，所以必须再查 shared，
# 不能只看 mount 的返回码。
for _opt in remount,rprivate rprivate remount,private private; do
  mount -o "$_opt" / 2>/dev/null || continue
  if ! grep -q ' shared:' /proc/self/mountinfo 2>/dev/null; then
    echo "warn  make-rprivate 不可用；-o $_opt 后已无 shared"
    exit 0
  fi
done

die "仍存在 shared 传播，拒绝继续"
