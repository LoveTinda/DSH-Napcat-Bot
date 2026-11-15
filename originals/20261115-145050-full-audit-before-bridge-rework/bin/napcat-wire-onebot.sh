#!/system/bin/sh
# 目的：把 NapCat 的 OneBot 11 网络配置接到桥接器——开 HTTP API（给回发用）+ HTTP 事件推送（给收消息用）。
# 边界：只改 /opt/napcat/config/onebot11_<uin>.json 的 network 段；不动 QQ 登录、不动别的配置。
# 输入：$DATA/secrets/napcat.token（没有就生成 24 位十六进制），端口取 NAPCAT_HTTP_PORT / BRIDGE_LISTEN。
# 失败：找不到 onebot11_<uin>.json（说明还没登录过）→ 78；写文件失败 → 78。
# 副作用：写 onebot11 配置与 token 文件（0600）。改完必须重启 NapCat 才生效，本脚本不重启。

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
. "$MODDIR/bin/lib.sh"
ensure_dirs

NAP_CONFIG=${NAP_CONFIG:-/opt/napcat/config}
API_PORT=$(conf_get NAPCAT_HTTP_PORT 3001)
BRIDGE_LISTEN=$(conf_get BRIDGE_LISTEN 127.0.0.1:6700)
TOKEN_FILE="$DATA/secrets/napcat.token"

[ -d "$NAP_CONFIG" ] || { log error "没有 $NAP_CONFIG（NapCat 没装或没跑过）"; exit 78; }

NODE="$MODDIR/bin/node"; [ -x "$NODE" ] || NODE=$(command -v node)
[ -n "$NODE" ] || { log error "缺 node"; exit 78; }

NAP_CONFIG="$NAP_CONFIG" API_PORT="$API_PORT" BRIDGE_LISTEN="$BRIDGE_LISTEN" TOKEN_FILE="$TOKEN_FILE" \
"$NODE" -e '
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const dir = process.env.NAP_CONFIG;
const tokenFile = process.env.TOKEN_FILE;
const apiPort = Number(process.env.API_PORT || 3001);
const listen = process.env.BRIDGE_LISTEN || "127.0.0.1:6700";
const host = listen.split(":")[0], port = Number(listen.split(":")[1] || 6700);

fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
let token = "";
try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch {}
if (!token) {
  token = crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
}

const files = fs.readdirSync(dir).filter((f) => /^onebot11_\d+\.json$/.test(f));
if (!files.length) { console.error("没有 onebot11_<uin>.json：先在面板里扫码登录一次"); process.exit(78); }

for (const f of files) {
  const p = path.join(dir, f);
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  cfg.network = cfg.network || {};
  cfg.network.httpServers = [{
    name: "tinda-api", enable: true, port: apiPort, host: "127.0.0.1",
    enableCors: true, enableWebsocket: false, messagePostFormat: "array", token, debug: false,
  }];
  cfg.network.httpClients = [{
    name: "tinda-bridge", enable: true, url: `http://${host}:${port}/`,
    messagePostFormat: "array", reportSelfMessage: false, token: "", debug: false,
  }];
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  console.log("已写 " + p);
}
' || exit 78

log info "OneBot 已接好：HTTP API 127.0.0.1:$API_PORT，事件推送 → $BRIDGE_LISTEN"
log info "重启 NapCat 后生效：bin/unit.sh restart napcat（或 bin/napcat-start-host.sh）"
