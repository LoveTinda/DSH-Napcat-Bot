# Tinda Bot

QQ ↔ DSH 桥接器，跑在 Android 上：NapCat 收消息，DSH 出回答，桥接器在中间搬运；
所有改动进 git，每次更新落一份完整备份到 `/sdcard/backup/`。

**现在能做什么**：QQ 私聊/群聊发消息 → 桥接器 → `dsh headless` → 回到 QQ；网页控制台看三个面板；
每轮续接同一个 DSH 会话。

**还没做什么**：`/output` 分档、完整 `/help` 命令表、群上下文注入、DSH 独立容器、Magisk 打包实测。

## 先读这两篇

- `docs/操作手册.md` —— 现在这台机器上怎么起、怎么查、怎么修（每条命令都实跑过）
- `docs/配置说明.md` —— 真的存在的配置项，以及端口表

## 目录

```
module.prop        模块声明（Magisk 形态用）
service.sh         开机按单元拉起
bin/               启动、看守、门禁、备份、安装、诊断
units/             单元：napcat / bridge / web / dsh，各自 unit.conf + 入口
contracts/         抽象接口契约（与 units/ 一一对应）
docs/              操作手册 / 配置 / 规范 / ADR
originals/         原文件快照（只读）
etc/               配置模板
```

`$DATA` 判定：`/data/adb/tinda-bot` 存在就是 Magisk 形态，否则用仓库内 `.runtime/`（当前是这种）。

## 三个地址

| 入口 | 用途 |
| --- | --- |
| `https://<局域网IP>:8443/?k=<web.token>` | 控制台：桥接器面板 / DSH / NapCat 三标签 |
| `https://<局域网IP>:8445/` | NapCat WebUI（独立端口，因为它的前端用绝对路径） |
| `https://<局域网IP>:8444/` | DSH 面板（进不去，显示说明页——它只认自己打印的授权链接） |

token 在 `$DATA/secrets/web.token`。

## 常用命令

```sh
sh bin/doctor.sh                 # 一条命令看通没通（单元/端口/OneBot/面板/网关/备份/git）
sh bin/unit.sh status web        # 单元状态：start|stop|restart|status|logs
sh bin/unit.sh logs bridge 40
sh bin/napcat-wire-onebot.sh     # 把 OneBot 接到桥接器（改完要重启 napcat）
sh bin/backup-to-sdcard.sh       # 完整备份到 /sdcard/backup/
```

改完代码的三道门：

```sh
MODDIR=$PWD sh bin/check-headers.sh
MODDIR=$PWD sh bin/check-independence.sh
MODDIR=$PWD sh bin/check-contracts.sh
```

## 远端

`git@github.com:LoveTinda/DSH-Napcat-Bot.git`（`main`）。到 GitHub 的 22 端口被阻断，
`~/.ssh/config` 已把 `github.com` 映射到 `ssh.github.com:443`，直接 `git push` 即可。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| `docs/操作手册.md` | 当前真实操作流程、排障对照表 |
| `docs/配置说明.md` | 配置文件、环境变量、端口、敏感文件 |
| `docs/napcat-安装.md` | QQ + NapCat 宿主直装、注入原理、常见坑 |
| `docs/编码规范.md` | 三条铁律、命名、提交信息格式 |
| `docs/独立性.md` | 单元之间为什么不能互相 import |
| `docs/生命周期.md` | 启动/退避重启/停止的语义 |
| `docs/安全模型.md` | token、权限、脱敏、边界 |
| `docs/生产就绪清单.md` | 上线前还差什么 |
| `docs/adr/` | 关键决策记录 |
| `docs/历史-变更记录.md` | 重写前那套 `config.json` 的记录（不再是当前实现） |
