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

# 4) 注入：把 QQ 的入口指向 tinda-launcher.js，由它在 QQ 主进程里 import NapCat。
#    没有这一步，NapCat 单跑会 `wrapper.node: undefined symbol: qq_magic_napi_register`。
APP_JSON=/opt/QQ/resources/app/package.json
LAUNCHER=/opt/QQ/resources/app/tinda-launcher.js
if [ -f "$APP_JSON" ]; then
  [ -f "$APP_JSON.tinda-orig" ] || cp -a "$APP_JSON" "$APP_JSON.tinda-orig"
  cat > "$LAUNCHER" <<'EOL'
// tinda-bot：QQ 主进程入口包装，负责把 NapCat 加载进同一个进程。
// 为什么要包一层：NapCat 的 wrapper.node 依赖 QQ 可执行文件导出的符号（qq_magic_napi_register），
// 只能从 QQ 主进程里加载，单独跑 node 会 undefined symbol。
const fs = require('fs');
const log = (m) => { try { fs.appendFileSync('/tmp/tinda-inject.log', new Date().toISOString() + ' ' + m + '\n'); } catch (e) {} };
log('launcher 启动');
require('./application.asar/app_launcher/index.js');
log('QQ 入口已加载');

// 快速登录：NapCat 只认命令行参数里的 -q <uin>；从 QQ 启动时拿不到，
// 所以按「已登录过的账号」补上去，免得每次重启都重新扫码。
function quickLoginUin() {
  if (process.env.NAPCAT_QUICK_LOGIN) return String(process.env.NAPCAT_QUICK_LOGIN).trim();
  try {
    const path = require('path');
    const dir = '/opt/napcat/config';
    return fs.readdirSync(dir)
      .map((f) => (f.match(/^onebot11_(\d+)\.json$/) || [])[1])
      .filter(Boolean)
      .map((u) => ({ u, t: fs.statSync(path.join(dir, 'onebot11_' + u + '.json')).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.u || '';
  } catch (e) { return ''; }
}

setTimeout(() => {
  const uin = quickLoginUin();
  if (uin && !process.argv.includes('-q')) {
    process.argv.push('-q', uin);
    log('注入快速登录 -q ' + uin);
  } else if (!uin) {
    log('没有可快速登录的账号，走扫码');
  }
  log('开始加载 NapCat');
  import('file:///opt/napcat/napcat.mjs')
    .then(() => log('NapCat 模块已导入'))
    .catch((e) => log('NapCat 导入失败: ' + (e && (e.stack || e.message))));
}, 2000);
EOL
  # main 指到 launcher（用 node 改 JSON，避免手写 JSON 出错）
  NODE_BIN="$MODDIR/bin/node"; [ -x "$NODE_BIN" ] || NODE_BIN=$(command -v node)
  "$NODE_BIN" -e '
const fs=require("fs");
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.main="./tinda-launcher.js";
fs.writeFileSync(p,JSON.stringify(j,null,2));
' "$APP_JSON" || { log error "改 $APP_JSON 失败"; exit 78; }
  log info "已注入：$APP_JSON main → ./tinda-launcher.js"
else
  log warn "没有 $APP_JSON，跳过注入（QQ 包结构变了？）"
fi

# 5) 启动入口：统一交给模块脚本，避免这里和 bin/napcat-start-host.sh 各写一份、慢慢走样。
#    关键点：NapCat 必须从 QQ 主进程里加载（wrapper.node 要 QQ 导出的符号），
#    所以不能 `node napcat.mjs` 单独跑。
cat > /opt/napcat/start-tinda.sh <<'EOS'
#!/bin/sh
# 目的：兼容旧的调用方；真正的启动逻辑在模块里。
set -u
exec sh /data/adb/modules/tinda-bot/bin/napcat-start-host.sh "$@"
EOS
chmod +x /opt/napcat/start-tinda.sh

log info "安装完成：/opt/QQ + /opt/napcat"
log info "下一步：bin/unit.sh start napcat，看日志里的二维码，扫码登录"
exit 0
