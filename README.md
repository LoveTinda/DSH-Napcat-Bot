# Tinda Bot

QQ ↔ DSH 桥接器，跑在 Android 上：NapCat 收消息，DSH 出回答，桥接器在中间搬运；
所有改动进 git，每次更新落一份完整备份到 `/sdcard/backup/`。

**现在能做什么**：QQ 私聊/群聊发消息 → 桥接器 → `dsh headless` → 回到 QQ；
网页控制台看桥接器面板（概览 / 会话 / 事件 / 只读配置）；每轮续接同一个 DSH 会话；
回复发不出去时先重试、再进补发队列，NapCat/网络恢复后自动送达（同一 `message_id` 不重复回答）；
连续失败或磁盘将满会私聊告警给 `ALERT_QQ`。

已经补回来的旧行为：回复策略（白名单 / 群必须 @ / owner-admin）、`/help` 命令表（23 条）、
拟人化投递（分条 + 停顿）、群上下文注入、`/output` 四档、自动压缩、维护期自动回复。

**还没做什么**：`/ws` `/ls` `/model` `/effort` `/persona` `/balance` 这几条命令、
Magisk 真机实测（当前跑在 App 的 Ubuntu 里）、`contracts/` 与实现的收口。

## 先读这两篇

- [RUNBOOK.md](RUNBOOK.md) —— 现在这台机器上怎么起、怎么查、怎么修
- [docs/配置说明.md](docs/配置说明.md) —— 真的存在的配置项，以及端口表

## 目录

```
module.prop        模块声明（Magisk 形态用）
service.sh         开机按单元拉起
bin/               启动、看守、门禁、备份、安装、诊断（含 check-contracts.mjs）
units/             单元：napcat / bridge / web / dsh，各自 unit.conf + 入口
contracts/         抽象接口契约（目标形态，当前未实现，检查器会如实告警）
AGENTS.md          项目规范（人和 AI 的入口）
RUNBOOK.md         运维手册：起停、排障、复查
docs/              配置 / 安装 / 设计 / ADR / 历史
originals/         原文件快照（只读；现在包含 bin/ 与 units/ 全量）
etc/               配置模板
local/             设备/账号特化（不入 git）
```

`$DATA` 判定：`/data/adb/tinda-bot` 存在就是 Magisk 形态，否则用仓库内 `.runtime/`（当前是这种）。

## 端口与地址

| 入口 | 用途 |
| --- | --- |
| `https://<局域网IP>:8443/?k=<web.token>` | 控制台：桥接器 / DSH / NapCat 三标签 |
| `https://<局域网IP>:8444/` | DSH 面板（它只认自己打印的授权链接，这里给说明页） |
| `https://<局域网IP>:8445/` | NapCat WebUI（独立端口，因为它的前端用绝对路径） |
| `http://<局域网IP>:8088/` | 明文 301 → 8443（可关） |
| `http://127.0.0.1:6700/` | 桥接器面板 + OneBot 入口（只回环） |

token 在 `$DATA/secrets/web.token`。第一次带 `?k=` 进来时网关种一个 **HttpOnly** cookie，
脚本读不到 token；导航页也不会把 token 拼进 iframe 地址，避免留在历史记录和 Referer 里。

## 常用命令

```sh
sh bin/doctor.sh                 # 配置 / 单元 / 端口 / OneBot / 面板 / 网关 / 证书 / 备份 / git
sh bin/unit.sh status web        # 单元状态：start|stop|restart|status|logs
sh bin/unit.sh logs bridge 40
sh bin/napcat-wire-onebot.sh     # 把 OneBot 接到桥接器（改完要重启 napcat）
sh bin/backup-to-sdcard.sh       # 完整备份到 /sdcard/backup/
sh bin/check-module.sh           # Magisk 模块结构门禁（id/shebang/CRLF/service）
sh bin/make-module.sh            # 出可刷 zip → /sdcard/Download/DSH-Go/
sh bin/unit.sh explain bridge     # 这个单元会走 exec 还是 chroot（刷机前先看）
```

改完代码的门禁：

```sh
MODDIR=$PWD sh bin/check-headers.sh
MODDIR=$PWD sh bin/check-independence.sh
MODDIR=$PWD sh bin/check-contracts.sh   # 当前会如实告警「契约未实现」，不是通过
MODDIR=$PWD sh bin/check-deps.sh       # 只允许 node: 内置与相对路径（零第三方依赖）
node units/web/test-gateway.mjs
node units/bridge/test-panel.mjs
node units/bridge/test-alert.mjs
```

动手改代码前先跑 `bin/snapshot.sh "原因"`；它现在会把 `bin/`、`units/`、`contracts/` 也一起快照。

## 远端

`git@github.com:LoveTinda/DSH-Napcat-Bot.git`（`main`）。到 GitHub 的 22 端口被阻断，
`~/.ssh/config` 已把 `github.com` 映射到 `ssh.github.com:443`，直接 `git push` 即可。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [RUNBOOK.md](RUNBOOK.md) | 当前真实操作流程、排障对照表 |
| [docs/复查报告-2026-11-15.md](docs/复查报告-2026-11-15.md) | v0.2.18 全量复查：问题、修复、验证、残余风险 |
| [docs/Bridge面板.md](docs/Bridge面板.md) | 面板路由、状态 JSON、UI 行为、只读边界 |
| [docs/网关.md](docs/网关.md) | 鉴权流程、cookie、反代规则、失败模式 |
| [docs/配置说明.md](docs/配置说明.md) | 配置文件、环境变量、端口、敏感文件 |
| [docs/napcat-安装.md](docs/napcat-安装.md) | QQ + NapCat 宿主直装、注入原理、常见坑 |
| [AGENTS.md](AGENTS.md) | 三条铁律、命名、提交信息格式 |
| [docs/独立性.md](docs/独立性.md) | 单元之间为什么不能互相 import |
| [docs/生命周期.md](docs/生命周期.md) | 启动/退避重启/停止的语义 |
| [docs/安全模型.md](docs/安全模型.md) | token、权限、脱敏、边界 |
| [docs/生产就绪清单.md](docs/生产就绪清单.md) | 上线前还差什么 |
| [docs/安装-Magisk.md](docs/安装-Magisk.md) | 刷成 Magisk 模块：前提、出包、验证、运行时缺口 |
| [docs/接口与适配.md](docs/接口与适配.md) | 契约与实现的当前真实状态 |
| [docs/adr/](docs/adr/) | 关键决策记录 |
| [docs/历史-变更记录.md](docs/历史-变更记录.md) | 旧实现的记录（不再是当前实现） |
