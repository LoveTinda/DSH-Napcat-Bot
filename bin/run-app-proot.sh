#!/system/bin/sh
# 目的：在 DSH App 的 proot 里启动独立 node（app/src/index.js），不拿 Android 真 root 跑业务。
# 边界：只做路径探测、配置生成、proot 参数拼装；不 chroot、不 mount、不降权宿主进程。
# 依赖：proot（默认从 DSH App 的 libproot.so 找）、DSH runtime/rootfs、node、app/、$DATA/etc/app.json。
# 输入：tinda.conf 的 PROOT_PKG / PROOT_BIN / PROOT_ROOTFS；空 = 自动探测。
# 失败：找不到 proot/rootfs/node、建不了 guest 目录、配置生成失败 → 78（不回退宿主 exec）。
# 副作用：首次生成 $DATA/etc/app.json（0600）；在 rootfs 的 /tmp 下建 bind 目标目录。

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
. "$MODDIR/bin/lib.sh"
ensure_dirs

# 宿主 node 只用来生成 app.json；没有也不拦（真机 root 下通常没有）。
NODE="$MODDIR/bin/node"; [ -x "$NODE" ] || NODE=$(command -v node)

ENTRY="$MODDIR/app/src/index.js"
[ -f "$ENTRY" ] || { log error "入口缺失：$ENTRY"; exit 78; }

PKG=$(conf_get PROOT_PKG "io.github.ccch1mneyyy.dsh_app")
PROOT_BIN=$(conf_get PROOT_BIN "")
ROOTFS=$(conf_get PROOT_ROOTFS "")

# 1) proot 二进制：优先配置；否则从已安装 DSH App 的 native lib 里找。
if [ -z "$PROOT_BIN" ]; then
  _pm=/system/bin/pm
  [ -x "$_pm" ] || _pm=$(command -v pm)
  if [ -n "$_pm" ]; then
    _apk=$("$_pm" path "$PKG" 2>/dev/null | sed -n 's/^package://p' | head -1)
    if [ -n "$_apk" ]; then
      PROOT_BIN="$(dirname "$_apk")/lib/arm64/libproot.so"
    fi
  fi
fi
if [ -z "$PROOT_BIN" ] && [ -d /data/app ]; then
  PROOT_BIN=$(find /data/app -path "*${PKG}*/lib/arm64/libproot.so" 2>/dev/null | head -1)
fi
[ -n "$PROOT_BIN" ] && [ -x "$PROOT_BIN" ] || {
  log error "找不到可执行的 proot（PROOT_BIN=$PROOT_BIN，包=$PKG）。不回落宿主 exec。"
  exit 78
}

# 2) rootfs：优先配置；否则用 DSH App 的 runtime rootfs。
if [ -z "$ROOTFS" ]; then
  for base in /data/user/0 /data/data; do
    [ -d "$base/$PKG/files/runtime/rootfs/usr" ] && { ROOTFS="$base/$PKG/files/runtime/rootfs"; break; }
  done
fi
[ -n "$ROOTFS" ] && [ -d "$ROOTFS/usr" ] && [ -x "$ROOTFS/usr/local/bin/node" ] || {
  log error "找不到可用的 proot rootfs（PROOT_ROOTFS=$ROOTFS，需要 rootfs/usr/local/bin/node）。"
  exit 78
}

# 3) 配置：首次生成。宿主有 node 就直接生成；没有就用 rootfs 里的 node
#    通过 proot 生成，避免要求 Android 侧预装 node。
CONF="$DATA/etc/app.json"
if [ ! -f "$CONF" ]; then
  POLICY=$(conf_get BRIDGE_POLICY_FILE "$DATA/etc/bridge-policy.json")
  API=$(conf_get NAPCAT_API "http://127.0.0.1:3001")
  # APK 里的 proot 不是静态链接（缺 libtalloc.so 会 CANNOT LINK），exec 前补同目录库路径。
PROOT_LIBDIR=$(dirname "$PROOT_BIN")
[ -e "$PROOT_LIBDIR/libtalloc.so" ] || {
  _lf=$(find /data/app -path "*${PKG}*" -name libtalloc.so 2>/dev/null | head -1)
  [ -n "$_lf" ] && PROOT_LIBDIR=$(dirname "$_lf")
} 2>/dev/null
export LD_LIBRARY_PATH="${PROOT_LIBDIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

if [ -n "$NODE" ]; then
    "$NODE" "$MODDIR/bin/app-config.mjs" \
      "$MODDIR/app/config.example.json" "$CONF" "$POLICY" "$API" || exit 78
  else
    for d in "$ROOTFS/tmp/tinda-bin" "$ROOTFS/tmp/tinda-etc"; do
      mkdir -p "$d" 2>/dev/null || { log error "建不了配置 guest 目录：$d"; exit 78; }
    done
    touch "$ROOTFS/tmp/tinda-template.json" 2>/dev/null || exit 78
    "$PROOT_BIN" --kill-on-exit --link2symlink -0 \
      --rootfs="$ROOTFS" --cwd=/root \
      -b /dev -b /proc -b /sys \
      -b "$MODDIR/bin:/tmp/tinda-bin" \
      -b "$MODDIR/app/config.example.json:/tmp/tinda-template.json" \
      -b "$DATA/etc:/tmp/tinda-etc" \
      /usr/local/bin/node /tmp/tinda-bin/app-config.mjs \
      /tmp/tinda-template.json /tmp/tinda-etc/app.json /tmp/tinda-etc/bridge-policy.json "$API" || exit 78
  fi
  chmod 600 "$CONF" 2>/dev/null
  log warn "已生成 $CONF；白名单来自 $POLICY，没取到就手动改"
fi

STATE="$DATA/state/app"
mkdir -p "$STATE/workspace" 2>/dev/null
chmod 700 "$STATE" 2>/dev/null

# 3.1) qq profile：从 DSH 的 headless 复制一份，保留账号凭据三件套，
#      再 bind 到 guest 的 /root/.dsh/profiles/qq。不覆盖 rootfs 里已有的 qq。
PROFILE_SRC="$ROOTFS/root/.dsh/profiles/headless"
PROFILE_DST="$STATE/profile/qq"
BIND_PROFILE=1
if [ -d "$ROOTFS/root/.dsh/profiles/qq" ] && [ -n "$(ls -A "$ROOTFS/root/.dsh/profiles/qq" 2>/dev/null)" ]; then
  BIND_PROFILE=0
  log warn "rootfs 已有 qq profile，直接使用，不 bind 模块副本"
else
  [ -d "$PROFILE_SRC" ] || { log error "rootfs 缺 headless profile：$PROFILE_SRC"; exit 78; }
  mkdir -p "$PROFILE_DST" || { log error "建不了 profile 目录：$PROFILE_DST"; exit 78; }
  if [ ! -f "$PROFILE_DST/cordis.yml" ]; then
    cp -a "$PROFILE_SRC/." "$PROFILE_DST/" || { log error "复制 qq profile 失败"; exit 78; }
    sed -i 's/dsh-profile-headless/dsh-profile-qq/' "$PROFILE_DST/package.json" 2>/dev/null || true
  fi
  for id in credentials authorization deepseek-account; do
    grep -q "^- id: $id" "$PROFILE_DST/cordis.patch.yml" 2>/dev/null || \
      printf '\n- id: %s\n  disabled: false\n' "$id" >> "$PROFILE_DST/cordis.patch.yml"
  done
  mkdir -p "$ROOTFS/root/.dsh/profiles/qq" 2>/dev/null || {
    log error "建不了 guest qq profile 目录"; exit 78; }
fi

# 4) guest 绑定目标。只写 rootfs 的 /tmp，不碰 DSH 的配置/会话。
for d in "$ROOTFS/tmp/tinda-app" "$ROOTFS/tmp/tinda-state"; do
  mkdir -p "$d" 2>/dev/null || { log error "建不了 guest 目录：$d"; exit 78; }
done
touch "$ROOTFS/tmp/tinda-app.json" 2>/dev/null || { log error "建不了 guest 配置文件"; exit 78; }

TOKEN=""
[ -f "$DATA/secrets/napcat.token" ] && TOKEN=$(cat "$DATA/secrets/napcat.token" 2>/dev/null)

# 5) 只 bind 运行必需面：/dev /proc /sys /system /apex + 模块代码 + 状态 + 配置。
#    不 bind /data、/sdcard；proot 的 -0 只是假 root，不是 Android 真 root。
set -- \
  "$PROOT_BIN" --kill-on-exit --link2symlink -0 \
  --rootfs="$ROOTFS" --cwd=/root \
  -b /dev -b /proc -b /sys -b /system -b /apex \
  -b /proc/self/fd:/dev/fd \
  -b /proc/self/fd/0:/dev/stdin \
  -b /proc/self/fd/1:/dev/stdout \
  -b /proc/self/fd/2:/dev/stderr \
  -b "$MODDIR/app:/tmp/tinda-app" \
  -b "$STATE:/tmp/tinda-state" \
  -b "$CONF:/tmp/tinda-app.json"

[ "$BIND_PROFILE" = "1" ] && set -- "$@" -b "$PROFILE_DST:/root/.dsh/profiles/qq"

[ -d "$ROOTFS/var/lib/dsh-app/empty" ] && set -- "$@" -b "$ROOTFS/var/lib/dsh-app/empty:/sys/fs/selinux"

set -- "$@" /usr/bin/env -i \
  HOME=/root USER=root LOGNAME=root \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  LANG=C.UTF-8 TERM=xterm-256color TMPDIR=/tmp TZ=Asia/Shanghai \
  DSH_HOME=/root/.dsh \
  NODE_OPTIONS="--dns-result-order=ipv4first --max-old-space-size=512" \
  BRIDGE_STATE_DIR=/tmp/tinda-state \
  BRIDGE_WORKSPACE=/tmp/tinda-state/workspace \
  ONEBOT_ACCESS_TOKEN="$TOKEN" \
  /usr/local/bin/node /tmp/tinda-app/src/index.js /tmp/tinda-app.json

log info "proot 启动：pkg=$PKG rootfs=$ROOTFS node=/usr/local/bin/node"
exec "$@"
