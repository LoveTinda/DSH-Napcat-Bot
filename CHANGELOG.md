# CHANGELOG

## v0.2.25
- **命令表（②）**：新增 `units/bridge/commands.mjs`，按旧机器人 `/help` 原文重建 23 条命令与别名
  （`/help /status /ping /new /stop /sessions /session /policy /notice` 已实现；
  `/context /ws /ls /model /effort /output /persona /balance` 标注「还没实现」；
  `/compact /export /feedback /goal /permission /plan` 原样透传给 DSH）
- 本地命令不进队列：`/stop` 才可能停掉正在跑的那一轮（排在队尾会永远等不到）
- 角色门槛：`/sessions all`、`/session use`、`/model`、`/effort`、`/output`、`/balance` 要 admin，
  `/permission` 只有 owner；不够就回「没有权限 + 当前角色」
- 不认识的 `/xxx` 有回执，不再沉默；命令一律不进模型（`/` 开头必不成为对话内容）
- 面板新增「命令」计数与「常用命令」；`snapshot()` 暴露 `commands.total/top`
- 文档：`docs/命令表-help原文.md` 补「实现状态」表；自测 `test-commands.mjs` 18 项 +
  `test-commands-wire.mjs` 19 项

## v0.2.24
- **回复策略（①/⑤ 的第一项）**：新增 `units/bridge/policy.mjs`，移植自旧桥接器完整救回的
  `src/policy.js`（白名单、群必须 @、owner/admin 分级、空白名单即拒绝、危险默认拒绝启动）
- 接入事件入口：自己 → 用户白名单 → 群白名单/模式 → 是否 @，被拒只记元信息不回消息
- 群里「只 @ 不写字」不再被当成空消息丢掉（会交给策略判定，避免 @ 了没反应）
- 面板新增「回复策略 / 策略来源 / 被拒原因」与「策略拒绝」计数；`doctor.sh` 加一段策略检查，
  未加固会 warn（谁都能触发）
- 配置：`BRIDGE_POLICY_FILE`（缺省 `$DATA/etc/bridge-policy.json`），模板 `etc/bridge-policy.example.json`；
  文件不存在用默认策略（私聊全接 + 群必须 @，标未加固），不阻断启动
- 自测：`test-policy.mjs` 24 项（纯函数）+ `test-policy-wire.mjs` 18 项（真起桥接器走一遍）

## v0.2.23
- **修「重启后答非所问」**：新增 `BRIDGE_MAX_EVENT_AGE_SEC`（默认 120 秒）——NapCat 断线重连会把
  积压事件补推上来，以前会在重启后一串回答十几分钟前的消息，看着像乱答；现在超过 2 分钟的旧事件
  直接记 skip、不回答
- **去重跨重启**：已处理的 `message_id` 落盘到 `state/bridge/seen.json`（最近 500 条），
  以前只在内存里，桥接器一重启就可能把同一条再答一遍
- **自助恢复会话**：私聊发 `/reset` 清掉该聊天的 DSH 会话映射、`/session` 查当前 session id；
  群聊不响应（避免任何人重置大家的会话）
- **测试**：`test-roundtrip` 18 → 22（控制命令 3 项、过期事件 1 项）

## v0.2.22
- **rootfs 复制模式**：`magisk-provision.sh --from` 默认用 tar 管道**复制**（新 inode，
  排除 `proc/dev/sys/sdcard/data`，保留符号链接与权限），`--link` 才用硬链接克隆。
  这样可以直接把这台手机 App 里装好的 Ubuntu（含 node/DSH/QQ 登录态）复制成模块的 rootfs，
  不用重新 apt/npm，也不怕两边互相改文件
- **日志更准**：`service.sh` 有 rootfs 时检查 rootfs 里的 node（而不是 Android PATH 的），
  开机日志能直接看出「rootfs 里没 node」；`unit.sh` 缺 `chroot` 命令时明确报错
- **文档**：安装文档给出直接复用手机现有环境的命令（7.7G、几分钟）、路径变化时怎么查、
  以及「proot 与模块两套不要同时占 8443」

## v0.2.21
- **chroot 落地**：单元改 `TYPE=auto` —— Android root 且有 `/data/adb/tinda-bot/rootfs/usr`
  才走 chroot，否则宿主直装；chroot 前把 `/data/adb`、`/sdcard`、`/proc`、`/dev`、`/sys`
  挂进去，代码/配置/日志/状态仍是 Android 侧那一份
- **rootfs 供给**：新增 `bin/magisk-provision.sh`（`--check` / `--from` / `--tarball`）：
  不带 `.sha256` 的 tar 包默认拒绝，非空 rootfs 默认拒绝覆盖；解包后打印装 node/dsh 的命令
- **可观测**：新增 `unit.sh explain <单元>`（打印 exec 还是 chroot），`service.sh` 重写为
  自带初始化 + 写 `$DATA/logs/module.log`（含形态、rootfs、node、每个单元的启动结果），
  不再依赖 `customize.sh`（KernelSU/SukiSU 不保证执行它）
- **模块门禁**：`check-module.sh` 增加 `unit.conf` 的 `TYPE` 校验与 `module.log` 检查
- **文档**：安装文档补 KernelSU/SukiSU 的 `ksud module install` 与 rootfs 三节；ADR-0005 补「落地」

## v0.2.20
- **Magisk 形态补齐**：修掉 `bin/lib.sh` 的数据目录判定 bug —— 以前首次安装时
  `/data/adb/tinda-bot` 还不存在，状态会落进模块目录，升级即丢；现在按模块自身路径
  （`/data/adb/modules/*`）直接认 `/data/adb/tinda-bot`
- **可刷性检查**：新增 `bin/check-module.sh`（module.prop 字段/id/versionCode、shebang、
  可执行位、CRLF、`service.sh` 是否真拉单元、有无自带 node），带 `--selftest` 反向用例；
  `customize.sh`/`uninstall.sh` 补 shebang，脚本统一 0755
- **出包**：新增 `bin/make-module.sh`，只打运行需要的 69 个文件（不含 `.runtime/.git/originals/local`），
  产出 `/sdcard/Download/DSH-Go/tinda-bot-v0.2.20-magisk.zip` + `.sha256`，并 `unzip -t` 校验
- **文档**：新增 [docs/安装-Magisk.md](docs/安装-Magisk.md)（前提、刷入、验证、卸载、回滚）与
  [ADR-0005](docs/adr/0005-magisk形态与chroot.md)（为什么模块只管生命周期、Linux 栈放 chroot）；
  清单 S-1/S-4 仍如实标 ⚠️：真机 root 与运行时来源都没验
- 说明：本机是 App 内 proot（无 `/data/adb`、无 `getprop`），只能「按模块格式准备好」，
  刷入与开机自启必须在真机 root 环境完成

## v0.2.19
- **T-4 资源上限**：桥接器/网关按配置设 V8 堆上限（`BRIDGE_HEAP_MB=256` / `WEB_HEAP_MB=192`，
  夹在 64–2048），node 单元 fd 软上限 `UNIT_MAX_OPEN_FILES=4096`；`doctor.sh` 新增
  「资源与依赖」段，直接读 `/proc/<pid>/cmdline` 与 `limits` 核对「实际生效」，
  而不是看配置里写了什么（PID 文件里是看守 shell，不是 node，这一点也一并修了）
- **T-8 断网补发 + 去重**：回复发不出去先原地退避重试（`BRIDGE_SEND_RETRY`），仍失败进
  `$DATA/state/bridge/outbox.json`（0600、最多 100 条、`BRIDGE_OUTBOX_TTL_MS` 过期丢弃），
  恢复后按 `BRIDGE_SEND_DRAIN_MS` 自动补发；NapCat 重推同一 `message_id` 只回答一次（窗口 500 条）
- **O-4 告警**：连续失败（`ALERT_FAIL_STREAK`）与磁盘占用（`DISK_ALERT_PERCENT`）可推到
  `ALERT_QQ` 私聊，同一类按 `ALERT_COOLDOWN_SEC` 节流；判定抽到 `units/bridge/alerts.mjs`，
  面板显示「已发/被压/最近一次」，`doctor.sh` 也报数据分区占用
- **S-9 依赖锁定**：新增 `bin/check-deps.mjs` + `bin/check-deps.sh`，只允许 `node:` 内置与
  相对路径；出现 `node_modules` / `dependencies` / 裸模块名即失败，已装进 pre-commit 与
  `doctor.sh`。本仓库零第三方依赖，因此没有 lockfile 与 `npm audit` 可做（没有依赖可审计）
- **面板**：概览新增「待补发」卡片与告警/磁盘信息行；配置新增「回发与告警」组；
  事件流记录「回复已入补发队列」「补发成功 / 超时丢弃」
- **配置清理**：运行态 `tinda.conf` 删掉 13 个旧键（`PORT_MODE` / `NODE_MAX_OLD_SPACE_MB` /
  `NAPCAT_WS_*` 等，代码不读），原文件备份为 `.bak-<时间戳>`；`snapshot.sh` 修掉
  「原因里带斜杠导致快照嵌进多层目录」的问题
- **测试**：`test-roundtrip` 11 → 18（重试、去重、补发）；新增 `test-alert` 9 项；
  合计 78 项全过；README / RUNBOOK / 配置说明 / Bridge 面板 / 生产就绪清单 / 安全模型 / AGENTS 同步

## v0.2.18
- 文档：新增《v0.2.18 全量复查报告》《Bridge 面板》《网关》，把问题清单、路由/状态契约、
  鉴权流程、失败模式与残余风险写成可查文档；生命周期补 `unit.sh stop` 的进程树语义
- **Bridge 面板重做**：会话/事件改成手机优先卡片（不再用需要横向滚动的表格）；
  配置页按组展示只读键值；事件支持成功/失败/跳过筛选；补手动刷新、自动刷新暂停、
  离线/401/超时错误条；会话 id 可复制；增加“跳过”计数与事件
- **修面板真实 bug**：页面直接开 `/panel/` 时，原代码会去取 `/panel/panel/state.json` 而永远
  连不上；现在页面相对取 `state.json`，桥接器同时提供 `/state.json` 与 `/panel/state.json`，
  `/`、`/panel/`、`/bridge/` 三种挂载都通；`GET /` 固定返回 HTML，`/healthz` 固定 JSON
- **网关安全**：`WEB_TOKEN` 为空直接拒绝启动（`WEB_ALLOW_NO_TOKEN=1` 仅本机调试）；
  cookie 改 HttpOnly，导航页不再把 token 拼进 iframe URL，`?k=` 加载后从地址栏抹掉；
  转发给下游前去掉 `tinda` cookie；`/logout` 清 cookie；`/bridge` 补 308 斜杠；
  DSH 401 只在 HTML 请求时换说明页，API 请求原样透传
- **桥接器健壮性**：DSH 会话失效（unknown session）自动清映射并重开一次；
  子进程提前退出时接住 stdin EPIPE，不再拖垮整个桥接器；DSH 输出/stderr 有上限；
  事件备注先脱敏再截断；SIGTERM 时一并收掉正在跑的 DSH 子进程；端口占用打印原因后退出
- **配置**：删除从未实现的 `BRIDGE_PANEL_PORT` 死键（面板与桥接器同端口，网关从
  `BRIDGE_LISTEN` 推导）；`ensure_dirs` 从 example 补缺键且不覆盖已有值；
  修复 `grep -F "^KEY="` 把 `^` 当字面量导致配置永远读不到、并反复追加重复键的 bug；
  token 空文件会补成 32 位十六进制；证书 SAN 不覆盖当前 IP 时自动重签；`WEB_HTTP_PORT` 真正接线
- **清理**：删除无法通过 `node --check`、且缺 `dsh/model/onebot/store` 实现的旧 `app/`，
  以及指向它的 `bin/run-bot.sh`、旧 bare 仓库脚本 `setup-git.sh`/`autocommit.sh`；
  契约检查器迁到 `bin/check-contracts.mjs`，契约 `implementedBy` 清空并如实告警；
  新增 `bin/install-hooks.sh`；`snapshot.sh` 修成全项目快照（以前漏掉 bin/units/contracts）
- **测试**：新增 `units/web/test-gateway.mjs`（16 项：鉴权/cookie/反代/401/失败关闭）；
  `test-panel` 扩到 23 项；`test-headless` 扩到 12 项（含会话失效重开）
- 文档同步：README / RUNBOOK / 配置说明 / 安全模型 / 生产就绪清单 / 接口与适配 / ADR-0004
  / contracts README；`module.prop` 修正「只监听 Unix socket」的过期描述并升到 v0.2.18

## v0.2.17
- 备份瘦身与可恢复：备份前 `git gc`，`.git` 从 404 个散对象文件降到 31 个
  （一次备份 681 → 322 个文件）；额外生成单文件 `repo.bundle`（220KB），
  `/sdcard` 的 FUSE 挂载会让 `git` 报 dubious ownership，bundle 不受影响，`git clone` 即可还原
- `RUNBOOK.md` 新增 §8.5：备份到底由什么组成（历史和快照占大头）、两种恢复方式（已实测）
- `AGENTS.md` 两条规则改成现行做法：源码目录 `app/` → `units/`；
  「一律 Unix socket」与实际（回环 TCP + 对外 8443 带 token）不符，改成带例外的表述

## v0.2.16
- 两份文档改成通用文件名，放仓库根：
  `docs/编码规范.md` → `AGENTS.md`（AI 工具和人都先读这个），
  `docs/操作手册.md` → `RUNBOOK.md`（运维手册的标准叫法）
- 全仓库的交叉引用同步更新；历史 CHANGELOG 条目保持原名不改

## v0.2.15
- 文档按当前真实流程重写：新增 `docs/操作手册.md`（九节，每条命令都实跑过），
  `README.md` 重写，`docs/配置说明.md` 只留真实存在的配置
- 旧实现的记录归档到 `docs/历史-变更记录.md`；`docs/命令表-help原文.md`、
  `docs/output-模式.md` 标注为「未实现素材」；生命周期/安全模型/生产就绪清单/接口与适配按现状改写
- `etc/tinda.conf.example` 对齐代码：删掉 PORT_MODE/SOCKET_PATH/NAPCAT_WS_* 等已不读的键，
  补上 BRIDGE_* / NAPCAT_API / WEB_*_ORIGIN_PORT 等真在用的键
- `bin/lib.sh`：`$DATA` 按「/data/adb/tinda-bot 在不在」判定，仓库内直跑退到 `.runtime/`；
  首次运行自动把 example 铺成 `$DATA/etc/tinda.conf`
- `bin/unit.sh`：外部单元状态改为探活（`PROBE_URL`），本机没有 curl 时用 node 探
- `service.sh`：之前漏了 `web` 单元，开机不会拉起控制台，补上并写明顺序
- `bin/doctor.sh` 重写：环境/权限/单元/端口/OneBot/面板/网关/备份/git/最近错误十段，任一项 FAIL 退出码 1
- `units/napcat/unit.conf` 从容器改回真实形态（`TYPE=exec` + `bin/napcat-start-host.sh`）
- `bin/napcat-install-host.sh` 补上注入步骤（写 launcher、改 `package.json` 的 `main`）；
  更正文档里「安装会编 gnutls-shim」的说法——QQ 3.2.34 下不需要

## v0.2.14
- 接通 NapCat 的 OneBot 11：`bin/napcat-wire-onebot.sh` 写 `httpServers`（127.0.0.1:3001，带 token）
  和 `httpClients`（事件推送到桥接器 6700），token 落在 `$DATA/secrets/napcat.token`（0600）
- 新增 `bin/napcat-start-host.sh`：Xvfb + QQ 主进程 + launcher 注入，一个入口把 NapCat 拉起来
- QQ launcher 支持快速登录：自动从 `onebot11_<uin>.json` 取账号补 `-q <uin>`，
  重启 NapCat 不用重新扫码
- headless 后端接上 App 的账号登录态：headless profile 默认关掉了交互式凭据库与账号插件
  （上游假设一次性任务用启动时给的 API key），本机没有 API key，所以在
  `$DSH_HOME/profiles/headless/cordis.patch.yml` 里重新打开并把默认模型指到 `deepseek-account`

## v0.2.13
- 桥接器补回网页面板 `units/bridge/panel.mjs`：概览（后端/运行时长/收到/成功/失败/排队）、
  会话表（chatKey → DSH 会话 id、条数、最近、耗时、是否在处理）、事件流（最近 100 条元信息）、只读配置
- 事件流只记「哪个聊天、多久、成没成」，不记聊天正文；配置里的 token 只显示「已设置/未设置」
- 面板用相对路径取状态（`panel/state.json`），挂在 `/bridge/` 前缀下面也不会失效
- 新增自测 `units/bridge/test-panel.mjs`（16 项，假 OneBot + echo 后端，不碰生产实例）

## v0.2.12
- 三个面板各自独立端口：`WEB_DSH_ORIGIN_PORT`（默认 8444）、`WEB_NAPCAT_ORIGIN_PORT`（默认 8445），
  根路径直通下游。DSH 与 NapCat 的前端都写死绝对路径（`/webui/assets`、`/api/…`），挤在 8443 的前缀
  下面必然白屏，改了前缀也改不动它们编译好的产物
- 导航页按端口拼 iframe 地址（`PORTS` 由网关注入），并带上 `?k=` 让独立端口也能认人
- NapCat 的 `token` 查询参数只补给页面请求，不补给 `/api/*`：实测 `/api/auth/login?token=…`
  会让它直接返回 `Unauthorized`，面板因此一直白屏
- DSH 的 401 由网关换成有说明的 HTML 页，不再给 iframe 一片空白
- 删除网关里「cookie 加 HttpOnly」的做法：页面自己要用 `document.cookie` 判断登录态

## v0.2.11
- 桥接器最小实现 `units/bridge/bridge.mjs`：OneBot 11 HTTP 事件入口（`POST /`）+ `GET /healthz`，
  回发走 OneBot HTTP API（`send_private_msg` / `send_group_msg`），同一聊天串行排队
- DSH 后端适配层：每轮 spawn `dsh headless --json`，任务走 stdin，会话 id 落盘后下一轮 `--session-id` 续接
- 自带两套自测：`units/bridge/test-roundtrip.mjs`（回路 11 项）、`units/bridge/test-headless.mjs`（适配层 9 项）
- 新增 `bin/run-bridge.sh`（装配环境后 exec，不重试不探活）与 `bin/rootfs-clone.sh`（硬链接克隆 rootfs）
- 桥接器接入单元管理：`units/bridge/unit.conf` → `bin/run-bridge.sh`，`HEALTH_PORT=6700`

## v0.2.5 – v0.2.10
- v0.2.5 每次更新落一份完整目录到 `/sdcard/backup`（含 `.git`、`originals/`，保留 20 份，`SHA256SUMS` 自校验）
- v0.2.6 补齐头注释与模块级配置文档、各加一道可执行门禁，补 `2026-11-15` 变更记录
- v0.2.7 接入 GitHub 远端；22 端口被封，改走 `ssh.github.com:443`
- v0.2.8 NapCat 离线优先的容器内安装器与安装文档
- v0.2.9 本机构建 NapCat rootfs（ubuntu 24.04 + node 24 + Qt 运行时依赖）
- v0.2.10 NapCat 降级为外部依赖：模块只拉起、探活、退避重启，不参与登录/版本/配置

## v0.2.4
- 新增统一导航页 `units/web/ui/index.html`：默认内嵌桥接面板，左侧切换 DSH / NapCat
- 首次打开显示 token 引导（不需要带 ?k= 参数先看页面）
- 顶部三个状态灯，数据来自 `/_/status`（900ms 超时即判离线）
- 修复：`unit.sh` 只杀子 shell 不杀真正子进程，导致端口被旧进程占住

## v0.2.2
- 整改：按 `docs/编码规范.md` 自查，补齐缺失的头注释（边界/失败）
- 新增 `docs/adr/0003-web入口与https.md`、本文件
- 模块级配置键补齐到 `etc/tinda.conf.example` 与 `docs/配置说明.md` 第 13 节
- 新增 `bin/check-headers.sh`，把头注释变成可执行门禁

## v0.2.1
- Web 入口支持 HTTPS（自签）+ 8088→8443 301 跳转
- 修复 `unit.sh` PID 记录 bug（子 shell 里 `$$` 取到父进程）

## v0.2.0
- 抽象模块单元化：`units/*/unit.conf` + `bin/unit.sh` 统一入口
- 新增 `bin/check-independence.sh`

## v0.1.3
- NapCat 独立容器与独立生命周期（`bin/napcat.sh`、`docs/生命周期.md`）

## v0.1.2
- 接口契约分层：`contracts/` 入库、`local/` 不入库、`check-contracts` 门禁

## v0.1.1
- 安全加固：业务降权、日志脱敏、原子写、资源上限
- 新增 `docs/生产就绪清单.md`、`docs/安全模型.md`

## v0.1.0
- P0 骨架：Magisk 模块、supervisor、snapshot、autocommit

## v0.2.5
- 导出 `tinda-ca.crt` 到 `/sdcard/Download/DSH-Go/`，供装进系统信任库
- 新增 `WEB_HTTP_PORT`：证书装不上时的明文直连逃生口（默认关）

## v0.2.7
- 接入 GitHub 远端（`LoveTinda/DSH-Napcat-Bot`，分支 `main`）
- 22 端口不可用，`~/.ssh/config` 固定走 `ssh.github.com:443`

## v0.2.8
- 新增 `bin/napcat-install.sh`：离线优先安装 QQNT + NapCat 到独立容器
- 新增 `docs/napcat-安装.md`：下载清单、安装、扫码、接入桥接器、两条禁令

## v0.2.9
- 在本机构建 NapCat 独立容器（Ubuntu 24.04.4 arm64 + Node 24.22.1 + Qt 依赖 + 中文字体，717 MB）
- 记录 chroot 构建方法：宿主 apt download + dpkg-deb -x，绕开 proot 下 dpkg 维护脚本失败

## v0.2.10
- 明确 NapCat 是外部依赖：模块只负责拉起容器与探活，不管理登录/配置/版本
