#!/system/bin/sh
# 目的：把「能不能当 Magisk 模块刷」变成可执行检查——module.prop 字段、必备文件、shebang、
#       可执行位、CRLF、service.sh 是否保持“开机零动作”，缺一项就失败。
# 边界：只做静态检查，不刷机、不验证 Android 侧能不能跑 node（那是 S-4）；不检查业务逻辑。
# 依赖：grep/sed/find/stat；模块根目录（含 module.prop）。--selftest 做一次反向用例。
# 失败：任一项不满足 → 退出 1；--selftest 内部失败也算 1。
# 副作用：--selftest 会在 /tmp 建临时目录，结束删除。

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
CR=$(printf '\r')
bad=0
warn=0
fail() { echo "FAIL  $*"; bad=$((bad + 1)); }
note() { echo "warn  $*"; warn=$((warn + 1)); }
ok()   { echo "ok    $*"; }

check_root() {
  root=$1
  [ -f "$root/module.prop" ] || { fail "$root 缺 module.prop"; return; }
  for f in customize.sh service.sh uninstall.sh bin/unit.sh bin/lib.sh etc/tinda.conf.example; do
    [ -f "$root/$f" ] || fail "缺 $f"
  done

  # module.prop：Magisk 只认 key=value；缺字段或 id 非法会导致装不上或装上了看不见
  for k in id name version versionCode author description; do
    grep -qE "^$k=" "$root/module.prop" || fail "module.prop 缺 $k"
  done
  id=$(sed -n 's/^id=//p' "$root/module.prop" | head -1)
  case "$id" in
    ''|*[!a-z0-9._-]*) fail "module.prop 的 id 非法：'$id'（只允许小写字母/数字/._-）" ;;
  esac
  vc=$(sed -n 's/^versionCode=//p' "$root/module.prop" | head -1)
  case "$vc" in ''|*[!0-9]*) fail "module.prop 的 versionCode 必须是整数：'$vc'" ;; esac

  # 脚本：Android 上跑的小脚本必须用 /system/bin/sh；.mjs 用 node
  for f in "$root/service.sh" "$root/customize.sh" "$root/uninstall.sh" $(find "$root/bin" -type f -name '*.sh' 2>/dev/null); do
    [ -f "$f" ] || continue
    head -1 "$f" | grep -q '^#!/system/bin/sh' || fail "$(basename "$f") 首行不是 #!/system/bin/sh"
    [ -x "$f" ] || fail "$(basename "$f") 没有可执行位"
    grep -q "$CR" "$f" && fail "$(basename "$f") 含 CRLF（Android sh 会报错）"
  done
  # .mjs 由 node 显式执行（exec "$NODE" file.mjs），不要求 shebang；只查 CRLF。
  for f in $(find "$root/bin" "$root/units" -type f -name '*.mjs' 2>/dev/null); do
    grep -q "$CR" "$f" && fail "$(basename "$f") 含 CRLF"
  done

  # 单元声明：TYPE 只允许这五种；写错会让 unit.sh 在开机时退出 78，而且日志在模块目录里看不到
  for c in $(find "$root/units" -name 'unit.conf' 2>/dev/null); do
    _t=$(sed -n 's/^TYPE=//p' "$c" | head -1)
    case "$_t" in
      exec|proot|chroot|external|auto) ;;
      *) fail "$(basename "$(dirname "$c")")/unit.conf 的 TYPE='$_t' 非法（exec|proot|chroot|external|auto）" ;;
    esac
  done
  grep -q 'module.log' "$root/service.sh" || note "service.sh 没写 module.log，刷完出问题不好查"

  # 开机自启：等待与启动只能在后台的 boot-start.sh 里；service.sh 必须立刻退出。
  # 旧版的 180 秒等待 + 20 秒 sleep 直接写在 service.sh 里，是拖住开机的事故源。
  grep -q 'boot-start.sh' "$root/service.sh" || fail "service.sh 没调用 bin/boot-start.sh（AUTO_START 不生效）"
  grep -q 'AUTO_START' "$root/service.sh" || fail "service.sh 没读 AUTO_START"
  [ -f "$root/bin/boot-start.sh" ] || fail "缺 bin/boot-start.sh"
  grep -q 'sys.boot_completed' "$root/bin/boot-start.sh" || fail "boot-start.sh 没等 boot_completed"
  grep -q 'AUTO_START' "$root/bin/boot-start.sh" || fail "boot-start.sh 没读 AUTO_START"
  grep -q 'sleep 20' "$root/service.sh" && fail "service.sh 仍有 sleep 20（会拖开机）"
  # 允许 wait 只在 boot-start.sh；service.sh 里出现 getprop 等待就是又回到老路。
  if grep -q 'getprop sys.boot_completed' "$root/service.sh"; then
    fail "service.sh 自己在等 boot_completed（等待必须放 boot-start.sh）"
  fi
  grep -q 'unit.sh' "$root/service.sh" || note "service.sh 没给手动启动示例"
  grep -q '^AUTO_START=' "$root/etc/tinda.conf.example" || fail "tinda.conf.example 缺 AUTO_START"
  # 模块信息页：页面文件、网关路由、网关拿得到数据路径，缺一件就是白屏。
  [ -f "$root/bin/lib-proot.sh" ] || fail "缺 bin/lib-proot.sh（web 没有宿主 node 时的 proot 回退）"
  grep -q 'lib-proot.sh' "$root/bin/run-web.sh" || fail "run-web.sh 没接 proot 回退（没 node 的机器上 web 起不来）"
  [ -f "$root/webroot/index.html" ] || fail "缺 webroot/index.html（KernelSU/APatch 模块页的「打开」按钮）"
  [ -f "$root/units/web/ui/module.html" ] || fail "缺 units/web/ui/module.html（模块信息页）"
  grep -q '/module/data.json' "$root/units/web/gateway.mjs" || fail "网关没有 /module/ 路由"
  grep -q 'TINDA_DATA' "$root/bin/run-web.sh" || fail "run-web.sh 没把 TINDA_DATA 传给网关"
  # chroot 必须有 namespace 校验 + 传播 helper，且不得再 bind /data/adb 祖先。
  grep -q 'unshare' "$root/bin/unit.sh" || fail "unit.sh 缺 unshare（chroot 会泄漏挂载）"
  grep -q 'TINDA_NS' "$root/bin/unit.sh" || fail "unit.sh 缺 namespace 校验（可能没隔离就 mount）"
  grep -q 'make-private.sh' "$root/bin/unit.sh" || fail "unit.sh 没调用 make-private.sh（传播可能回传宿主）"
  [ -f "$root/bin/make-private.sh" ] || fail "缺 bin/make-private.sh"
  grep -q 'rprivate' "$root/bin/make-private.sh" || fail "make-private.sh 没试 rprivate"
  grep -q 'shared:' "$root/bin/make-private.sh" || fail "make-private.sh 没检查 shared 残留"
  grep -q 'mount --make-private' "$root/bin/unit.sh" && fail "unit.sh 仍有 make-private 回退（递归私有不成立）"
  grep -q 'mount -o bind /data/adb' "$root/bin/unit.sh" && fail "unit.sh 仍在 bind /data/adb（递归挂载）"
  grep -q '^TYPE=exec' "$root/units/napcat/unit.conf" || fail "napcat 必须是 TYPE=exec（Android QQ 不能进 glibc rootfs）"
  grep -q '^TYPE=proot' "$root/units/bridge/unit.conf" || fail "bridge 必须是 TYPE=proot（独立 node，不 chroot、不 mount）"
  grep -q '^TYPE=proot' "$root/units/web/unit.conf" || fail "web 必须是 TYPE=proot（用户明确要求不用 chroot）"
  # web 也只允许 proot：宿主是 Android root 域，不能跑业务 node。
  grep -q 'TINDA_IN_PROOT' "$root/bin/run-web.sh" || fail "run-web.sh 没有 proot 重入保护"
  grep -q '不回退宿主' "$root/bin/run-web.sh" || fail "run-web.sh 可能回退宿主 exec（不允许）"
  grep -qE 'command -v node' "$root/bin/run-web.sh" && grep -q 'WEB_RUNTIME' "$root/bin/run-web.sh" \
    && fail "run-web.sh 仍有宿主 node / WEB_RUNTIME 分支"
  [ -f "$root/app/src/index.js" ] || fail "缺单应用入口 app/src/index.js"
  grep -q 'MODPATH' "$root/customize.sh" || note "customize.sh 没用到 MODPATH（安装期路径可能取错）"

  # 运行时（S-4）：模块本身不带 node；有 bin/node 就用，没有就要系统 PATH 里有
  if [ -x "$root/bin/node" ]; then
    ok "自带 bin/node（$("$root/bin/node" -v 2>/dev/null || echo 版本未知)）"
  else
    note "没有自带 bin/node：bridge 与 web 都用 DSH rootfs 的 node，宿主不再需要 node"
  fi
  [ "$bad" -eq 0 ] && ok "模块结构可刷（$root）"
}

if [ "${1:-}" = "--selftest" ]; then
  tmp=$(mktemp -d) || exit 1
  trap 'rm -rf "$tmp"' EXIT INT TERM
  mkdir -p "$tmp/bin" "$tmp/units/napcat" "$tmp/units/bridge" "$tmp/app/src" "$tmp/etc"
  cp "$MODDIR/module.prop" "$MODDIR/service.sh" "$MODDIR/customize.sh" "$MODDIR/uninstall.sh" "$tmp/"
  cp "$MODDIR/bin/unit.sh" "$MODDIR/bin/lib.sh" "$MODDIR/bin/make-private.sh" "$tmp/bin/"
  cp "$MODDIR/units/napcat/unit.conf" "$tmp/units/napcat/"
  cp "$MODDIR/units/bridge/unit.conf" "$tmp/units/bridge/"
  cp "$MODDIR/app/src/index.js" "$tmp/app/src/"
  cp "$MODDIR/etc/tinda.conf.example" "$tmp/etc/"
  chmod +x "$tmp"/*.sh "$tmp"/bin/*.sh
  _out=$(check_root "$tmp" 2>&1) || true
  printf '%s\n' "$_out" | grep -q '^ok' || { echo "FAIL selftest：正常模块副本应通过"; echo "$_out"; exit 1; }
  sed -i 's/^id=.*/id=Bad_ID!/' "$tmp/module.prop"
  _out=$(check_root "$tmp" 2>&1) || true
  printf '%s\n' "$_out" | grep -q 'id 非法' || { echo "FAIL selftest：坏 id 没被抓到"; echo "$_out"; exit 1; }
  echo "ok    selftest：正常通过、坏 id 被拒"
  exit 0
fi

check_root "$MODDIR"
[ "$bad" -eq 0 ] && [ "$warn" -eq 0 ] && echo "结论：模块可以刷" || echo "结论：$bad 个 FAIL，$warn 个 warn"
exit $([ "$bad" -eq 0 ] && echo 0 || echo 1)
