#!/system/bin/sh
# 目的：把 QQNT + NapCat 装进独立 Ubuntu 容器，并写好开机入口。
# 边界：不改桥接器、不登录账号（扫码必须人工）；不做网络代理。
# 依赖：root；容器 rootfs（先跑 bin/unit.sh init napcat 或自动解包）；本地安装包。
# 输入：
#   --from <dir>   安装包目录（默认 /sdcard/Download/DSH-Go/napcat-install）
#   --qq <file>    QQNT 的 arm64 .deb（也在 --from 里找 *linuxqq*arm64*.deb）
#   --napcat <f>   NapCat 的 zip（也在 --from 里找 *NapCat*.zip）
# 失败：缺包 → 列出缺什么并退出 78（不猜、不联网乱下）。
# 副作用：写容器内 /opt/napcat、宿主 secrets 与配置。

MODDIR=${MODDIR:-/data/adb/modules/tinda-bot}
. "$MODDIR/bin/lib.sh"
ensure_dirs

FROM=/sdcard/Download/DSH-Go/napcat-install
QQ=""; NAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --qq) QQ="$2"; shift 2 ;;
    --napcat) NAP="$2"; shift 2 ;;
    *) echo "未知参数 $1"; exit 2 ;;
  esac
done

ROOTFS=$(conf_get NAPCAT_ROOTFS "$DATA/napcat/rootfs")
[ -d "$ROOTFS/usr" ] || { log error "容器未就绪：先执行 bin/napcat.sh init"; exit 78; }

[ -n "$QQ" ] || QQ=$(ls "$FROM"/*linuxqq*arm64*.deb 2>/dev/null | head -1)
[ -n "$NAP" ] || NAP=$(ls "$FROM"/NapCat*.zip "$FROM"/*napcat*.zip 2>/dev/null | head -1)

miss=""
[ -f "$QQ" ] || miss="$miss\n  QQNT arm64 deb（*linuxqq*arm64*.deb）"
[ -f "$NAP" ] || miss="$miss\n  NapCat 压缩包（NapCat*.zip）"
if [ -n "$miss" ]; then
  log error "缺少安装包，请放到 $FROM/：$miss"
  exit 78
fi

log info "QQNT: $QQ"
log info "NapCat: $NAP"

mkdir -p "$ROOTFS/opt/napcat" "$ROOTFS/tmp/install"
cp -f "$QQ" "$ROOTFS/tmp/install/qq.deb"
cp -f "$NAP" "$ROOTFS/tmp/install/napcat.zip"

mountpoint -q "$ROOTFS/proc" || mount -t proc proc "$ROOTFS/proc" 2>/dev/null
mount -o bind /dev "$ROOTFS/dev" 2>/dev/null
mount -o bind /sys "$ROOTFS/sys" 2>/dev/null
cp /etc/resolv.conf "$ROOTFS/etc/resolv.conf" 2>/dev/null || true

log info "容器内安装依赖（apt）"
chroot "$ROOTFS" /bin/bash -lc '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq unzip libgbm1 libasound2t64 libnss3 libxkbcommon0 libxdamage1 \
      libxcomposite1 libxrandr2 libatk1.0-0t64 libcups2t64 libdrm2 libxfixes3 \
      fonts-noto-cjk ca-certificates >/dev/null 2>&1 || true
  dpkg -i /tmp/install/qq.deb >/dev/null 2>&1 || apt-get install -y -f -qq >/dev/null 2>&1
  rm -rf /opt/napcat/app && mkdir -p /opt/napcat/app
  unzip -q -o /tmp/install/napcat.zip -d /opt/napcat/app
' || { log error "容器内安装失败，看 docs/napcat-安装.md"; exit 1; }

# 写启动入口：优先用 NapCat 自带的 shell 启动器
chroot "$ROOTFS" /bin/bash -lc '
cat > /opt/napcat/start.sh <<"SH"
#!/bin/bash
set -e
cd /opt/napcat/app
if [ -x ./napcat.sh ]; then exec ./napcat.sh; fi
if [ -f ./napcat.mjs ]; then exec node ./napcat.mjs; fi
exec node ./app.mjs
SH
chmod +x /opt/napcat/start.sh
'

log info "安装完成：$ROOTFS/opt/napcat"
log info "下一步：bin/napcat.sh start，然后扫容器日志里的二维码"
