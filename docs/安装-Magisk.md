# 装成 Magisk 模块（开机自启）

> 目的：把「这台机器上手动起三个单元」变成「刷一次、开机自己起来」。
> 边界：只讲安装与验证，不讲业务；运行时（node / DSH / NapCat / QQ）从哪来单独一节说清。
> 依赖：Android root + Magisk（或兼容 Magisk 模块格式的 KernelSU/APatch）；
>       打包脚本 `bin/make-module.sh`；结构门禁 `bin/check-module.sh`。

## 0. 先确认前提

| 前提 | 怎么确认 | 没有会怎样 |
| --- | --- | --- |
| 手机已 root 且装了 Magisk | Magisk App 里能看到「模块」页 | 刷不了；proot 里的 `su` 是假的 |
| 有可用的 node 运行时 | `su -c 'command -v node'` 或自带 `/data/adb/modules/tinda-bot/bin/node` | 各单元 `exit 78`，`doctor.sh` 报「缺 node 运行时」（S-4） |
| 业务运行时（DSH / NapCat / QQ） | 见第 5 节 | 模块装上但服务起不来 |

**当前这台机器不满足第 1 条**：这里是 App 内的 proot Ubuntu（`/data/adb` 不存在、
没有 `getprop`），所以本仓库的代码只能「按模块格式准备好」，刷入必须在真机 root 环境做。

## 1. 出包

```sh
cd /root/workspace/tinda-bot
sh bin/check-module.sh      # 结构门禁：module.prop / shebang / CRLF / service.sh
sh bin/make-module.sh       # → /sdcard/Download/DSH-Go/tinda-bot-v0.2.20-magisk.zip
```

包内只含运行需要的东西（`module.prop`、四个脚本、`bin/ units/ contracts/ etc/ docs/` 与根文档），
不含 `.runtime/`、`.git`、`originals/`、`local/`。当前产物：

- `tinda-bot-v0.2.20-magisk.zip`（71 个文件，约 172 KB）
- sha256：`55dd86713a7986d3dd3cbf7c846f2f49c8b7715d0a044c3f0c0dab4a67cdc1be`（出包时会打印，以实际为准）
- 同目录有 `.sha256`，刷之前核一下

## 2. 刷入

任选一种，**刷完必须重启**（Magisk 在开机阶段挂模块）：

```sh
# 命令行（手机上有 root shell 时）
su -c 'magisk --install-module /sdcard/Download/DSH-Go/tinda-bot-v0.2.20-magisk.zip'
```

或 Magisk App → **模块** → **从本地安装** → 选 zip → 重启。

## 3. 装完长什么样

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `/data/adb/modules/tinda-bot/` | 代码与脚本 | 升级/重装会被整体替换，**不放状态** |
| `/data/adb/tinda-bot/etc/tinda.conf` | 真配置（0600） | 改完 `unit.sh restart` 对应单元 |
| `/data/adb/tinda-bot/{state,logs,run,secrets}` | 运行态 | 卸载模块也保留 |

`bin/lib.sh` 会按模块路径判定 `$DATA=/data/adb/tinda-bot`，不会把状态写进模块目录
（v0.2.19 修的就是这个：以前首次安装时会误落到 `$MODDIR/.runtime`，升级即丢）。

开机流程：`service.sh` 等 `sys.boot_completed`，再等 20 秒，按 `napcat → dsh → bridge → web`
依次 `unit.sh start`；单个人起不来不影响其它人。

## 4. 验证与排障

```sh
su -c 'sh /data/adb/modules/tinda-bot/bin/doctor.sh'
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh status web'
su -c 'tail -50 /data/adb/tinda-bot/logs/module.log'
```

- 控制台：`https://<局域网IP>:8443/?k=<WEB_TOKEN>`，token 在 `/data/adb/tinda-bot/secrets/web.token`
- 桥接面板：控制台里点「桥接器」，或 `http://127.0.0.1:6700/panel/`
- 都起不来先看 `module.log` 有没有「缺 node」；有就是第 5 节的问题，不是模块坏了

## 5. 运行时从哪来（刷之前必须决定）

模块只有 shell 和 JS，**不带 node**；NapCat/QQ 还是 glibc 的 Linux 程序。两条路（详见
[ADR-0005](adr/0005-magisk形态与chroot.md)）：

1. **chroot + Ubuntu rootfs（推荐）**：把现在 proot 里这套原样放进 rootfs，单元改成
   `TYPE=chroot`（`unit.sh` 已支持挂 proc/dev/sys/sdcard 后 `chroot`）。整套一致，
   代价是要自己维护 rootfs 的体积与更新。
2. **Android 原生 node**：放一个能跑的 `node` 到 `/data/adb/modules/tinda-bot/bin/node`
   （会被优先使用），DSH 直接 npm 装到 Android 侧；但 NapCat/QQ 仍需另一个 Linux 环境，
   等于维护两套。

两条路都还没在真机上验过，属于清单 S-4（运行时来源可验证）；当前 `doctor.sh` 会把缺
node 的事实直接报出来，不会假装成功。

## 6. 卸载与回滚

- Magisk App 里关掉/删除模块 → 重启。`uninstall.sh` 会先停单元，**保留**
  `/data/adb/tinda-bot`（配置、日志、密钥），确认不要了再 `rm -rf`。
- 回滚到上一版：重刷上一版的 zip 再重启；或 Magisk 里禁用模块后重启，文件仍在。
- 出问题想先保命：关模块 → 重启 → 用 proot 里这套继续跑，两边共用同一份 `tinda.conf` 语义。

## 7. 安全

- 模块以 root 运行，业务进程没有降权（S-1 未通过）。
- 只有 8443 对外且必须带 token；`BRIDGE_LISTEN` 不要改成 `0.0.0.0`，否则本机任意进程/局域网
  都能直连面板与 OneBot 入口。
- `secrets/` 与 `state/` 是 0600/0700；日志写盘前过 `redact()`。
