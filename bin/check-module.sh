#!/system/bin/sh
# 目的：把「能不能当 Magisk 模块刷」变成可执行检查——module.prop 字段、必备文件、shebang、
#       可执行位、CRLF、service.sh 是否真的拉起单元，缺一项就失败。
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

  # service.sh 必须真的去拉单元，否则「开机自启」只是口号
  grep -q 'unit.sh' "$root/service.sh" || fail "service.sh 没有调用 bin/unit.sh"
  for u in napcat bridge web; do
    grep -q "$u" "$root/service.sh" || note "service.sh 没提到单元 $u"
  done
  grep -q 'MODPATH' "$root/customize.sh" || note "customize.sh 没用到 MODPATH（安装期路径可能取错）"

  # 运行时（S-4）：模块本身不带 node；有 bin/node 就用，没有就要系统 PATH 里有
  if [ -x "$root/bin/node" ]; then
    ok "自带 bin/node（$("$root/bin/node" -v 2>/dev/null || echo 版本未知)）"
  else
    note "没有自带 bin/node：刷完后要求 PATH 里已有 node，否则各单元会 exit 78（见 S-4）"
  fi
  [ "$bad" -eq 0 ] && ok "模块结构可刷（$root）"
}

if [ "${1:-}" = "--selftest" ]; then
  tmp=$(mktemp -d) || exit 1
  trap 'rm -rf "$tmp"' EXIT INT TERM
  mkdir -p "$tmp/bin" "$tmp/units" "$tmp/etc"
  cp "$MODDIR/module.prop" "$MODDIR/service.sh" "$MODDIR/customize.sh" "$MODDIR/uninstall.sh" "$tmp/"
  cp "$MODDIR/bin/unit.sh" "$MODDIR/bin/lib.sh" "$tmp/bin/"
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
