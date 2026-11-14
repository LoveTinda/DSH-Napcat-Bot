# Tinda Bot（原生运行载体）

目的：把 QQ ↔ DSH 桥接器从「Termux + proot」搬到设备原生环境，开机自启、root 域守护、改动全部进 git。

**先读**：`docs/编码规范.md`（三条铁律）、`docs/adr/`（为什么这么设计）。

## 目录
```
module.prop        模块声明
customize.sh       安装时建目录、摆权限
service.sh         开机启动 supervisor
uninstall.sh       卸载时停进程、保留运行态
bin/               模块自带脚本
app/               桥接器源码（git 工作树）
docs/              规范 / ADR / 配置说明
originals/         只读原文件快照
```

## 运行态（不入模块目录）
```
/data/adb/tinda-bot/state    会话、档位、水位
/data/adb/tinda-bot/logs     日志（按天，50MB 轮转）
/data/adb/tinda-bot/secrets  token / accessToken / git 凭据（0600）
/data/adb/tinda-bot/repo.git git bare 仓库
```

## Web 控制台

`https://<局域网IP>:8443/`

- 首页是导航页，默认内嵌**桥接器**面板，可切到 DSH / NapCat
- 首次打开会要求输入 token（`/data/adb/tinda-bot/secrets/web.token`）
- 顶部三个状态灯来自 `/_/status`；下游没起来时对应灯是灰的
- 明文 8088 会 301 跳到 8443

## 常用命令
```
su -c 'sh /data/adb/modules/tinda-bot/bin/supervisor.sh start'
su -c 'sh /data/adb/modules/tinda-bot/bin/snapshot.sh "改配置前"'
su -c 'sh /data/adb/modules/tinda-bot/bin/autocommit.sh --once "feat: xxx"'
```
