#!/system/bin/sh
# 目的：模块脚本共用函数（日志、配置、原子写、脱敏、配置补齐）。所有 bin/*.sh 都 source 它。
# 边界：不做业务逻辑；不保证并发安全（调用方自己加锁）。
# 依赖：POSIX sh / toybox（Android），不依赖 bash 与 GNU 工具。
# 失败：配置缺失用缺省值并记 warn；写入失败必须显式返回非 0，禁止静默吞掉。

# 两种运行形态：
#   1) Magisk 模块：MODDIR=/data/adb/modules/tinda-bot，DATA=/data/adb/tinda-bot（service.sh 会传）
#   2) 开发/无 root：直接在仓库里跑，退回到仓库目录 + 仓库内 .runtime
# 判据是「模块目录在不在」，不看用户名或路径猜测。
if [ -z "$MODDIR" ]; then
  MODDIR=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
fi
# 数据目录：Magisk 形态用 /data/adb/tinda-bot；没有这个路径就退到模块内 .runtime。
# 判据不是「/data/adb/tinda-bot 在不在」——首次安装时它还不存在，那时会误落到模块目录里，
# 而模块目录在升级/重装时会被整体替换，状态、日志、密钥全跟着没。所以先认模块自身路径。
if [ -z "$DATA" ]; then
  case "$MODDIR" in
    /data/adb/modules/*|/data/adb/modules_update/*) DATA=/data/adb/tinda-bot ;;
    *)
      if [ -d /data/adb/tinda-bot ] || [ ! -w "$(dirname "$MODDIR")" ]; then
        DATA=/data/adb/tinda-bot
      else
        DATA=$MODDIR/.runtime
      fi
      ;;
  esac
fi
if [ -z "$CONF" ]; then CONF=$DATA/etc/tinda.conf; fi

# 目的：日志里禁止出现 token / 密钥 / 手机号等敏感串。
# 输入：任意文本；输出：脱敏后的文本；副作用：无。
redact() {
  sed -E \
    -e 's/(token|accessToken|apiKey|api_key|secret|password)([[:space:]]*[:=][[:space:]]*)("?)[^[:space:],"}]+/\1\2\3***REDACTED***/Ig' \
    -e 's/(Bearer)[[:space:]]+[A-Za-z0-9._~+\/-]+/\1 ***REDACTED***/g' \
    -e 's/[0-9]{11,}/***PHONE***/g'
}

log() {
  _lvl="$1"; shift
  _ts=$(date '+%Y-%m-%dT%H:%M:%S')
  mkdir -p "$DATA/logs" 2>/dev/null
  log_rotate
  _line="$_ts [$_lvl] $*"
  _line=$(printf '%s' "$_line" | redact)
  printf '%s\n' "$_line" >> "$DATA/logs/supervisor.log" 2>/dev/null
  printf '%s\n' "$_line"
}

conf_get() {
  _k="$1"; _d="$2"
  [ -f "$CONF" ] || { echo "$_d"; return; }
  case "$_k" in ''|*[!A-Za-z0-9_]*) echo "$_d"; return ;; esac
  _v=$(grep -E "^$_k=" "$CONF" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')
  [ -n "$_v" ] && echo "$_v" || echo "$_d"
}

# 目的：升级后旧配置里可能缺新键；从 example 补齐缺省值，但不覆盖已有值、不删旧键。
# 输入：$CONF 与 etc/tinda.conf.example；输出：补键数量（日志一行）。
# 失败：写不进去只记 warn，不阻断启动。
# 副作用：追加写 $CONF（保持原文件与权限）。
conf_sync() {
  [ -f "$CONF" ] && [ -f "$MODDIR/etc/tinda.conf.example" ] || return 0
  _added=0
  # 先把已有键一次性读出来。旧实现每行都 fork 一次 printf/cut/tr + grep，
  # 150 行的模板在手机上要 2 秒——而 ensure_dirs 每次启动单元都会走一遍。
  _keys=$(sed -n 's/^\([A-Za-z0-9_]*\)=.*/\1/p' "$CONF" 2>/dev/null | tr '\n' ' ')
  _cr=$(printf '\r')
  while IFS= read -r _line; do
    _line=${_line%$_cr}
    case "$_line" in ''|'#'*) continue ;; esac
    case "$_line" in *=*) ;; *) continue ;; esac
    _key=${_line%%=*}
    case "$_key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    case " $_keys " in *" $_key "*) continue ;; esac
    printf '\n# 由 bin/lib.sh 从 example 补的缺省值\n%s\n' "$_line" >> "$CONF" || break
    _keys="$_keys $_key"
    _added=$((_added + 1))
  done < "$MODDIR/etc/tinda.conf.example"
  [ "$_added" -gt 0 ] && log warn "配置补了 $_added 个缺省键：$CONF"
  return 0
}

ensure_dirs() {
  umask 077
  mkdir -p "$DATA/state" "$DATA/logs" "$DATA/run" "$DATA/secrets" "$DATA/etc"
  chmod 700 "$DATA/secrets" "$DATA/state" 2>/dev/null
  # 首次就把配置铺出来，别让「改哪个键」只存在于 example 里。已存在不覆盖。
  if [ ! -f "$CONF" ] && [ -f "$MODDIR/etc/tinda.conf.example" ]; then
    cp "$MODDIR/etc/tinda.conf.example" "$CONF" 2>/dev/null && chmod 600 "$CONF" 2>/dev/null
  fi
  chmod 600 "$CONF" 2>/dev/null
  conf_sync
}

# 目的：状态文件必须原子落盘，避免断电/被杀留下半截 JSON（这次事故的同类风险）。
# 输入：目标路径 + 内容（stdin）；失败：返回非 0，调用方必须处理。
atomic_write() {
  _dst="$1"
  _tmp="$_dst.tmp.$$"
  cat > "$_tmp" || { rm -f "$_tmp"; return 1; }
  sync
  mv -f "$_tmp" "$_dst" || { rm -f "$_tmp"; return 1; }
  chmod 600 "$_dst" 2>/dev/null
  return 0
}

# 目的：日志超过上限就轮转（默认 50MB），防止写爆 /data。supervisor.log 每次写日志前检查；
#       unit.sh 在启动单元时对单元日志调用同一函数（长跑进程不会自己轮转）。
# 输入：可选文件路径，缺省 supervisor.log；输出：无。
# 失败：stat/mv 失败只静默跳过，不影响业务。
# 副作用：把超限文件改名为 .1 并清空原文件。
rotate_log_file() {
  if [ -n "$1" ]; then _f=$1; else _f=$DATA/logs/supervisor.log; fi
  _max=$(( $(conf_get LOG_MAX_MB 50) * 1024 * 1024 ))
  [ -f "$_f" ] || return 0
  _sz=$(stat -c %s "$_f" 2>/dev/null || echo 0)
  if [ "$_sz" -gt "$_max" ]; then
    mv -f "$_f" "$_f.1" 2>/dev/null
    : > "$_f"
  fi
}

log_rotate() { rotate_log_file "$DATA/logs/supervisor.log"; }
