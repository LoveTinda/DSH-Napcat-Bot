#!/system/bin/sh
# 目的：模块脚本共用函数（日志、配置读取、原子写）。所有 bin/*.sh 都 source 它。
# 边界：不做业务逻辑；不保证并发安全（调用方自己加锁）。
# 失败：配置缺失时用缺省值并记 warn，不直接退出。

MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
DATA=${DATA:-/data/adb/tinda-bot}
CONF=${CONF:-$DATA/etc/tinda.conf}

log() {
  _lvl="$1"; shift
  _ts=$(date '+%Y-%m-%dT%H:%M:%S')
  mkdir -p "$DATA/logs" 2>/dev/null
  echo "$_ts [$_lvl] $*" >> "$DATA/logs/supervisor.log"
  echo "$_ts [$_lvl] $*"
}

conf_get() {
  _k="$1"; _d="$2"
  [ -f "$CONF" ] || { echo "$_d"; return; }
  _v=$(grep -E "^$_k=" "$CONF" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')
  [ -n "$_v" ] && echo "$_v" || echo "$_d"
}

ensure_dirs() {
  mkdir -p "$DATA/state" "$DATA/logs" "$DATA/run" "$DATA/secrets" "$DATA/etc"
  chmod 700 "$DATA/secrets" 2>/dev/null
}
