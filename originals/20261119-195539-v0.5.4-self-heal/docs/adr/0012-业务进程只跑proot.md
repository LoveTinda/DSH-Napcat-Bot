# ADR-0012：业务进程只跑 proot，不再回退宿主 exec

> 状态：已采纳（v0.4.0，v0.4.1 修正边界）。收紧 ADR-0010：node 业务只允许在受限 rootfs
> （proot 或 unit.sh 的 chroot）里跑，**绝不回退宿主 exec**；不是「只能 proot」。

## 背景

v0.3.8 为了「机器上没有 node 也能起面板」，让 `run-web.sh` 在找不到宿主 node 时回退到
DSH App 的 proot；v0.3.9 又改成「proot 优先、探测不到退回宿主」。两种都留着一条宿主分支：

```text
探测不到 proot → 宿主 node 直接跑网关
```

宿主是 Android **root 域**。在宿主跑 node 业务，等于把 `/data`（所有 App 数据、密钥、
其他模块）和 root 权限交给一段会被 QQ 消息触发的代码。对比之下 proot 只暴露 bind 进来的
目录，剩下的 `/data`、`/sdcard` 看不到。两条路径并存，实际运行哪条取决于「探测结果」，
这是最糟的形态：出了事无法从日志判断当时跑在哪一侧，也没法保证降权边界。

## 可选方案

1. **保持 proot 优先 + 宿主回退**：兼容性最好，但「回退」本身就是风险；一次 `pm` 超时
   就能把业务从 sandbox 挪到 root 域，且没有任何提示。
2. **proot 失败就 78（选中）**：面板起不来，但错误可读、边界稳定；用户装好 DSH App 即恢复。
3. **宿主 + 真正降权（su 到 App uid）**：安全上最接近理想，但要拷贝代码/状态到 App 可读目录、
   处理 SELinux 与文件属主，改造成本高于本次问题。

## 决定

- `run-web.sh` 只在受限 rootfs 里跑：已经被 `unit.sh` 放进 chroot（`TINDA_RF` 非空）就直接用；
  否则探测 `PROOT_BIN` + `PROOT_ROOTFS` 进 proot；两者都没有就 `exit 78` 并打印变量与包名。
- `unit.sh` 的 chroot 里 `/sys` 改为可选：只有内核允许 ro remount 才挂，失败就撤掉并跳过，
  不再让整个单元 78（真机日志：`[web] 挂 /sys（只读）失败`）。
- 删除 `WEB_RUNTIME`：没有 host 档，也没有 auto。
- 宿主侧只剩 `unit.sh`/`supervisor` 这类生命周期脚本；`bridge` 与 `web` 都在 proot 里。
- 探测结果缓存 `$DATA/run/proot.path`，避免每次启动都调 `pm`（binder，几百毫秒）。
- 门禁固定这条契约：`run-web.sh` 必须含 `TINDA_IN_PROOT` 重入保护与「不回退宿主」字样，
  且不得再出现 `command -v node` + `WEB_RUNTIME` 的组合。

## 代价与残余风险

- 没装 DSH App（或 rootfs 被清）时，8443 完全不可用；这是刻意的失败关闭。
- proot 仍是假 root，宿主进程本身由 root 启动；它缩小可见范围，但不是安全沙箱。
- 调试只能在 proot 内进行，宿主的 `node -v` 不再代表运行时。

## 何时重审

- 模块能自带 node（体积/许可可接受）或拿到独立的 proot 二进制；
- 实现了 su 到 App uid 的真降权，可以重新讨论「宿主 + 降权」；
- DSH App 不再是必装依赖。
