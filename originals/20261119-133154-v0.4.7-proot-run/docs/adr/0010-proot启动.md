# ADR-0010：bridge 改为 proot 独立 node

- 状态：已采纳
- 日期：2026-11-19
- 相关：ADR-0008、0009

## 背景

v0.3.0 的单应用合并把 `bridge` 设为 `TYPE=exec`：由 `unit.sh` 在 Android 真 root 下直接
`exec node app/src/index.js`。它和原版 bridge 的“普通 node 进程”形态像，但原版跑在
Termux 的 proot Ubuntu 里，uid 0 是 proot 假 root，不是 Android 真 root；当前 bridge
没有 proot 那层映射，权限更大，也没有 mount namespace 隔离。

用户明确要求：**独立 node 运行，用 proot 加载**，不要 Android 真 root 直跑。

## 可选方案

### A. 继续 exec 真 root（什么都不做）

- 最简单，现有测试全过。
- 但和“原版 bridge 那样”不符；业务进程拿 Android root，风险最大。不采用。

### B. 用现有 chroot 私有 namespace

- 已有 `spawn_chroot()`，隔离强。
- 但需要 rootfs + unshare + chroot，Android QQ/DSH 的宿主路径要 bind，复杂度高；
  且 chroot 仍是真 root（只是 namespace 隔离），和原版 proot 假 root 不同。不采用。

### C. proot 加载 DSH App 的 rootfs（采用）

- 复用 DSH App 的 `lib/arm64/libproot.so` 和 `files/runtime/rootfs`，里面已有 node/dsh。
- 模块代码、状态、配置 bind 到 rootfs 的 `/tmp`；不 bind `/data`、`/sdcard`。
- `proot -0` 提供 guest 假 root；宿主 proot 进程仍由 root 启动，这不是降权。
- 不依赖模块自带 rootfs，体积不变。
- 代价：和 DSH App 的安装路径/rootfs 布局耦合。

### D. 模块自带 rootfs

- 解耦，但多几百 MB，且要自己装 node/dsh；用户没有要求。不采用。

## 决定

采用 C：

1. `units/bridge/unit.conf` 改 `TYPE=proot`，`CMD=bin/run-app-proot.sh`。
2. `run-app-proot.sh` 自动找 `libproot.so` 和 rootfs；也允许 `PROOT_BIN` /
   `PROOT_ROOTFS` 覆盖。
3. `proot -0 --rootfs=<DSH rootfs>`，只 bind：
   - `/dev`、`/proc`、`/sys`、`/system`、`/apex`
   - 模块 `app/` → `/tmp/tinda-app`
   - 状态 `$DATA/state/app` → `/tmp/tinda-state`
   - `$DATA/etc/app.json` → `/tmp/tinda-app.json`
   - 从 headless 复制的 `qq` profile → `/root/.dsh/profiles/qq`
4. 找不到 proot/rootfs/node → 退出 78，**不回退 exec**。
5. `service.sh` 仍零动作；proot 只在手动 `unit.sh start bridge` 时启动。
   （v0.3.2 起开机默认只自启 `web`，`bridge` 仍手动，见 [ADR-0011](0011-开机自启.md)。）

## 代价与残余风险

- **proot 不是安全沙箱**：它做路径映射，bind 进来的目录仍可读写；宿主 proot 进程
  仍以 root 启动，`-0` 只改 guest 视图，不是降权。它减少的是 bind 面（不 bind
  `/data`、`/sdcard`），不是特权。真正的降权需要 su 到 DSH App uid 并把代码/状态
  复制到 App 可读目录，待后续。
- 依赖 DSH App 的包名/rootfs；App 升级或换包名时需改 `PROOT_PKG`。
- 复用 `qq` profile 会写 `$DATA/state/app/profile/qq`；不覆盖 rootfs 已有的 qq。
- 如果 DSH rootfs 里没有 `headless` profile，启动失败（78），不静默降级。
- proot 自身的挂载/路径模拟有性能开销；桥接不是高频计算，可接受。

## 更新（v0.4.7）：参数集中，并照抄 DSH App

v0.4.6 在真机上补掉 `libtalloc.so` 的 `CANNOT LINK` 后，proot 仍一起即退，日志只剩
`the program is a script but its interpreter … was not found` / `fatal error: see
libproot.so --help`。根因是我们自己拼的参数比 DSH App 启动 proot 的那份少了几项扩展
选项和 bind。**这块机器上唯一被验证能跑的 proot 命令行就是 App 自己那一行**，所以：

1. 参数只在 `bin/proot-run.sh` 里定义一次，web 与 bridge 共用；
2. 逐项对齐 App：`--link2symlink`、`--sysvipc -L`、`/dev/urandom:/dev/random`、
   `/dev/fd`、`/dev/stdin|stdout|stderr`、`/sys/fs/selinux` 盖空目录、`/dev/shm`；
3. 启动前跑探针，把 proot 的原始报错原样写进镜像日志——失败时先有数据，再改代码；
4. 额外 bind 通过 `TINDA_EXTRA_BINDS` 传给同一个脚本，避免每个单元各写一份参数。

## 何时重审

- DSH App 换了 proot 实现或 rootfs 布局；
- 需要把 bridge 也做成强隔离（user namespace/chroot）时；
- proot 下 DSH 账号凭据或 session 锁出现冲突时。
