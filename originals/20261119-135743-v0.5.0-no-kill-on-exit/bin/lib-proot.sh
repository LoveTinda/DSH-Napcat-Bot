#!/system/bin/sh
# 目的：探测 DSH App 的 proot 与 runtime rootfs，给没有宿主 node 的单元复用。
# 边界：只探测、不启动进程；不改配置；不 mount；不写状态。
# 依赖：tinda.conf 的 PROOT_PKG / PROOT_BIN / PROOT_ROOTFS、pm（可选）、find。
# 失败：探测不到返回 1，PROOT_* 保持原值；调用方自己决定怎么报错。
# 副作用：设置 PROOT_PKG / PROOT_BIN / PROOT_ROOTFS 三个全局变量。

proot_detect() {
  PROOT_PKG=$(conf_get PROOT_PKG "io.github.ccch1mneyyy.dsh_app")
  PROOT_BIN=$(conf_get PROOT_BIN "")
  PROOT_ROOTFS=$(conf_get PROOT_ROOTFS "")
  # 探测要调 pm（binder，几百毫秒）再 find，开机时每单元都做一遍太贵；
  # 探测成功一次就记到 $DATA/run/proot.path，下次先验文件还在就直接用。
  _cache="${DATA}/run/proot.path"
  if [ -z "$PROOT_BIN" ] && [ -f "$_cache" ]; then
    _cb=$(cut -d'|' -f1 "$_cache" 2>/dev/null)
    _cr=$(cut -d'|' -f2 "$_cache" 2>/dev/null)
    if [ -n "$_cb" ] && [ -x "$_cb" ] && [ -x "$_cr/usr/local/bin/node" ]; then
      PROOT_BIN=$_cb; PROOT_ROOTFS=$_cr
      PROOT_LIBDIR=$(dirname "$PROOT_BIN")
      if [ ! -e "$PROOT_LIBDIR/libtalloc.so" ]; then
        _lf=$(find /data/app -path "*${PROOT_PKG}*" -name libtalloc.so 2>/dev/null | head -1)
        [ -n "$_lf" ] && PROOT_LIBDIR=$(dirname "$_lf")
      fi
      return 0
    fi
  fi
  if [ -z "$PROOT_BIN" ]; then
    _pm=/system/bin/pm
    [ -x "$_pm" ] || _pm=$(command -v pm 2>/dev/null)
    if [ -n "$_pm" ]; then
      _apk=$("$_pm" path "$PROOT_PKG" 2>/dev/null | sed -n 's/^package://p' | head -1)
      [ -n "$_apk" ] && PROOT_BIN="$(dirname "$_apk")/lib/arm64/libproot.so"
    fi
  fi
  if [ -z "$PROOT_BIN" ] && [ -d /data/app ]; then
    PROOT_BIN=$(find /data/app -path "*${PROOT_PKG}*/lib/arm64/libproot.so" 2>/dev/null | head -1)
  fi
  [ -n "$PROOT_BIN" ] && [ -x "$PROOT_BIN" ] || return 1
  if [ -z "$PROOT_ROOTFS" ]; then
    for _base in /data/user/0 /data/data; do
      if [ -x "$_base/$PROOT_PKG/files/runtime/rootfs/usr/local/bin/node" ]; then
        PROOT_ROOTFS="$_base/$PROOT_PKG/files/runtime/rootfs"
        break
      fi
    done
  fi
  [ -n "$PROOT_ROOTFS" ] && [ -x "$PROOT_ROOTFS/usr/local/bin/node" ] || return 1

  # proot 不是静态链接：真机日志是
  #   CANNOT LINK EXECUTABLE ".../libproot.so": library "libtalloc.so" not found
  # 直接 exec 绝对路径时动态链接器不会去 APK 的 lib 目录找依赖，必须补 LD_LIBRARY_PATH。
  PROOT_LIBDIR=$(dirname "$PROOT_BIN")
  if [ ! -e "$PROOT_LIBDIR/libtalloc.so" ]; then
    _lf=$(find /data/app -path "*${PROOT_PKG}*" -name libtalloc.so 2>/dev/null | head -1)
    [ -n "$_lf" ] && PROOT_LIBDIR=$(dirname "$_lf")
  fi
  printf '%s|%s\n' "$PROOT_BIN" "$PROOT_ROOTFS" > "$_cache" 2>/dev/null
  chmod 600 "$_cache" 2>/dev/null
  return 0
}
