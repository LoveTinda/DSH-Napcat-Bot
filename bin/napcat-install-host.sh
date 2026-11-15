#!/system/bin/sh
# 目的：在 **proot 宿主环境内直接** 安装 QQNT + NapCat（不走 chroot 容器），并写好启动入口。
# 边界：不改桥接器、不登录账号（扫码必须人工）、不联网下载（安装包必须已在本机）。
# 输入：--from <目录> 安装包目录（默认 /sdcard/Download/DSH-Go/napcat-install），
#       目录里需有 *linuxqq*arm64*.deb 与 NapCat*.zip；也可用 --qq / --napcat 指定。
# 失败：缺包/架构不对/解不开 → 78，并说明缺什么。
# 副作用：写 /opt/QQ（QQNT 本体）、/opt/napcat（NapCat）、$DATA/etc、$DATA/logs。

set -u

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
DATA=${DATA:-$MODDIR/.runtime/data}
. "$MODDIR/bin/lib.sh"

FROM=/sdcard/Download/DSH-Go/napcat-install
QQ=""; NAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift 2 ;;
    --qq) QQ="$2"; shift 2 ;;
    --napcat) NAP="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

[ -n "$QQ" ] || QQ=$(ls "$FROM"/*linuxqq*arm64*.deb 2>/dev/null | head -1)
[ -n "$NAP" ] || NAP=$(ls "$FROM"/NapCat*.zip "$FROM"/*napcat*.zip 2>/dev/null | head -1)

miss=""
[ -f "$QQ" ] || miss="$miss"$'\n'"  QQNT arm64 deb（*linuxqq*arm64*.deb）"
[ -f "$NAP" ] || miss="$miss"$'\n'"  NapCat 压缩包（NapCat*.zip）"
if [ -n "$miss" ]; then
  log error "缺少安装包，请放到 $FROM/：$miss"
  exit 78
fi

log info "QQNT：$QQ"
log info "NapCat：$NAP"

# 1) 校验 QQ 包架构，装错了要到运行期才炸，这里先拦住
ARCH=$(dpkg-deb -f "$QQ" Architecture 2>/dev/null)
[ "$ARCH" = "arm64" ] || { log error "QQ 包架构是 ${ARCH:-未知}，需要 arm64"; exit 78; }

# 2) 解 QQNT 到 /opt/QQ（deb 自带目录结构，直接解到 / 即可）
log info "解包 QQNT 到 /opt/QQ"
mkdir -p /opt
TMPD=$(mktemp -d) || exit 78
trap 'rm -rf "$TMPD"' EXIT INT TERM
dpkg-deb -x "$QQ" "$TMPD" || { log error "QQ 包解不开"; exit 78; }
[ -d "$TMPD/opt/QQ" ] || { log error "QQ 包里没有 opt/QQ，包结构不对"; exit 78; }
rm -rf /opt/QQ
cp -a "$TMPD/opt/QQ" /opt/QQ || { log error "复制到 /opt/QQ 失败"; exit 78; }
# 依赖库和 desktop 文件一起带过来（缺了运行期才报错）
[ -d "$TMPD/opt" ] && cp -a "$TMPD/opt/." /opt/ 2>/dev/null
chmod +x /opt/QQ/qq 2>/dev/null

# 3) 解 NapCat 到 /opt/napcat
log info "解包 NapCat 到 /opt/napcat"
rm -rf /opt/napcat.new
mkdir -p /opt/napcat.new
command -v unzip >/dev/null 2>&1 || { log error "缺 unzip（先 apt-get install -y unzip）"; exit 78; }
unzip -q -o "$NAP" -d /opt/napcat.new || { log error "NapCat 压缩包解不开"; exit 78; }
# 有的包里套一层目录，扁平化
if [ ! -f /opt/napcat.new/napcat.mjs ] && [ -d /opt/napcat.new/NapCat.Shell ]; then
  mv /opt/napcat.new/NapCat.Shell/* /opt/napcat.new/ 2>/dev/null
  rmdir /opt/napcat.new/NapCat.Shell 2>/dev/null
fi
[ -f /opt/napcat.new/napcat.mjs ] || { log error "NapCat 包里没有 napcat.mjs"; exit 78; }
rm -rf /opt/napcat
mv /opt/napcat.new /opt/napcat
chmod +x /opt/napcat/*.sh 2>/dev/null

# 4) 启动入口：无显示器环境必须套 xvfb-run，否则 QQ 起不来
cat > /opt/napcat/start-tinda.sh <<'EOS'
#!/bin/sh
# 目的：无头环境启动 NapCat（Xvfb 提供虚拟显示）。由单元管理器拉起，不重试。
# 失败：非 0 退出即由 supervisor 退避重启。
set -u
cd /opt/napcat || exit 78
export HOME=/opt/napcat
export NODE_OPTIONS=
exec xvfb-run -a -s "-screen 0 1280x800x24" /usr/bin/env node napcat.mjs "$@"
EOS
chmod +x /opt/napcat/start-tinda.sh

log info "安装完成：/opt/QQ + /opt/napcat"
log info "下一步：bin/unit.sh start napcat，看日志里的二维码，扫码登录"
exit 0
