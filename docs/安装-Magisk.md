# 装成 Magisk 模块（默认只自启 web）

> 目的：把模块装进 Magisk；默认只自动启动 `web` 控制台，`bridge`/`napcat` 手动起，
> 既让面板刷完就能打开，又避免白名单没配好时开机自动回 QQ 消息。
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
sh bin/make-module.sh       # → /sdcard/Download/DSH-Go/tinda-bot-v0.2.41-magisk.zip
```

包内只含运行需要的东西（`module.prop`、四个脚本、`bin/ units/ contracts/ etc/ docs/` 与根文档），
不含 `.runtime/`、`.git`、`originals/`、`local/`。当前产物：

- `tinda-bot-v0.2.41-magisk.zip`（约 430 KB；文件清单用 `unzip -l` 看，脚本会打印实际文件数）
- 同目录的 `.sha256` 就是校验和：刷之前 `sha256sum -c tinda-bot-v0.2.41-magisk.zip.sha256`（在 zip 所在目录）
- 同目录有 `.sha256`，刷之前核一下

## 1.5 刷之前先跑最小挂载探针

不确定这台的 `unshare`/`mount` 行不行，先跑 `bin/mount-probe.sh`。**默认不创建任何挂载**：
先确认 `unshare -m` 真的换了 namespace，再调用同目录的 `make-private.sh` 把传播设为
不回传宿主；`--make-rprivate` 不可用时，helper 会试 toybox 的 `-o rprivate` 等写法，
并检查 `mountinfo` 全树没有 `shared:` 才继续。

探针需要同目录有 helper；Download 里已放好两个文件：
`tinda-mount-probe.sh` 与 `tinda-make-private.sh`。

```sh
su -c 'sh /sdcard/Download/DSH-Go/tinda-mount-probe.sh'
```

- `PASS`：传播已确认不回传宿主；再跑 `--mount` 验证 bind/只读 remount：
  `su -c 'sh /sdcard/Download/DSH-Go/tinda-mount-probe.sh --mount'`
- `SKIP`：缺 root/unshare/helper；这台不能走 chroot，`TYPE=exec` 照常用。
- `FAIL`：不要手动起 `chroot`；把 `bridge`/`web` 的 `TYPE` 改为 `exec` 最稳。

脚本默认只写 `/data/local/tmp` 下的临时目录（不可写才退回 `/tmp`）；`--mount` 的挂载
全在 `unshare -m` 子进程里，退出即销毁，并检查宿主 `mountinfo` 有没有残留。
proot 里 namespace id 不变，会保守失败；必须在 `su -c` 的真机 root 下跑。若 `su` 读不到
`/sdcard`，把两个文件一起复制再跑：

```sh
su -c 'cp /sdcard/Download/DSH-Go/tinda-mount-probe.sh /sdcard/Download/DSH-Go/tinda-make-private.sh /data/local/tmp/ && sh /data/local/tmp/tinda-mount-probe.sh'
```

如果仍报传播失败，再跑 `tinda-prop-probe.sh` 看原始报错；它只打印候选和 `mountinfo`，
不创建挂载。**只有 after 行没有 `shared:` 的候选才可能用于 chroot。**

## 2. 刷入

**刷完就能开面板，不用先重启**：安装结束时 `customize.sh` 会直接从暂存目录起一次
`web`，并把 `https://<IP>:8443/?k=<token>` 打进 Magisk 的安装日志。模块目录本身仍要
重启才生效；重启后由 `service.sh`/`boot-start.sh` 接管，不会起第二个。

想让所有单元都换成本次刷入的版本（例如改了 `bridge`），仍然建议重启一次。按你的 root 方案选：

```sh
# Magisk
su -c 'magisk --install-module /sdcard/Download/DSH-Go/tinda-bot-v0.2.41-magisk.zip'

# KernelSU / SukiSU（同一个模块格式，目录也是 /data/adb/modules）
su -c 'ksud module install /sdcard/Download/DSH-Go/tinda-bot-v0.2.41-magisk.zip'
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

开机流程：`service.sh` 建目录、补配置、写 `module.log`，然后 fork 一个后台的
`bin/boot-start.sh` 并**立即退出**。真正等 `sys.boot_completed`（最多 90 秒）和
`unit.sh start` 都在 `boot-start.sh` 里，所以 service.sh 不会拖开机，也不会在开机阶段 mount。

默认 `AUTO_START=web`：刷完重启，控制台自己就起来。

不想等重启、或面板没起来时：**KernelSU / APatch** 点模块卡片上的 **打开**（模块自带
`webroot/index.html`，进去是状态页：版本、web 地址/token、单元、日志，带启停按钮）；
**Magisk** 没有 webroot 容器，点 **Tinda Bot → 操作**，`action.sh` 会起 web 并用浏览器打开
同一份信息的网页版 `/module/`。`action.sh` 会起一次 `web`，然后把地址和 token 直接打出来：

```
控制台：https://192.168.1.3:8443/?k=<token>
状态：web: running pid=...
```

它只起 `web`，不动 `bridge`/`napcat`；重复点也不会起第二个。

### 日志在哪

| 位置 | 内容 |
| --- | --- |
| `/data/adb/tinda-bot/logs/` | 原始日志（supervisor / web / bridge / napcat），需要 root |
| `/sdcard/Bridge/Logs/supervisor.log` | 实时镜像（已脱敏），超过 4MB 轮转 `.1` |
| `/sdcard/Bridge/Logs/<unit>.log` | 该单元**启动失败**时整份复制过来（已脱敏） |
| `/sdcard/Bridge/Logs/export/` | `bin/export-logs.sh` 或点「操作」时全量导出 |

共享存储上的内容都过 `redact()`（token / 手机号替换成 `***`），但不要整份外发——里面仍有
QQ 号、群号、路径。

### 启动耗时（v0.3.4 实测）

| 动作 | 实测 | 说明 |
| --- | --- | --- |
| `unit.sh start web` | ~0.4 秒 | 之前 ~2.4 秒；主要浪费在配置补键和固定 `sleep 1` |
| `boot-start.sh` 返回 | ~0.6 秒 | 端口在这之后约 0.1 秒内可连 |
| 开机到面板可开 | 取决于 Magisk 调度 | 只配 `web` 时不等 `boot_completed` |

慢的根因和处理：`ensure_dirs` 每次启动都会把 `tinda.conf.example` 逐行比对补键，旧实现
每行 fork 4 个进程（手机上一轮 2 秒）；现在先一次性读出已有键，22 毫秒。单元启动也从
「固定等 1 秒」改成「进程起来就返回」。

桥接与 NapCat 仍手动：

```sh
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh start bridge'   # QQ 桥接
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh start napcat'   # 需要 QQ 时
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh start web'      # 面板没起来时手动补
```

想全自动（开机就接 QQ）：把 `$DATA/etc/tinda.conf` 里的 `AUTO_START` 改成
`napcat bridge web`；想回到旧的「开机零动作」：改成 `AUTO_START=off`。
改完重启生效，不用重刷模块。

只有一个桥接：`bridge` 单元启动 `app/`（原版会话/工作区/模型/面板 + 当前安全层），
不再有 `legacy` 并行单元。它是 `TYPE=proot`：用 DSH App 的 `libproot.so` 和
`runtime/rootfs` 加载独立 node，不 chroot、不 mount；但 proot 进程仍由 root 启动，
`-0` 只是 guest 假 root，不是降权。找不到 proot/rootfs 会 78，不回落宿主。
第一次启动后要编辑 `$DATA/etc/app.json`
的白名单，详见 [单应用桥接](原版桥接.md)。

桥接依赖 NapCat 的 3001；Web 依赖桥接面板口。没有硬依赖，起早了只是暂时 502。

## 4. 验证与排障

```sh
su -c 'sh /data/adb/modules/tinda-bot/bin/doctor.sh'
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh status web'
su -c 'tail -50 /data/adb/tinda-bot/logs/module.log'
```

- 控制台：`https://<局域网IP>:8443/?k=<WEB_TOKEN>`，token 在 `/data/adb/tinda-bot/secrets/web.token`
- 桥接面板：控制台里点「桥接器」，或 `http://127.0.0.1:6702/`
- 都起不来先看 `module.log` 有没有「缺 node」；有就是第 5 节的问题，不是模块坏了

## 5. 运行时从哪来（刷之前必须决定）

模块只有 shell 和 JS，**不带 node**；NapCat/QQ 是 Android bionic 程序，**永远宿主直装**。
`bridge` 是 `TYPE=proot`：用 DSH App 的 `libproot.so` + `runtime/rootfs` 里的 node
跑独立进程，不要求 Android 宿主有 node；找不到 proot/rootfs 直接 78，不回落宿主。
`web` 现在是 `TYPE=proot`：和 `bridge` 用同一套 DSH App 的 `libproot.so` + `runtime/rootfs`，
  不再走 chroot（chroot 在部分内核上 `/sys`、模块只读挂载都会失败，且 `TYPE=auto` 会在
  开机早期先落到宿主直装）。找不到 proot/rootfs 直接 78，不回落宿主 node。

### 5.1 准备 rootfs（仅当你要用旧 chroot 路径时才需要；web/bridge 现在都用 DSH App 的 rootfs）

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

### 5.3 确认启动方式

```sh
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh explain bridge'
# 期望：bridge: TYPE=proot → proot
# 若启动报「找不到 proot/rootfs」：检查 DSH App 是否安装、rootfs 是否有 /usr/local/bin/node
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh explain web'
# web 才可能是 chroot；显示 exec 表示 unshare/rootfs 探针没过
su -c 'tail -20 /data/adb/tinda-bot/logs/module.log'
```

chroot 启动时 `unit.sh` 会在**私有 mount namespace** 里挂：`/proc`、`/dev`、`/sys`（只读）、
模块代码（只读）、`etc/state/logs/run/secrets` 五个状态目录。**不再 bind `/data/adb`、不挂 `/sdcard`**；
宿主路径用符号链接映射，namespace 退出即销毁，不会在宿主留下递归挂载。

挂载前会先做 `unshare -m`，校验子进程 namespace id 确实变了，再调 `bin/make-private.sh`：
优先 `--make-rprivate`；toybox 不认时依次试 `-o remount,rprivate`/`-o rprivate`/
`-o remount,private`/`-o private`，每一步后要求 `mountinfo` 全树没有 `shared:`。
都失败就退回 exec；显式 chroot 直接 exit 78。toybox 可能把 `-o rprivate` 映射成 slave
（不是严格 private），所以日志会有 warn；这里的安全依据是「没有 shared，挂载不回传宿主」。
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

- 默认只自启 `web`；开机阶段 `service.sh` 不 mount、不 chroot、不等开机，等待与启动都在后台脚本里。
  不想要任何自启就设 `AUTO_START=off`（旧行为）。
- 模块以 root 运行，业务进程没有降权（S-1 未通过）。
- chroot 只在私有 namespace 里挂最小目录；不挂 `/data/adb` 祖先、不挂 `/sdcard`；失败关闭。
- 只有 8443 对外且必须带 token；`BRIDGE_LISTEN` 不要改成 `0.0.0.0`，否则本机任意进程/局域网
  都能直连面板与 OneBot 入口。
- `secrets/` 与 `state/` 是 0600/0700；日志写盘前过 `redact()`。