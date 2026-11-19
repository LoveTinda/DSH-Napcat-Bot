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

# 3) 配置：宿主侧只负责策略文件；app.json 由 guest 里的 bin/app-boot.sh 生成。
CONF="$DATA/etc/app.json"
# 策略文件：白名单为空或还是占位值时，按 NapCat 的登录账号生成一份「只应答你自己」的。
# 不这么做，桥接器会按设计 fail-closed（policy.allowUsers 为空 → 拒绝启动），
# 真机日志里就是「访问策略配置不安全，拒绝启动」，面板永远空着。
POLICY=$(conf_get BRIDGE_POLICY_FILE "$DATA/etc/bridge-policy.json")
SHARED_POLICY="$(dirname "$MIRROR_DIR")/bridge-policy.json"
_ensure_policy() {
  # 宿主和 proot 的 /data 实测可能是两份内容（同名不同物）：共享存储那份也算数。
  if [ ! -s "$POLICY" ] && [ -s "$SHARED_POLICY" ]; then
    mkdir -p "$(dirname "$POLICY")" 2>/dev/null
    cp "$SHARED_POLICY" "$POLICY" 2>/dev/null && log info "策略取自共享存储：$SHARED_POLICY"
  fi
  _bad=0
  [ -s "$POLICY" ] || _bad=1
  [ "$_bad" -eq 0 ] && grep -qE '"allowUsers"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' "$POLICY" && _bad=1
  [ "$_bad" -eq 0 ] && grep -q '"123456"' "$POLICY" && _bad=1
  [ "$_bad" -eq 0 ] && return 0
  _qq=$(conf_get NAPCAT_QQ "")
  if [ -z "$_qq" ]; then
    # 从 NapCat 的登录文件名推账号（napcat_<QQ>.json）。不用 sed 的 \{n,m\}——
    # toybox/busybox 的 sed 对区间写法支持不一致，真机上就是这里静默失败过。
    for _f in /opt/napcat/config/napcat_*.json; do
      [ -f "$_f" ] || continue
      _b=${_f##*/}
      _q=${_b#napcat_}
      _q=${_q%.json}
      case "$_q" in ''|*[!0-9]*) continue ;; esac
      _qq=$_q
      break
    done
  fi
  [ -n "$_qq" ] || { log warn "白名单为空，且认不出 NapCat 账号：请在 $POLICY 里填 allowUsers"; return 0; }
  mkdir -p "$(dirname "$POLICY")" 2>/dev/null
  printf '{"privateChat":"allowlist","groupChat":"mention","allowUsers":["%s"],"ownerUsers":["%s"],"allowGroups":[]}\n' "$_qq" "$_qq" > "$POLICY" || { log error "写不了策略文件 $POLICY"; return 0; }
  chmod 600 "$POLICY" 2>/dev/null
  # 同时放一份到共享存储：proot 里的 /data 可能读不到这份，人也能直接看/改。
  printf '{"privateChat":"allowlist","groupChat":"mention","allowUsers":["%s"],"ownerUsers":["%s"],"allowGroups":[]}\n' "$_qq" "$_qq" > "$SHARED_POLICY" 2>/dev/null
  log warn "白名单为空/占位，已按 NapCat 账号 $_qq 生成策略（只应答该账号；要放开就改这个文件）"
  return 0
}
_ensure_policy

# APK 里的 proot 不是静态链接（缺 libtalloc.so 会 CANNOT LINK），exec 前补同目录库路径。
PROOT_LIBDIR=$(dirname "$PROOT_BIN")
[ -e "$PROOT_LIBDIR/libtalloc.so" ] || {
  _lf=$(find /data/app -path "*${PKG}*" -name libtalloc.so 2>/dev/null | head -1)
  [ -n "$_lf" ] && PROOT_LIBDIR=$(dirname "$_lf")
} 2>/dev/null
export LD_LIBRARY_PATH="${PROOT_LIBDIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# 配置不再在宿主预生成：交给 guest 里的 bin/app-boot.sh，每次启动按模板 + 策略重写
# /tmp/tinda-app.json。这样不依赖「宿主 $CONF 与 guest /tmp 是同一个文件」这个假设。
chmod 600 "$POLICY" 2>/dev/null

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
# 配置文件由 app-boot.sh 在 guest 里写，这里不再预建空文件（空文件曾被当成配置读进去）。

TOKEN=""
[ -f "$DATA/secrets/napcat.token" ] && TOKEN=$(cat "$DATA/secrets/napcat.token" 2>/dev/null)

# 5) proot 参数不在这里拼：交给 bin/proot-run.sh，和 web 共用同一份（照抄 DSH App
#    自己启动 proot 的命令行）。这里只声明额外 bind，且只挂运行必需面：
#    模块 app/、状态、配置、qq profile。不 bind /data、/sdcard。
# 配置模板与策略**直接复制**进 rootfs 的 /tmp：guest 的 /tmp 就是 $ROOTFS/tmp（同一份文件），
# 不用 -b 映射。真机上 -b 的源被判成「不存在」就被静默跳过，这正是策略一直进不去的原因。
mkdir -p "$ROOTFS/tmp" 2>/dev/null
cp "$MODDIR/app/config.example.json" "$ROOTFS/tmp/tinda-template.json" 2>/dev/null   || log warn "复制配置模板到 guest /tmp 失败"
_policy_src="$SHARED_POLICY"
[ -s "$_policy_src" ] || _policy_src="$POLICY"
if [ -s "$_policy_src" ]; then
  cp "$_policy_src" "$ROOTFS/tmp/tinda-policy.json" 2>/dev/null     || log warn "复制策略到 guest /tmp 失败（会用模板默认值）"
else
  log warn "没有可读的策略文件：白名单可能为空，桥接器会拒绝启动"
fi
# 兜底：把策略里的第一个 QQ 号当 owner 传进去。就算文件复制再次失败，app-config.mjs
# 也会用它填 allowUsers，不至于因为「白名单为空」整棵树起不来。
_owner=$(tr -dc '0-9' < "$ROOTFS/tmp/tinda-policy.json" 2>/dev/null | head -c 12)
case "$_owner" in
  [0-9][0-9][0-9][0-9][0-9]*) export TINDA_OWNER_QQ="$_owner" ;;
esac

BINDS="$MODDIR/app:/tmp/tinda-app $STATE:/tmp/tinda-state $MODDIR/bin:/tmp/tinda-bin"
[ "$BIND_PROFILE" = "1" ] && BINDS="$BINDS $PROFILE_DST:/root/.dsh/profiles/qq"

# guest 环境：PATH/HOME/TMPDIR/TZ/TINDA_IN_PROOT 由 proot-run.sh 统一设置，
# 这里只补业务自己的变量。
export TINDA_EXTRA_BINDS="$BINDS"
export DSH_HOME=/root/.dsh
export NODE_OPTIONS="--dns-result-order=ipv4first --max-old-space-size=512"
export BRIDGE_STATE_DIR=/tmp/tinda-state
export BRIDGE_WORKSPACE=/tmp/tinda-state/workspace
[ -n "$TOKEN" ] && export ONEBOT_ACCESS_TOKEN="$TOKEN"

export NAPCAT_API="$(conf_get NAPCAT_API http://127.0.0.1:3001)"
log info "proot 启动：pkg=$PKG rootfs=$ROOTFS node=/usr/local/bin/node 策略=$POLICY"
exec sh "$MODDIR/bin/proot-run.sh" /bin/sh "$MODDIR/bin/app-boot"
