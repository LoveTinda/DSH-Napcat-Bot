# CHANGELOG

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
