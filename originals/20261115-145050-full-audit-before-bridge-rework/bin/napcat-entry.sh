#!/system/bin/sh
# 目的：容器内的一次性引导（在 Ubuntu 里执行）：装 QQNT + NapCat，然后前台运行。
# 边界：只跑容器内的东西；宿主的守护/日志由 bin/napcat.sh 负责。
# 当前状态：骨架。QQNT 安装与扫码登录必须在设备上完成（需要网络 + 人工扫码）。
set -e
PREFIX=/opt/napcat
mkdir -p "$PREFIX"

if [ ! -x "$PREFIX/qq/qq" ] && [ ! -x "$PREFIX/qq/QQ" ]; then
  echo "[napcat-entry] QQNT 未安装。"
  echo "[napcat-entry] 需要：Linux 版 QQNT（arm64 deb/tar）+ NapCat 本体。"
  echo "[napcat-entry] 放到 /sdcard/tinda/napcat-install/ 后，会从这里安装。"
  # 占位：等待安装，避免空转刷日志
  sleep 300
  exit 78
fi

exec "$PREFIX/start-napcat.sh"
