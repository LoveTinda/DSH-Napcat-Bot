/**
 * 目的：把配置里可以变的内部端口（admin / panel）换成真正绑得上的那个。
 *       真机上出现过旧实例残留占着 6701/6702，新实例一启动就「管理端口已被占用」直接退出，
 *       表面上就是「服务起了但 6700 从不监听」。
 * 边界：只改 admin.port / panel.port；不动 onebot.listenPort（那是 NapCat 推过来的契约）。
 * 依赖：node:fs / node:net；被 bin/app-boot 在 guest 里调用。
 * 失败：端口全被占就原样保留，交给应用自己报错；本脚本不抛、总是 exit 0。
 */
import fs from 'node:fs';
import net from 'node:net';

const file = process.argv[2];
if (!file) process.exit(0);

const HOST = '127.0.0.1';

/** 目的：判断某个端口现在能不能绑。 */
function canBind(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, HOST, () => s.close(() => resolve(true)));
  });
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error('[bridge] 读不了配置，跳过端口检查：' + e.message);
  process.exit(0);
}

const used = new Set();
for (const key of ['admin', 'panel']) {
  const sec = cfg[key];
  if (!sec || !Number.isInteger(sec.port)) continue;
  const orig = sec.port;
  let port = orig;
  // 选过的端口要记住：两段都往后挪时不能挪到同一个号上（否则运行期还是撞）。
  for (let i = 0; i < 40; i += 1) {
    if (!used.has(port) && (await canBind(port))) break;
    port += 1;
  }
  used.add(port);
  if (port !== orig) {
    sec.port = port;
    console.error('[bridge] ' + key + ' 端口 ' + orig + ' 被占用，改用 ' + port);
  }
}

try {
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
} catch (e) {
  console.error('[bridge] 写回配置失败：' + e.message);
}
process.exit(0);
