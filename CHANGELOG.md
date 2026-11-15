# CHANGELOG

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
