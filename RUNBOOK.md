# RUNBOOK —— 运维手册（按当前真实流程写）

> 这份文档描述的是**这台机器上现在正在跑的东西**，不是设计意图。
> 每条命令都实际跑过，输出贴在下面；对不上就说明环境变了，先查再改。
> 最后复查时间：2026-11-15。

## 0. 先搞清楚跑在哪

| 形态 | 判据 | MODDIR | DATA |
| --- | --- | --- | --- |
| Magisk 模块 | `/data/adb/modules/tinda-bot` 存在 | `/data/adb/modules/tinda-bot` | `/data/adb/tinda-bot` |
| 仓库内直跑（当前） | 上面的路径不存在 | 仓库目录 | 仓库里的 `.runtime/` |

判定逻辑在 `bin/lib.sh`：看路径在不在，不靠用户名猜。

**当前事实**：这台手机没有 root，项目跑在 DSH App 的 Ubuntu（proot）里，
所以 `MODDIR=/root/workspace/tinda-bot`、`DATA=/root/workspace/tinda-bot/.runtime`。
所有命令都在仓库目录下执行，不需要 `su -c`。

## 1. 三个进程 + 一个外部

| 单元 | 是什么 | 怎么起 |
| --- | --- | --- |
| `napcat` | QQ + NapCat 注入同一进程 | `bin/napcat-start-host.sh` |
| `bridge` | 桥接器（OneBot 入口 + DSH 后端 + 面板） | `bin/run-bridge.sh` |
| `web` | 统一网关（8443 控制台 + 8444 DSH + 8445 NapCat） | `bin/run-web.sh` |
| `dsh` | 外部单元：DSH 自己托管，模块只探活 | 不拉起 |

启动顺序：`napcat` → `bridge` → `web`（后面的要连前面的端口）。

## 2. 日常命令

```sh
bin/unit.sh start|stop|restart|status|logs <单元> [行数]
```

实测输出：

```console
$ sh bin/unit.sh status napcat
napcat: running pid=28265
$ sh bin/unit.sh status bridge
bridge: running pid=31860
$ sh bin/unit.sh status web
web: running pid=31239
$ sh bin/unit.sh status dsh
dsh: running (external, http://127.0.0.1:3080 可连)
```

日志：

```sh
sh bin/unit.sh logs bridge 20
sh bin/unit.sh logs web 20
```

注意 `start` 内部是「起一个看守子进程 + 失败退避重启」，PID 文件里放的是看守进程的 pid，
真正的 node 在 `$DATA/run/<单元>.pid.child`。`stop` 会同时清掉两个。

## 3. 一条命令看通没通

```sh
sh bin/doctor.sh
```

它按顺序查：环境 → 配置（缺键/旧键/权限）→ 暴露面（回环/token）→ 目录与 0600 权限 →
证书 SAN → 四个单元 → 配置里的所有端口 → OneBot 登录态 → 桥接器面板 → 网关状态 →
最新备份 → git 工作区 → 各单元最近错误。任何一项 FAIL 退出码为 1；warn 不阻断。

成功时末尾是：

```console
ok    OneBot uid=<QQ号> nick=<QQ昵称>
ok    ok backend=headless 收到=4 成功=3 失败=1 跳过=3
ok    网关 {"dsh":true,"bridge":true,"napcat":true}

结论：主要链路都通
```

旧版 `.runtime/etc/tinda.conf` 会显示一堆「未知配置键」——那是重写前的键残留，
代码不读它们；`bin/lib.sh` 只会补新键，不会删旧键。清理时按清单手工删，别直接覆盖整份配置。

## 4. 首次从零装起来

前提：Ubuntu（proot）里已有 node 24、python3、xvfb、unzip、openssl。

### 4.1 装 QQ + NapCat（宿主直装，不用容器）

```sh
sh bin/napcat-install-host.sh
```

它做五件事：

1. 从 `/sdcard/Download/DSH-Go/napcat-install/*linuxqq*arm64*.deb` 解出 QQ 到 `/opt/QQ`
2. 从 `NapCat*.zip` 解到 `/opt/napcat`
3. **注入**：备份 `package.json` 为 `.tinda-orig`，写 `tinda-launcher.js`，把 `main` 指过去
4. 写 `/opt/napcat/start-tinda.sh`（只转发到 `bin/napcat-start-host.sh`）
5. 提示下一步（起服务、扫码、接 OneBot）

> `gnutls-shim.so` 现在**不需要**：QQ 3.2.34 下不加 preload 也能起。
> 只有在日志里看到 `libbugly.so: undefined symbol: gnutls_free` 时才要补这个 shim。

**为什么必须注入**：NapCat 的 `wrapper.node` 依赖 QQ 可执行文件导出的
`qq_magic_napi_register`，单独 `node napcat.mjs` 会 `undefined symbol`。
所以把 `/opt/QQ/resources/app/package.json` 的 `main` 指向 `tinda-launcher.js`，
由 QQ 主进程 `import('file:///opt/napcat/napcat.mjs')`。

### 4.2 起 NapCat 并登录

```sh
sh bin/unit.sh start napcat
sh bin/unit.sh logs napcat 60
```

日志里出现二维码后，用手机 QQ 扫（这一步必须本人）。

### 4.3 接 OneBot

```sh
sh bin/napcat-wire-onebot.sh
sh bin/unit.sh restart napcat
```

它往 `/opt/napcat/config/onebot11_<uin>.json` 写两段：

- `httpServers`：`127.0.0.1:3001`，token 取自 `$DATA/secrets/napcat.token`（0600，没有就生成）
- `httpClients`：事件推送到 `http://127.0.0.1:6700/`（桥接器）

`httpServers` 是桥接器**回发**消息用的；`httpClients` 是 NapCat **推送**消息用的。
两个都要有，否则「收得到发不出」或者相反。

### 4.4 起桥接器和网关

```sh
sh bin/unit.sh start bridge
sh bin/unit.sh start web
sh bin/doctor.sh
```

### 4.5 打开控制台

```
https://<局域网IP>:8443/?k=<$DATA/secrets/web.token>
```

第一次带 `?k=` 进来会种一个 **HttpOnly** cookie（`tinda`），之后标签页里的 iframe 靠它鉴权。
导航页脚本不读 token，也不会把 token 拼进 iframe 地址；地址栏里的 `?k=` 在页面加载后会被抹掉，
避免留在浏览器历史和 Referer 里。退出用导航页右上角的「退出」，它会让网关清 cookie。

## 5. 重启后不用重新扫码

`tinda-launcher.js` 会读 `/opt/napcat/config/onebot11_<uin>.json` 拿到 uin，
在导入 NapCat 前往 `process.argv` 补 `-q <uin>`。日志里出现：

```
正在快速登录  <QQ号>
[Notice] [OneBot11] [network] 配置加载
```

就说明免扫码续上了。想让某个账号优先，设 `NAPCAT_QUICK_LOGIN=<uin>`。

## 6. 桥接器每一轮怎么跑

1. NapCat 收到消息 → `POST http://127.0.0.1:6700/`（OneBot 11 事件）
2. 桥接器立刻回 204（不让上游超时重推），再把任务丢进该聊天的串行队列
3. 队列里 spawn `dsh headless --json --session-id <上轮 id> -`，任务走 stdin
4. 取最后一段助手文本，走 `POST http://127.0.0.1:3001/send_private_msg|send_group_msg`
5. 会话 id 落盘到 `$DATA/state/bridge/sessions.json`，下一轮续接

**为什么能不用 API key**：headless profile 默认关掉了交互式凭据库和账号插件
（上游假设一次性任务用启动时给的 `DEEPSEEK_API_KEY`），本机只有 App 的账号登录态。
`$DSH_HOME/profiles/headless/cordis.patch.yml` 里把 `credentials` / `authorization` /
`deepseek-account` 重新打开、默认模型指到 `deepseek-account`，就能复用同一份登录态。
详见 `docs/配置说明.md` §8。

自测这条链路（不碰 QQ）：

```sh
printf '只回四个字：测试成功' | node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless --json -
```

## 7. 面板上能看到什么

`https://<IP>:8443/` 是导航页，三个标签：

| 标签 | 实际地址 | 说明 |
| --- | --- | --- |
| 桥接器 | `/bridge/` | 概览/会话/事件/只读配置，页面相对取 `state.json`，2 秒轮询；可暂停 |
| DSH | `https://<IP>:8444/` | **进不去**，见下 |
| NapCat | `https://<IP>:8445/` | 真实 WebUI，扫码、看日志、改配置都在这 |

DSH 那格显示一页说明而不是空白：它的网页端有一把每次启动随机生成、只存在内存里的授权串，
只认自己打印的链接，网关替它签不了。这不是坏了。

面板的路由/状态字段/错误态见 [docs/Bridge面板.md](docs/Bridge面板.md)；网关的鉴权与反代规则见
[docs/网关.md](docs/网关.md)。

桥接器面板的 `/panel/state.json` 和 `/state.json` 是同一份只读快照；页面在 `/panel/` 下用
相对路径 `state.json`，在 `/bridge/` 前缀下由网关转发到 `/state.json`，两种挂载都不会 404。
面板不做写操作：改 `BRIDGE_BACKEND` 等配置请编辑 `$DATA/etc/tinda.conf`，再
`sh bin/unit.sh restart bridge`。

概览里的「待补发」和「告警接收」是这一段新加的两块：前者是发不出去、等网络恢复的回复条数
（来源 `state/bridge/outbox.json`，面板不提供重发/删除按钮）；后者显示打码后的 `ALERT_QQ`
与已发告警条数，没配时显示「未设置」，此时连续失败/磁盘告警都不会发。

## 8. 改完代码必须做的事

```sh
MODDIR=$PWD sh bin/check-headers.sh        # 头注释齐全
MODDIR=$PWD sh bin/check-independence.sh   # 单元之间不互相 import
MODDIR=$PWD sh bin/check-contracts.sh      # 契约检查；当前会如实告警「未实现」
node units/bridge/test-panel.mjs           # 面板/事件/会话
node units/bridge/test-headless.mjs        # DSH 适配与会话恢复
node units/web/test-gateway.mjs            # 网关鉴权/cookie/反代
git add -A && git commit                  # 提交信息写清 为什么/改动/验证
sh bin/backup-to-sdcard.sh                 # 落一份完整备份到 /sdcard/backup/
git push origin main                      # 22 端口被墙，~/.ssh/config 已映射到 443
```

实测：

```console
$ sh bin/backup-to-sdcard.sh
OK /sdcard/backup/tinda-bot-v0.2.18-20261115-150909
   515 个文件，5.5M
```

## 8.5 备份组成与恢复

每次更新后的备份目录长这样（数字是实测值）：

| 部分 | 文件数 | 是什么 |
| --- | --- | --- |
| `.git/` | 约 32（gc 后） | git 历史；不 gc 会有 400+ 个散对象小文件 |
| `originals/` | 约 290+ | 原文件快照，只读，永不改；每跑一次 `snapshot.sh` 就多一份 |
| 真正项目文件 | 约 65 | 脚本、单元、文档、契约、模板 |
| `repo.bundle` | 1 | 单文件仓库快照，约 210KB |
| `SHA256SUMS` | 1 | 校验和 |

所以「备份有几百个文件」不代表项目变胖了，**大头是历史和快照**。
`.runtime/`（含 700MB 的 NapCat rootfs 与 secrets）永远不进备份。

恢复两种方式：

```sh
# 方式一：整目录已经在，直接用（/sdcard 是 FUSE 挂载，git 会报 dubious ownership）
git config --global --add safe.directory /sdcard/backup/tinda-bot-<版本>-<时间>
cd /sdcard/backup/tinda-bot-<版本>-<时间> && git status

# 方式二：从单文件 bundle 还原（不受 ownership 限制，推荐）
git clone /sdcard/backup/tinda-bot-<版本>-<时间>/repo.bundle ~/tinda-restored
```

方式二实测：`git clone` 出 194 个文件、最后一条提交正确。

## 9. 排障对照表

| 现象 | 先看这里 | 常见原因 |
| --- | --- | --- |
| 控制台 401 | `doctor.sh` 的「网关」项 | 端口上跑的是旧实例，token 和 `secrets/web.token` 不一致；`stop` 后重起 |
| 控制台一直弹 token | 地址栏有没有 `?k=`；`curl` 看 `set-cookie` 是否带 HttpOnly | token 里有特殊字符时会被编码；重新用 `?k=` 进一次，或检查网关是否还是旧版本 |
| 桥接面板 502 | `unit.sh status bridge` / `logs bridge` | 网关的 `BRIDGE_PANEL_PORT` 是从 `BRIDGE_LISTEN` 推导的；桥接器没起或端口不一致 |
| 桥接面板能开但数字不动 | 浏览器控制台 Network | 页面取的是相对 `state.json`；确认 `/bridge/state.json` 返回 200，不是 401/404 |
| 面板一片空白 | 浏览器开 8445 直接访问 | 前端写死绝对路径 `/webui/assets`、`/api/…`，必须走独立端口 |
| NapCat 面板登录失败 | `POST /api/auth/login` 的 `hash` | 少了 `?token=` 会白屏、多了会让 login 直接 Unauthorized；网关只给页面补 |
| QQ 掉线 | `unit.sh logs napcat` 有没有「快速登录」 | 没注入 `-q`，退化成扫码 |
| 桥接器收到不回复 | `logs bridge` | DSH 报 `MISSING_CREDENTIAL` / `ACCOUNT_SIGN_IN_REQUIRED`，查配置说明 §8 的 patch |
| 回复发不出去 | `3001/get_status` | `httpServers` 没开，或 `secrets/napcat.token` 和 NapCat 里写的不一致 |
| 回复晚了 / 事后才到 | 面板概览的「待补发」 | 3001 抖过：桥接器已把回复放进 `state/bridge/outbox.json`，恢复后按 `BRIDGE_SEND_DRAIN_MS` 补发；看事件里的「补发成功」 |
| 机器人答非所问 / 上下文串了 | 面板「会话」页看 sessionId；私聊发 `/session` | 会话续接错了或重启后补推旧消息；先发 `/reset` 重开，再看 `state/bridge/seen.json` 有没有在增长 |
| 一个问题收到两条回答 | 面板事件的「重复推送」 | NapCat 超时重推；同 `message_id` 已被去重。仍重复说明事件里没有 `message_id`，查 NapCat 的 `messagePostFormat` |
| 手机没收到告警 | `grep ^ALERT_QQ .runtime/etc/tinda.conf` | 空 = 关；或同类告警还在 `ALERT_COOLDOWN_SEC` 冷却窗口里（面板「告警接收」会显示被压次数） |
| 刷了模块但服务没起 | `su -c 'tail -50 /data/adb/tinda-bot/logs/module.log'` | 日志里有「形态 / rootfs / node / 每个单元结果」；缺 node 或 rootfs 会明说。再跑 `unit.sh explain <单元>` 看走 exec 还是 chroot |
| 待补发一直不降 | `unit.sh logs bridge 40` 里 `fail:send` | 3001 一直连不上；先修 NapCat，再等轮询。过期（`BRIDGE_OUTBOX_TTL_MS`）会自动丢弃并记事件 |
| 起了两个同样的进程 | `doctor.sh` 端口项 | 旧实例没停干净；`unit.sh stop` 只认自己 pid，手起的要先手动 kill |

## 10. 硬性约束

1. `$DATA/secrets/` 下都是 0600，不进 git；`sessions.json` 只存 chatKey → 会话 id，不存聊天正文
2. 面板事件流只记「哪个聊天、多久、成没成、几个字」，失败备注会脱敏并截断，不记内容
3. 同一个 QQ 号不要起两个 NapCat
4. 桥接面板是只读的；不要给它加写接口，除非先解决「本机任意进程可直连 6700」的鉴权问题
4. 改 `/opt` 下的东西（launcher、OneBot 配置）在 git 里没有痕迹，所以每个动作都要有脚本：
   `bin/napcat-start-host.sh`、`bin/napcat-wire-onebot.sh` 就是为此存在
