# 装成 Magisk 模块（开机自启）

> 目的：把「这台机器上手动起三个单元」变成「刷一次、开机自己起来」。
> 边界：只讲安装与验证，不讲业务；运行时（node / DSH / NapCat / QQ）从哪来单独一节说清。
> 依赖：Android root + Magisk（或兼容 Magisk 模块格式的 KernelSU/APatch）；
>       打包脚本 `bin/make-module.sh`；结构门禁 `bin/check-module.sh`。

## 0. 先确认前提

| 前提 | 怎么确认 | 没有会怎样 |
| --- | --- | --- |
| 手机已 root 且装了 Magisk | Magisk App 里能看到「模块」页 | 刷不了；proot 里的 `su` 是假的 |
| 有可用的 node 运行时 | `magisk-provision.sh --check`，或 `su -c 'command -v node'` | 各单元 `exit 78`，`doctor.sh` 报「缺 node 运行时」（S-4） |
| 业务运行时（DSH / NapCat / QQ） | 见第 5 节 | 模块装上但服务起不来 |

**当前这台机器不满足第 1 条**：这里是 App 内的 proot Ubuntu（`/data/adb` 不存在、
没有 `getprop`），所以本仓库的代码只能「按模块格式准备好」，刷入必须在真机 root 环境做。

## 1. 出包

```sh
cd /root/workspace/tinda-bot
sh bin/check-module.sh      # 结构门禁：module.prop / shebang / CRLF / service.sh
sh bin/make-module.sh       # → /sdcard/Download/DSH-Go/tinda-bot-v0.2.21-magisk.zip
```

包内只含运行需要的东西（`module.prop`、四个脚本、`bin/ units/ contracts/ etc/ docs/` 与根文档），
不含 `.runtime/`、`.git`、`originals/`、`local/`。当前产物：

- `tinda-bot-v0.2.21-magisk.zip`（约 180 KB；文件清单用 `unzip -l` 看，脚本会打印实际文件数）
- 同目录的 `.sha256` 就是校验和：刷之前 `sha256sum -c tinda-bot-v0.2.21-magisk.zip.sha256`（在 zip 所在目录）
- 同目录有 `.sha256`，刷之前核一下

## 2. 刷入

**刷完必须重启**（模块是在开机阶段挂载的）。按你的 root 方案选：

```sh
# Magisk
su -c 'magisk --install-module /sdcard/Download/DSH-Go/tinda-bot-v0.2.21-magisk.zip'

# KernelSU / SukiSU（同一个模块格式，目录也是 /data/adb/modules）
su -c 'ksud module install /sdcard/Download/DSH-Go/tinda-bot-v0.2.21-magisk.zip'
```

也可以直接在 Magisk / KernelSU / SukiSU 的 App 里：**模块** → **从本地安装** → 选 zip → 重启。

KernelSU 系列不保证执行 `customize.sh`（那是 Magisk 的安装钩子），所以 `service.sh`
开机时会自己再初始化一次目录与配置，**不依赖 customize.sh**；两套都能用同一份包。

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

模块只有 shell 和 JS，**不带 node**；NapCat/QQ 还是 glibc 的 Linux 程序。所以单元支持
`TYPE=auto`：**有 `/data/adb` 且 `/data/adb/tinda-bot/rootfs/usr` 存在就走 chroot，
否则走宿主直装**（proot 里就是这样）。代码已按这个约定写好，rootfs 由现场提供。

### 5.1 准备 rootfs

```sh
# 看现状：rootfs 在不在、里面的 node/npm/dsh 有没有、每个单元会怎么起
su -c 'sh /data/adb/modules/tinda-bot/bin/magisk-provision.sh --check'
```

两种来源，二选一：

```sh
# A. 解包官方 Ubuntu base（arm64）。必须带 .sha256，否则拒绝（S-4）
su -c 'sh /data/adb/modules/tinda-bot/bin/magisk-provision.sh \
  --tarball /sdcard/Download/ubuntu-base-24.04-base-arm64.tar.gz'

# B. 克隆一份现成的 Ubuntu 目录树（硬链接优先，省空间）
su -c 'sh /data/adb/modules/tinda-bot/bin/magisk-provision.sh --from /path/to/ubuntu'
```

脚本会拒绝覆盖非空的 rootfs（要覆盖加 `--force`），也不联网、不装包。

### 5.2 在 rootfs 里装运行时

```sh
su -c "chroot /data/adb/tinda-bot/rootfs /bin/bash -lc 'apt-get update && apt-get install -y nodejs npm ca-certificates'"
su -c "chroot /data/adb/tinda-bot/rootfs /bin/bash -lc 'npm i -g @deepseek-ai/dsh'"
```

然后把 `/data/adb/tinda-bot/etc/tinda.conf` 的 `DSH_BIN` 指到 rootfs 内的 DSH 入口
（`chroot ... which dsh` 查），重启单元。

### 5.3 确认真的走了 chroot

```sh
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh explain bridge'
# 期望：bridge: TYPE=auto → chroot:/data/adb/tinda-bot/rootfs
su -c 'sh /data/adb/modules/tinda-bot/bin/magisk-provision.sh --check'
su -c 'tail -20 /data/adb/tinda-bot/logs/module.log'   # 每行会写「启动方式 chroot」
```

chroot 启动时 `unit.sh` 会把 `/data/adb`、`/sdcard`、`/proc`、`/dev`、`/sys` 挂进 rootfs，
所以代码、配置、日志、状态仍然是 Android 侧那一份，不会出现「两套配置」。

rootfs 里要装的东西（缺了单元会自己报错，不会静默）：

- Ubuntu 版 `node`（`apt install nodejs` 即可，桥接器/网关/DSH 都用它）
- `openssl`（网关签证书；缺了退回 HTTP 并告警）
- NapCat 与 QQ：现有 proot 里的 `/opt/napcat`、`/opt/QQ` 要迁进 rootfs，`xvfb-run` 也要装
- **不要**把 Android 的 node 放进 `/data/adb/modules/tinda-bot/bin/node` 后指望 chroot 用它：
  那是 bionic 二进制，在 Ubuntu rootfs 里跑不了。放 `bin/node` 只对宿主直装形态有意义。

这套路径**没有在真机上跑过**（本机没有 `/data/adb`），属于清单 S-4 的残余；但失败是显式的：
缺 rootfs → `unit.sh explain` 显示 exec、`module.log` 写明；缺 node → 单元 `exit 78`，
`doctor.sh` 报「缺 node 运行时」，不会假装成功。

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
