# CHANGELOG

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
