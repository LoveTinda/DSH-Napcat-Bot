# 0005. Magisk 形态：模块只管生命周期，Linux 栈放 chroot

## 背景

需求是「开机自启，不依赖打开 App」。仓库早就有模块骨架（`module.prop`、`customize.sh`、
`service.sh`、`uninstall.sh`），但一直只在 proot 里以「仓库内直跑」形态验证；
真正的 Magisk 宿主上没跑过。差别不在脚本写法，而在**运行时从哪来**：

- 桥接器、网关、DSH 是 JS，只要有 node 就能跑；
- NapCat 是注入进 Linux 版 QQ 的，依赖 `xvfb-run` + glibc 的 QQ 主程序（`/opt/QQ/qq`）；
  Android 的 bionic 用户态跑不了它。

## 可选方案

1. **全部改为 Android 原生**：用 Termux 的 bionic node 跑 JS，NapCat/QQ 换成 Android 版 + 注入。
   代价：等于重做 NapCat 集成（现在这套是 ADR-0001 之后一直在用的宿主直装 Linux QQ），
   而且 QQ 升级就断，维护成本最高。
2. **模块只管生命周期，业务放 chroot 的 Ubuntu rootfs**：`unit.sh` 已有 `TYPE=chroot`
   （挂 proc/dev/sys/sdcard 后 `chroot`），root 下不需要 proot。DSH/NapCat/QQ/node 全在
   rootfs 里，和现在这套完全一致。代价：要维护一个 rootfs（体积、更新、首次安装要拉镜像）。
3. **不做模块，App 内手动/胶囊启动**：已验证可行但用户明确要 Magisk；且 App 环境一停就全停。

## 决定

选 **2**。模块本身只做四件事：建目录、铺配置、开机拉起单元、卸载时停进程；
业务运行时（node / DSH / NapCat / QQ）由现场提供，首选 chroot rootfs。

在 rootfs 就位之前，模块仍然是「结构完整、能刷、能装」的：`bin/check-module.sh` 校验结构，
`bin/make-module.sh` 出 zip；各单元缺 node 时按失败关闭 `exit 78`，`doctor.sh` 会直接说
「缺 node 运行时」，不会假装在跑。

## 代价与残余风险

- 刷了模块但没备 rootfs/node：服务起不来（失败关闭，不会静默）。
- rootfs 要自己装：`bin/rootfs-clone.sh` 只做目录克隆，不拉镜像、不装包。
- 模块以 root 运行：业务进程没有降权（S-1 仍未通过，需要真机验证）。
- 单元当前是 `TYPE=exec`（宿主直装）；切 chroot 要改 `unit.conf` 的 `TYPE/ROOTFS_KEY/ENTRY`，
  并在 rootfs 里放一份代码或 bind-mount 模块目录——这部分没在真机上走过，未验证。

## 何时该重审

- 真机拿到 root、装好 Magisk 后第一次实测；
- NapCat 有官方 Android 方案、不再需要 Linux QQ 时（方案 1 变得可行）；
- rootfs 体积/更新成为负担时。
