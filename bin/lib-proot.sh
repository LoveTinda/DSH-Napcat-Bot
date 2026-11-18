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
  return 0
}
