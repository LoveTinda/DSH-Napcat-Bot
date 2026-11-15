#!/system/bin/sh
# 目的：模块脚本共用函数（日志、配置、原子写、脱敏）。所有 bin/*.sh 都 source 它。
# 边界：不做业务逻辑；不保证并发安全（调用方自己加锁）。
# 失败：配置缺失用缺省值并记 warn；写入失败必须显式返回非 0，禁止静默吞掉。

# 两种运行形态：
#   1) Magisk 模块：MODDIR=/data/adb/modules/tinda-bot，DATA=/data/adb/tinda-bot（service.sh 会传）
#   2) 开发/无 root：直接在仓库里跑，退回到仓库目录 + 仓库内 .runtime
# 判据是「模块目录在不在」，不看用户名或路径猜测。
MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}
# 数据目录：Magisk 形态用 /data/adb/tinda-bot；没有这个路径就退到模块内 .runtime。
if [ -d /data/adb/tinda-bot ] || [ ! -w "$(dirname "$MODDIR")" ]; then
  DATA=${DATA:-/data/adb/tinda-bot}
else
  DATA=${DATA:-$MODDIR/.runtime}
fi
CONF=${CONF:-$DATA/etc/tinda.conf}

# 目的：日志里禁止出现 token / 密钥 / 手机号等敏感串。
# 输入：任意文本；输出：脱敏后的文本；副作用：无。
redact() {
  sed -E \
    -e 's/(token|accessToken|apiKey|api_key|secret|password)[[:space:]]*[:=][[:space:]]*[^[:space:],"}]+/\1=***REDACTED***/Ig' \
    -e 's/(Bearer)[[:space:]]+[A-Za-z0-9._-]+/\1 ***REDACTED***/g' \
    -e 's/[0-9]{11,}/***PHONE***/g'
}

log() {
  _lvl="$1"; shift
  _ts=$(date '+%Y-%m-%dT%H:%M:%S')
  mkdir -p "$DATA/logs" 2>/dev/null
  _line="$_ts [$_lvl] $*"
  _line=$(printf '%s' "$_line" | redact)
  printf '%s\n' "$_line" >> "$DATA/logs/supervisor.log" 2>/dev/null
  printf '%s\n' "$_line"
}

conf_get() {
  _k="$1"; _d="$2"
  [ -f "$CONF" ] || { echo "$_d"; return; }
  _v=$(grep -E "^$_k=" "$CONF" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')
  [ -n "$_v" ] && echo "$_v" || echo "$_d"
}

ensure_dirs() {
  umask 077
  mkdir -p "$DATA/state" "$DATA/logs" "$DATA/run" "$DATA/secrets" "$DATA/etc"
  chmod 700 "$DATA/secrets" "$DATA/state" 2>/dev/null
  # 首次就把配置铺出来，别让「改哪个键」只存在于 example 里。已存在不覆盖。
  if [ ! -f "$CONF" ] && [ -f "$MODDIR/etc/tinda.conf.example" ]; then
    cp "$MODDIR/etc/tinda.conf.example" "$CONF" 2>/dev/null && chmod 600 "$CONF" 2>/dev/null
  fi
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

# 目的：日志超过上限就轮转（默认 50MB），防止写爆 /data。
log_rotate() {
  _max=$(( $(conf_get LOG_MAX_MB 50) * 1024 * 1024 ))
  _f="$DATA/logs/supervisor.log"
  [ -f "$_f" ] || return 0
  _sz=$(stat -c %s "$_f" 2>/dev/null || echo 0)
  if [ "$_sz" -gt "$_max" ]; then
    mv -f "$_f" "$_f.1" 2>/dev/null
    : > "$_f"
  fi
}
