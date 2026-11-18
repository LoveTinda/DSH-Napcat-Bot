# 装成 Magisk 模块（默认手动启动）

> 目的：把模块装进 Magisk，默认**不自动启动**任何单元；需要时手动起，避免开机阶段挂载/进程拖垮系统。
> 边界：只讲安装与验证，不讲业务；运行时（node / DSH / NapCat / QQ）从哪来单独一节说清。
> 依赖：Android root + Magisk（或兼容 Magisk 模块格式的 KernelSU/APatch）；
>       打包脚本 `bin/make-module.sh`；结构门禁 `bin/check-module.sh`。

## 0. 先确认前提

| 前提 | 怎么确认 | 没有会怎样 |
| --- | --- | --- |
| 手机已 root 且装了 Magisk | Magisk App 里能看到「模块」页 | 刷不了；proot 里的 `su` 是假的 |
| 有可用的 node 运行时 | `magisk-provision.sh --check`，或 `su -c 'command -v node'` | 各单元 `exit 78`，`doctor.sh` 报「缺 node 运行时」（S-4） |
| 业务运行时（DSH / NapCat / QQ） | 见第 5 节 | 模块装上但服务起不来 |

**本仓库的 proot 环境不能代表真机**：这里是 App 内的 Ubuntu，不能拿它验证 Magisk
的 mount/chroot 行为；刷入与开机验证必须在真机 root 环境做。不确定就先跑 1.5 节的
最小挂载探针，默认不创建任何挂载。

## 1. 出包

```sh
cd /root/workspace/tinda-bot
sh bin/check-module.sh      # 结构门禁：module.prop / shebang / CRLF / service.sh
sh bin/make-module.sh       # → /sdcard/Download/DSH-Go/tinda-bot-v0.2.36-magisk.zip
```

包内只含运行需要的东西（`module.prop`、四个脚本、`bin/ units/ contracts/ etc/ docs/` 与根文档），
不含 `.runtime/`、`.git`、`originals/`、`local/`。当前产物：

- `tinda-bot-v0.2.36-magisk.zip`（约 180 KB；文件清单用 `unzip -l` 看，脚本会打印实际文件数）
- 同目录的 `.sha256` 就是校验和：刷之前 `sha256sum -c tinda-bot-v0.2.36-magisk.zip.sha256`（在 zip 所在目录）
- 同目录有 `.sha256`，刷之前核一下

## 1.5 刷之前先跑最小挂载探针

不确定这台的 `unshare`/`mount` 行不行，先跑 `bin/mount-probe.sh`。**默认不创建任何挂载**，
只在一个临时目录里验证 `unshare -m` 与 `mount --make-rprivate`：

```sh
su -c 'sh /sdcard/Download/DSH-Go/tinda-mount-probe.sh'
```

- `PASS`：私有 namespace 可用；再跑 `--mount` 验证 bind/只读 remount：
  `su -c 'sh /sdcard/Download/DSH-Go/tinda-mount-probe.sh --mount'`
- `SKIP 没有 unshare`：这台不能走 chroot；`TYPE=exec` 照常能用，不影响开机。
- `FAIL`：不要手动起 `chroot` 单元；把 `bridge`/`web` 的 `TYPE` 改为 `exec`
  （宿主直装）最稳妥，不影响开机。

脚本默认只写 `/data/local/tmp` 下的临时目录（不可写才退回 `/tmp`）；`--mount` 的挂载
全在 `unshare -m` 子进程里，退出即销毁，并检查宿主 `mountinfo` 有没有残留。
proot 里 namespace id 不变，会保守失败，结果不可信；必须在 `su -c` 的真机 root 下跑。若 `su` 读不到 `/sdcard`，先复制再跑：

```sh
su -c 'cp /sdcard/Download/DSH-Go/tinda-mount-probe.sh /data/local/tmp/ && sh /data/local/tmp/tinda-mount-probe.sh'
```

## 2. 刷入

**刷完重启一次**让模块目录生效；它不会在开机阶段挂载或启动服务。按你的 root 方案选：

```sh
# Magisk
su -c 'magisk --install-module /sdcard/Download/DSH-Go/tinda-bot-v0.2.36-magisk.zip'

# KernelSU / SukiSU（同一个模块格式，目录也是 /data/adb/modules）
su -c 'ksud module install /sdcard/Download/DSH-Go/tinda-bot-v0.2.36-magisk.zip'
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

开机流程：`service.sh` 只建目录、补配置、写 `module.log`，**立即退出**；
不启动任何单元，不等 `sys.boot_completed`，不 chroot，不 mount。需要服务时手动起：

```sh
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh start web'      # 控制台
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh start bridge'   # QQ 桥接
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh start napcat'   # 需要 QQ 时
```

桥接依赖 NapCat 的 3001；Web 依赖桥接面板口。没有硬依赖，起早了只是暂时 502。

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

模块只有 shell 和 JS，**不带 node**；NapCat/QQ 是 Android bionic 程序，**永远宿主直装**。
桥接/网关支持 `TYPE=auto`：只有同时满足「有 `/data/adb`、有 rootfs、`unshare -m` 探针通过」
才走 chroot；否则退回宿主直装（proot 里就是这样）。chroot 是显式能力，不是刷入即默认。

### 5.1 准备 rootfs

```sh
# 看现状：rootfs 在不在、里面的 node/npm/dsh 有没有、每个单元会怎么起
su -c 'sh /data/adb/modules/tinda-bot/bin/magisk-provision.sh --check'
```

两种来源，二选一（**推荐 A**：手机里已经有装好 node/DSH/QQ 的 Ubuntu，复制一份比重新装快得多）：

```sh
# A. 复制这台手机上 App 的本机环境（独立快照，新 inode，不共享文件）
su -c 'sh /data/adb/modules/tinda-bot/bin/magisk-provision.sh \
  --from /data/user/0/io.github.ccch1mneyyy.dsh_app/files/runtime/rootfs'

# A2. 同样的东西，硬链接克隆（几秒完成，但和 App 共享 inode，一侧原地写会影响另一侧）
su -c 'sh /data/adb/modules/tinda-bot/bin/magisk-provision.sh --link \
  --from /data/user/0/io.github.ccch1mneyyy.dsh_app/files/runtime/rootfs'

# B. 从官方 Ubuntu base 起一个干净环境。必须带 .sha256，否则拒绝（S-4）
su -c 'sh /data/adb/modules/tinda-bot/bin/magisk-provision.sh \
  --tarball /sdcard/Download/ubuntu-base-24.04-base-arm64.tar.gz'
```

App 环境路径可能随版本变化，拿不准就先查：

```sh
su -c 'ls -d /data/user/0/*/files/runtime/rootfs'
```

A 方案的代价：这台机器的环境约 7.7G（QQ 646M + NapCat 311M + DSH 243M + 系统其余），
复制要几分钟、占双份空间（当前还剩 120G+，够）；好处是复制完就**自带 node、DSH、QQ 登录态**，
不用再 apt/npm。复制是快照，App 以后更新环境不会影响模块这份，要同步得重新复制一次。

脚本会拒绝覆盖非空的 rootfs（要覆盖加 `--force`），默认不联网；`--from` 会排除
`proc/dev/sys/sdcard/data`，避免把内核文件系统翻一遍。

### 5.2 在 rootfs 里装运行时（A/A2 方案已自带，可跳过）

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
# 若显示 exec：unshare/rootfs 探针没过，退回宿主直装（安全优先，不硬上）
su -c 'sh /data/adb/modules/tinda-bot/bin/magisk-provision.sh --check'
su -c 'tail -20 /data/adb/tinda-bot/logs/module.log'   # 每行会写「启动方式 chroot/exec」
```

chroot 启动时 `unit.sh` 会在**私有 mount namespace** 里挂：`/proc`、`/dev`、`/sys`（只读）、
模块代码（只读）、`etc/state/logs/run/secrets` 五个状态目录。**不再 bind `/data/adb`、不挂 `/sdcard`**；
宿主路径用符号链接映射，namespace 退出即销毁，不会在宿主留下递归挂载。

挂载前会先做 `unshare -m` + `mount --make-rprivate` 探针；探针不通过就退回 exec，不硬上。
如果 `mountpoint -q /data/adb/tinda-bot/rootfs/data/adb` 还是真（旧版挂载没随重启清掉），
直接拒绝启动并提示先重启，不再叠一层。

rootfs 里要装的东西（缺了单元会自己报错，不会静默）：

- Ubuntu 版 `node`（`apt install nodejs` 即可，桥接器/网关/DSH 都用它）
- `openssl`（网关签证书；缺了退回 HTTP 并告警）
- NapCat 与 QQ **不进 chroot**：`napcat/unit.conf` 固定 `TYPE=exec`，继续用宿主 `/opt/QQ`、`/opt/napcat`；
  不要再把 Android QQ 迁进 Ubuntu rootfs，它在 glibc 里跑不起来。
- chroot 只给 bridge/web 用；它们需要 rootfs 内的 node/openssl，DSH 仍由 App 自己托管。
- **不要**把 Android 的 node 放进 `/data/adb/modules/tinda-bot/bin/node` 后指望 chroot 用它：
  那是 bionic 二进制，在 Ubuntu rootfs 里跑不了。放 `bin/node` 只对宿主直装形态有意义。

这套路径**没有在真机上跑过**（本仓库的 proot 不能代表 Magisk 环境），属于清单 S-4 的残余；但失败是显式的：
缺 rootfs → `unit.sh explain` 显示 exec、`module.log` 写明；缺 node → 单元 `exit 78`，
`doctor.sh` 报「缺 node 运行时」，不会假装成功。

## 6. 卸载与回滚

- Magisk App 里关掉/删除模块 → 重启。`uninstall.sh` 会先停单元，**保留**
  `/data/adb/tinda-bot`（配置、日志、密钥），确认不要了再 `rm -rf`。
- 回滚到上一版：重刷上一版的 zip 再重启；或 Magisk 里禁用模块后重启，文件仍在。
- 出问题想先保命：关模块 → 重启 → 用 proot 里这套继续跑，两边共用同一份 `tinda.conf` 语义。

## 7. 安全

- 默认不自动启动，开机阶段不 mount、不 chroot、不起进程；风险最低。
- 模块以 root 运行，业务进程没有降权（S-1 未通过）。
- chroot 只在私有 namespace 里挂最小目录；不挂 `/data/adb` 祖先、不挂 `/sdcard`；失败关闭。
- 只有 8443 对外且必须带 token；`BRIDGE_LISTEN` 不要改成 `0.0.0.0`，否则本机任意进程/局域网
  都能直连面板与 OneBot 入口。
- `secrets/` 与 `state/` 是 0600/0700；日志写盘前过 `redact()`。
