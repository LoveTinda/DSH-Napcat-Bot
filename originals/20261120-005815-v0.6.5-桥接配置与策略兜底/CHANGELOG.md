# CHANGELOG

## v0.6.5

桥接器这次自己把原因写在日志里了（`/sdcard/Bridge/Logs/supervisor.log`）：

```text
ERROR [main] 访问策略配置不安全，拒绝启动：
- policy.allowUsers 为空：私聊默认拒绝。请填至少一个允许的 QQ 号…
配置来自 /tmp/tinda-app.json
```

三件事叠在一起，才出现「桥接器和 NapCat 一个都没起来」：

1. `/tmp/tinda-app.json` 是**空文件**。它是 `$CONF`（`$DATA/etc/app.json`）的 bind 目标，而那份配置
   从来没生成成功；脚本先 `touch` 建了空文件，应用读到的就是 `{}`。
2. 即使生成成功，`bridge-policy.json` 里仍是占位值 `"123456"`，白名单等于没人 → 按设计 fail-closed。
3. NapCat 根本没人请求启动（动作按钮只起 web / bridge）。

### 改动

- 新增 `bin/app-boot.sh`（在 guest 里执行）：每次启动用 `config.example.json` + 策略**重新生成**
  `/tmp/tinda-app.json`，再 exec 业务。不再假设「宿主 $CONF 与 guest /tmp 是同一个文件」。
- `run-app-proot.sh`：宿主侧只做两件事——确保策略文件存在，把模板/策略显式 bind 进 guest。
- **策略兜底**：`allowUsers` 为空或仍是占位 `123456` 时，按 NapCat 登录账号
  （`/opt/napcat/config/napcat_<QQ>.json`）生成 `{"allowUsers":[QQ],"ownerUsers":[QQ]}`，
  只应答你自己；要放开就改那个文件。本次真机已按 QQ `3876238785` 写好，原文件留了 `.bak`。
- 「操作」按钮再补一步：**连 NapCat 一起拉**（外部宿主直装进程，只有 root 能起）。
- 版本：v0.6.5 / versionCode 80

### 验证

`sh -n` / `node --check` 通过；`app-config.mjs` 用真机策略跑过，生成结果里
`policy.allowUsers=["3876238785"]`、`onebot=forward-ws ws://127.0.0.1:3001`。

## v0.6.4

v0.6.3 上线后，共享存储里的**访问日志第一次把真实请求记了下来**，一看就清楚：

```text
[web] GET /          200 2ms  from=192.168.1.3 ua=Mozilla/5.0 (X11; Linux x86_64)
[web] GET /bridge/   502 4ms  from=192.168.1.3
[web] NapCat 登录失败：ECONNREFUSED
```

首页 200、桥接面板 502、NapCat 连不上。也就是说：**网页本身能开**，打不开的是面板里的内容——
`AUTO_START=web` 只起了网关，桥接器（6700）和 NapCat（6099）根本没起来。

同时 `/__info` 把上一个悬案钉死了：

```text
网关读到：/data/adb/tinda-bot/secrets/web.token  指纹 7ec1ded2  mtime 2026-11-16T17:54Z
宿主机上：/data/adb/tinda-bot/secrets/web.token  指纹 5c082429  mtime 2026-11-19 01:34
```

同一路径、两份内容——proot 内外的 `$DATA` 真的不是同一个目录，所以 `action.sh` 印的 token
在网关那边永远不对。

### 改动

- **token 以共享存储为共同真相**：`/sdcard/Bridge/web.token`。`run-web.sh` 启动时以它为基准
  同步到 `$DATA`（没有就写过去），网关、`action.sh`、模块页读的都是这一份。proot 再分家也不会分叉。
  - 代价：token 落在共享存储（其他有存储权限的 App 可读）。对单机自用的局域网面板是必要取舍，
    已在 ADR-0016 记录；行踪仍只在 `/data/adb` 和镜像日志里。
- **「操作」按钮和热安装都顺手拉起桥接器**（原来只起 web，所以面板一直空）。
- **就绪等待改看共享存储里的 console 日志**：以前盯宿主 `$DATA/logs/web.log`，跨命名空间永远等不到，
  按钮白等 30 秒。
- **开机自启一次性迁移**：`AUTO_START=web` → `web,bridge`（显式配了别的组合不动）。
- 版本：v0.6.4 / versionCode 79
- 验证：脚本 `sh -n`、`node --check` 通过；门禁 0 FAIL；43 条网关用例仍全过。

装完点一下模块「操作」：桥接器会起来，面板三个点应陆续变绿。

## v0.6.3

**不是猜的：把后端整套拉起来跑了 43 条用例（HTTP / HTTPS 各一轮），并且对着真机 8443 复现了 token 失败。**

真机实测（2026-11-20 00:2x，用 action.sh 打印的那份 token）：

```text
GET https://192.168.1.3:8443/?k=<token>      → 200，但响应里没有 Set-Cookie
GET https://192.168.1.3:8443/_/status?k=<token> → 401
```

首页能打开、token 却不被接受 = **网关当时认的不是你手上这份 token**。页面永远停在
「验证中…」，第 5 步的 fetch 拿到 401 → 弹回登录框。这就是「卡 token 验证」的实体。

### 三个真实缺陷

1. **token 只从启动那一瞬的环境变量读一次。** 之后文件被重新生成也不会跟；更麻烦的是
   proot 里 `$DATA` 有可能解析成另一个目录，于是网关读一份 token、`action.sh` 印另一份，
   两边都对、就是不一样。
2. **请求处理里的同步异常会把请求悬空。** `new URL(req.url)`、`res.writeHead()` 抛错被
   `uncaughtException` 接住：进程不死，但那个请求**永远没有响应**——浏览器端就是无限转圈。
3. **没设 keep-alive 超时。** node 默认 5 秒关掉空闲连接，浏览器正好在这时复用它就会收到
   RST，于是偶发 `ERR_CONNECTION_RESET`，刷新一次又好了。

### 改动

- token 以**文件为准**，每次鉴权都跟：候选 `WEB_TOKEN_FILE` → `$TINDA_DATA/secrets/web.token`
  → `/data/adb/tinda-bot/secrets/web.token`，取第一个有内容的；文件变了自动跟上，不必重启。
- 新增公开的 `GET /__info`：版本、pid、脚本路径、cwd、数据目录、**token 指纹**、每个候选
  文件及其 mtime。查「打不开」第一步就看它——是旧实例、旧 token，一眼可见。
- 首页把服务器 token 指纹注进登录框；输错直接显示「服务器要 `xxxx`，你输入的是 `yyyy`」。
- `action.sh` 同时打印 token 指纹，和 `/__info` 一比就知道是不是同一份。
- 请求处理整体包 try/catch：异常一律回 500，不再让请求悬空。
- 访问日志：`[web] GET / 200 3ms from=192.168.1.3 ua=…`；跳过 `/_/status`、静态资源，
  `4xx/5xx` 一律记录，写进 `/sdcard/Bridge/Logs/web-console.log`。
- `keepAliveTimeout` 65 秒（比浏览器常见的 60 秒长一档）、`headersTimeout` 70 秒。
- 前端 fetch 加 8 秒上限：卡住会明说「网关 8 秒没回话」，不再无限「验证中…」。
- 启动横幅把「pid / 脚本 / 数据目录 / token 候选与指纹」写进镜像日志。
- 验证：43 条用例 × HTTP/HTTPS 两轮全过——含 **运行中替换 token 文件后自动切换**、畸形 URL、
  上游中途断流、40 并发、空闲 7 秒复用连接、根端口、模块页、NapCat 引导页。

### 怎么用它排障

1. 打开 `https://192.168.1.3:8443/__info`，记下 `tokenFp`；
2. 管理器里点模块「操作」，看它打印的 token 指纹；
3. 两个一样 → 复制那串 token 粘进登录框即可；不一样 → 网关读的是另一份文件，
   `/__info` 的 `tokenFiles` 会直接给出是哪个路径、什么时候改的。

## v0.6.2

> **更正（v0.6.3 补）**：下面「服务其实已经好了」的判断是错的。当时只验证了 `/` 返回 200，
> 没有验证「带上 token 之后是否被接受」。实测 `/?k=<token>` 不种 cookie、`/_/status?k=<token>`
> 返回 401，所以浏览器那一侧必然进不去。真正的原因见 v0.6.3。


**服务其实已经好了。** 我直接从设备内部对 8443 发 TLS 请求：

```text
https://127.0.0.1:8443/   → 200
https://192.168.1.3:8443/ → 200
/_/status 无 token        → 401（正确）
/reset                    → 200
```

20:16 那次热安装是成功的（`web 代码：v0.6.1` → `proot 探针通过` → `启动网关`）。
浏览器里那个「验证中…」是**旧页面**：它在网关还没起来的时候加载，页面上那条连接早就废了。

补的观察能力（这次看不到 `[web] listening` 就是因为缺它）：

- 网关的 `console` 输出双写一份到 `/sdcard/Bridge/Logs/web-console.log`
  （`TINDA_MIRROR_LOG`，proot 里已把镜像目录 bind 成可写），启动行、崩溃堆栈都能直接看
- 版本：v0.6.2 / versionCode 77

## v0.6.1

安装日志把 v0.6.0 的坑指出来了：

```text
- Hot install requested
! MODULE_HOT_RUN_SCRIPT 'hotinstall.sh' not found, skipping it
- Module installed successfully, no reboot required!
```

热安装**被管理器接受了**（规格这条路是通的），但 **zip 里没有 hotinstall.sh**——
`bin/make-module.sh` 的打包白名单是手写的，加新脚本时漏了它。于是管理器跳过钩子：
模块换了新代码，却没有「停旧起新」，旧实例照样占着端口。

- `bin/make-module.sh` 白名单补上 `hotinstall.sh`
- `bin/check-module.sh` 增加门禁：**模块根目录的每个 `.sh` 都必须出现在打包白名单里**，
  以后漏一个就直接 FAIL（这次就是这条能提前拦住）
- `customize.sh`：钩子文件缺失时在安装界面明确喊一句，不再只依赖管理器那行提示
- 版本：v0.6.1 / versionCode 76
- 验证：重新打包后 `unzip -l | grep hotinstall` 有 1 条；门禁 0 FAIL

## v0.6.0

按 KernelSU / SukiSU 的**模块开发规格**重新对了一遍，发现我们一直在绕规格自己造轮子。
规格里有官方的「热安装」（Hot install）：

```sh
export MODULE_HOT_INSTALL_REQUEST=true       # 这个模块可以立即生效
export MODULE_HOT_RUN_SCRIPT=hotinstall.sh   # 安装器跑完后要执行的脚本
```

规格写得很清楚：

- 管理器会把 `modules_update/<id>` 换成 `modules/<id>`，然后**以 boot 脚本同样的方式**
  执行那个脚本（全局 mount namespace、cwd=脚本目录、stdin=/dev/null、忽略 SIGPIPE、
  **最多等 30 秒**，长期服务要在后台起）
- 立即生效：模块文件、WebUI、`action.sh`、`module.prop`；下次开机生效：`system/`、
  `system.prop`、`initrc`、`service.sh` 等
- **「旧版本不会帮你停」**，有守护进程的模块要自己在那个脚本里先停旧再起新
- 能力探测变量：`KSU_HAS_HOT_INSTALL`

我们 v0.4.9 起的「`cp -a` 同步运行目录」就是在绕这条规格。

改动：

- `customize.sh`：支持热安装时请求并就绪 `hotinstall.sh`；老管理器退回原做法
- 新增 `hotinstall.sh`：`unit.sh stop web` → 后台 `unit.sh start web` → 打印版本，
  严格符合「先停旧、后台起、别让安装器等」三条
- 门禁加上三项检查（文件存在 / 可执行位 / customize.sh 里两个变量），防止退回非规格做法
- 新增 ADR-0015 记录规格原文与取舍
- 版本：v0.6.0 / versionCode 75
- 验证：`sh -n` 通过；门禁 0 FAIL

## v0.5.5

这次是**规范问题**，不是 proot。查到 Termux 的已知问题（termux/termux-app#5078）和
agnostic-apollo 的 Android 文档：Android 12+ 有 **幽灵进程清理（Phantom Process Killer）**
和**缓存应用冻结**，它们是按**进程 cgroup** 下手的，日志长这样：

```text
I ActivityManager: Killing PhantomProcessRecord {...}: Trimming phantom processes
I libprocessgroup: Successfully killed process cgroup uid 10147 pid 5683 in 0ms
```

从管理器（一个应用）里点「操作」起的守护进程，就是那个应用的幽灵子进程。管理器退到后台，
它可能被**冻结**（SIGSTOP）或**整组 SIGKILL**。冻结的样子和我们一直以为的「proot 卡死」
完全一样：端口能连、不回字节、日志停在半句话、进程还活着、心跳停了。

改动：

- `bin/lib.sh` 新增 `protect_pid()`：`oom_score_adj=-1000`（退 `-900`）+ 把 pid 写进
  `/sys/fs/cgroup/cgroup.procs`，尽量脱离应用 cgroup
- `unit.sh`：supervisor 启动时先给自己上保护，每次 spawn 的子进程再各保护一次
  （cgroup 变更不会被子进程继承，`oom_score_adj` 会）
- 新增 ADR-0014，把这条 Android 平台的约束写下来，并说明「开机由 service.sh 拉起」才是
  推荐路径（那是 magiskd 的子进程，不经过应用 cgroup）
- 版本：v0.5.5 / versionCode 74
- 验证：`sh -n` 通过；门禁 0 FAIL

## v0.5.4

「还是一样」这次的原因很具体，日志最后一行就是：

```text
19:53:45 web 已在运行 pid=24765
```

也就是说 **72 根本没装**，而当时跑着的还是 v0.5.1 的 `action.sh`（它只会 `start`）。
24765 是 v0.5.1 那个卡死的 supervisor，它占着 pid 文件 → `start` 回一句「已在运行」
就结束，什么也没做。于是画面永远停在「验证中…」。

这也暴露了一个设计缺陷：**`start` 只看进程是否活着**，卡死的实例会把整个单元锁死，
装新版也救不回来（安装脚本同样走 `start`）。

- `do_start` 增加**卡死自愈**：进程在但心跳文件缺失或超过 `HEARTBEAT_MAX` 秒没更新
  → 判定卡死 → 自动 `do_stop` 再起
- 起之前给旧进程 5 秒退场时间，避免「有未登记的进程」立刻失败
- `do_stop` 杀不掉时明确报出来（`可能卡在 D 状态，重启手机后可清`），不再假装成功
- `customize.sh` 安装后改用 `restart`，装完就能把旧实例换掉
- 版本：v0.5.4 / versionCode 73
- 验证：`sh -n` 通过；用一个 `TYPE=exec` 的假单元验证——心跳过期后 `start` 会打印
  `判定卡死，先停掉再起`、旧 pid 被换掉、新 pid 起来

## v0.5.3

截图说明了一切：页面已经加载出来（说明网关活着跑过），但「进入」按钮下面一直停在
**「验证中…」**。也就是说 `fetch('/_/status?k=…')` 发出去了、连接建了、**没有任何响应**。
这不是 token 不对（那会立刻显示「token 不对」），而是网关的事件循环不动了：
TCP 已被内核接进队列，进程却不处理——和之前「进程活着、端口连不上、日志停在半句话」是同一件事。

所以这版做两件事：把卡死变成可恢复，把原因留下来。

- **心跳**：网关每 30 秒写 `$DATA/logs/web.hb`。事件循环停住 = 心跳停
- **心跳看门狗**（`unit.sh`）：就绪后每 20 秒看一次，心跳超过 100 秒没更新就判为
  「业务卡死、进程不退出」，用 `setsid` 甩出一次 `restart`（最多 5 次，之后放弃并落盘）
- **进程级异常落日志**：`uncaughtException` / `unhandledRejection` / `exit` 都写一行。
  之前 node 崩了外面只能看到沉默
- `unit.conf` 新增 `HEARTBEAT_FILE` / `HEARTBEAT_MAX`
- 版本：v0.5.3 / versionCode 72
- 验证：`sh -n`、`node --check` 通过，门禁 0 FAIL

## v0.5.2

好消息先说：**proot 通了**。

```text
19:45:44 proot 探针通过（完整参数）rootfs=…
19:45:44 proot 启动：mode=full …
```

去掉 `--kill-on-exit` 之后，全参探针一次通过。而且 web.log 里 13:53、13:54 两次都出现过
`[web] listening → https://0.0.0.0:8443/`——网关确实听过端口。

问题变成：**听过，然后没了**。我从设备上直连 8443/8088 都是 TIMEOUT（3080 正常返回 401，
说明网络栈没问题），也就是现在网关不在听。你浏览器里那个页面是它活着时加载的，之后每次
点「进入」都会失败——看起来就像卡在 token 验证。token 校验本身我本地跑了五步全通过
（`?k=` 种 cookie → 带 cookie 200 → `/_/status` 200 → 无凭据 401 → `/module/` 200）。

改动：

- **`action.sh` 脱离管理器的进程组**（`setsid` + `nohup`）。管理器执行完 action 会整组收尾，
  之前就是「启动了、听过端口、几秒后无声消失」，连退出码都没有——最可能死因
- **guest 日志镜像到 `/sdcard/Bridge/Logs`**：proot 里只挂这一个日志目录。之前 guest 的
  `log()` 写不进共享存储，外面看到的就是「proot 启动」之后再无一行
- **就绪判定 `READY_MARKER`**：`units/web/unit.conf` 里写 `READY_MARKER=[web] listening`，
  `unit.sh` 启动后最多等 20 秒；只有进程活着、标记没出现就记 fatal 并带上最后 5 行。
  「已启动」不再等于「能用」
- `action.sh` 也等标记出现再打印地址，并先跑探针
- 修 8088 跳转：Host 带端口时会拼成 `https://192.168.1.3:8088:8443/`（打不开，像卡住）
- 顺带纠正我之前的误判：`/proc/net/tcp` 在 Android 上是 root-only，我先前据此说
  「没有监听」是错的，不能再这么判断
- 版本：v0.5.2 / versionCode 71
- 验证：`sh -n`、`node --check` 通过；门禁 0 FAIL；本地跑通完整 token 流程

## v0.5.1

19:35 那次日志里 v0.5.0 的表现，一行就把问题说清了：

```text
proot 探针失败（完整参数）：proot error: unknown option '--debug=1'.
```

**是我加的 `--debug=1` 这份 proot 根本不认**，于是探针必然失败、直接 78。
v0.5.0 的探针形同虚设——好在它至少把这句原样打了出来，没有变成沉默。

- 去掉 `--debug=1`（并注释住，别再犯）
- 探针没通过时自动做**分级诊断**：裸 rootfs → 加扩展选项 → 加系统 bind → 加 fd bind
  → 加模块 bind，每组 6 秒独立超时；哪一组一加就卡住就在日志里点出来，后续分组不再跑
  （它们都含同样前缀，只会一起卡）
- 全参探针卡住而基础参数能过时，自动用基础参数启动（`mode=minimal`）——真机上
  最可能就是 `--sysvipc`/`--link2symlink` 这组扩展在 sh supervisor 下卡住
- 版本：v0.5.1 / versionCode 70
- 验证：`sh -n` 通过；本地假 proot 分别模拟「加扩展就卡」和「全程卡」，前者约 12 秒
  自动退回 minimal 并缓存，后者两级探针超时后分级诊断在 1-裸rootfs 就定位并停止

## v0.5.0

13:54 那次日志证明 v0.4.9 确实生效了：

```text
web 代码：v0.4.9 @ /data/adb/modules/tinda-bot     ← 安装后同步运行目录起作用了
proot 临时目录：…/cache/proot-tmp                  ← PROOT_TMP_DIR 也生效了
proot 启动：mode=full pkg=io.github.ccch1mneyyy.dsh_app rootfs=…
```

然后就没了。现场取证：

- supervisor（pid 19580）**还活着**（`kill -0` 返回 EPERM）
- 它下面只有 19581 一个子进程，**再没有 proot 的 tracee**
- 8443/8444/8445/8088 **没有任何监听**
- 日志停在 `proot 启动` 那一行，既没报错也没退出

也就是说 proot 在 fork 出 tracee 之前就卡住了，而且一声不吭。

改动：

- **默认去掉 `--kill-on-exit`**：它是我们与 DSH App 命令行唯一的实质差异，且 App 是
  「Java 父进程 + 它」，我们是「sh supervisor + 它」。收尾由 `unit.sh stop` 杀整棵树；
  要复现 App 行为设 `PROOT_KILL_ON_EXIT=1`
- **探针带 `--debug=1` + 手动超时**（0.1×100 或 1×20 秒，超时直接 kill）：卡住时把
  proot 停在哪一步的调试行写进日志，不再只有半句话
- **探针缓存按版本失效**（`$DATA/run/proot.mode` 现在是 `版本|mode`）：升级后必重探一次。
  v0.4.9 正是沿用了上一版的缓存、跳过探针，才又只能靠猜
- `unit.sh` 加**卡死检测**：proot 单元启动 30 秒后单元日志没有增长，直接记
  `疑似卡在 proot` 并带上最后 3 行
- 「操作」按钮改用 `restart`：卡住的旧实例会让 `start` 直接「已在运行」返回，点了没反应
- 版本：v0.5.0 / versionCode 69
- 验证：`sh -n` 通过；门禁 0 FAIL；本地假 proot 验证版本化的缓存会重探、argv 里已无
  `--kill-on-exit`

## v0.4.9

13:45 那次启动的日志看着「不讲道理」：报完 `proot 探针失败` 就再没有下文，也没有
`退出 rc=78`、没有重试。两条结论：

1. **那次跑的根本不是 v0.4.8**。v0.4.8 会先打 `proot 临时目录：…`，日志里没有这一行；
   管理器把新代码放进 `modules_update/<id>`，要下次重启才搬到 `modules/<id>`，
   这中间点「操作」/开机自启跑的还是旧的 `modules/<id>`。
2. 探针之后一行都没有 = 进程在探针里被挂住或被信号带走，所以探针现在带超时和面包屑。

改动：

- **安装后把新代码同步进运行目录**（`customize.sh`）：刷完即生效，不用重启；
  运行目录被标记 remove/disable 时跳过
- 每次启动都记 `代码：vX.Y.Z @ 目录`（`unit.sh`/`service.sh`），再也不靠「有没有某行日志」反推
- `action.sh`（模块「操作」按钮）先打印版本 + proot 探针结论，再启动
- 探针：带 `timeout 20`、去掉 `--kill-on-exit`、前后各一条面包屑；
  `proot-run.sh` 收到 TERM/HUP/INT 时也留一行，不再是半句话
- 版本：v0.4.9 / versionCode 68
- 验证：`sh -n` 通过；门禁 0 FAIL

## v0.4.8

探针第一次把 proot 的原始报错完整打了出来，原因很具体：

```text
proot warning: can't canonicalize /data/data/com.termux/files/usr/tmp/: No such file or directory
proot error: can't create temporary directory: No such file or directory
proot info: Please set PROOT_TMP_DIR env. variable to an alternate location (with write permission).
proot error: can't create glue rootfs
proot error: execve("/usr/bin/env"): No such file or directory
```

**没设 `PROOT_TMP_DIR`**，proot 就退回构建时的 Termux 路径 `/data/data/com.termux/files/usr/tmp`，
那台机器上不存在 → 建不出 glue rootfs → guest 根本没起来，后面所有 exec 必然 ENOENT。
之前那些「interpreter 找不到」全是这一条的后果，不是参数拼错。

从 DSH App 自己的 proot 进程环境里拿到了它真正设的三个变量，照抄：

- `PROOT_TMP_DIR=<pkg>/cache/proot-tmp`
- `PROOT_L2S_DIR=<rootfs>/root/.l2s`
- `PROOT_LOADER=<proot 目录>/libproot-loader.so`（存在才设）

其他同批修掉的真机问题：

- `MODDIR` 与实际脚本位置不一致时按脚本位置走（管理器更新后旧目录会被删，日志里
  出现 `sanitizing the guest path (binding) "/data/adb/modules/tinda-bot": No such file`）
- bind 源不存在时明确报错/跳过，不再让 proot 带着坏参数跑到 execve 才失败
- 退出码 **78 = 环境不成立**（缺 proot/rootfs/node、参数拼不起来）时不再重试：
  之前会原样重试 20 次、把同一段日志刷 20 遍
- 版本：v0.4.8 / versionCode 67
- 验证：`sh -n` 通过；门禁 0 FAIL；本地用假 proot 确认交出去的环境就是
  `PROOT_TMP_DIR/PROOT_L2S_DIR/TINDA_IN_PROOT/PATH` 这几项、argv 顺序与 DSH App 一致

## v0.4.7

v0.4.6 补上 `LD_LIBRARY_PATH` 之后，真机日志里的 `CANNOT LINK` 没了，剩下的是 proot
自己刚起来就退出：

```text
* the program is a script but its interpreter (eg. /bin/sh) was not found;
* the program is an ELF but its interpreter (eg. ld-linux.so) was not found;
...
fatal error: see `libproot.so --help`.
```

也就是说 proot 根本没进到 guest 程序，端口自然不监听。我们拼的参数和 DSH App 自己启动
proot 的命令行差了几项——那是这台机器上唯一被验证过能跑的一份。

- 新增 `bin/proot-run.sh`：**唯一一份** proot 参数，web 与 bridge 共用；照抄 DSH App：
  `--kill-on-exit --link2symlink --sysvipc -L -0`、`/dev/urandom:/dev/random`、
  `/dev/fd`/`/dev/stdin,out,err`、`/sys/fs/selinux` 盖空目录、`/dev/shm`
- 启动前跑一次探针（`proot-run.sh probe`）：proot 起不来就把它的**原始报错**写进
  `/sdcard/Bridge/Logs/supervisor.log`；完整参数不通时自动退回基础参数并记一笔
- 探针结论缓存在 `$DATA/run/proot.mode`，稳态启动不再多跑一次，不影响启动速度
- `unit.sh` 失败时带回的日志从 6 行加到 40 行（proot 报错块本身 7 行，6 行会把
  `execve` 那行截掉）；连续失败放弃重试时，把整份单元日志脱敏放到共享存储
- `run-web.sh` 不再自己拼 proot 参数，也不再依赖 guest 里的 `/usr/bin/env`
- 版本：v0.4.7 / versionCode 66
- 验证：`sh -n` 全部通过；门禁 0 FAIL。真机待确认 `[web] listening`

## v0.4.6

真机日志终于给出了 proot 失败的确切原因：

```text
CANNOT LINK EXECUTABLE "…/lib/arm64/libproot.so":
  library "libtalloc.so" not found: needed by main executable
```

DSH App 里的 `libproot.so` 不是静态链接，依赖同目录的 `libtalloc.so`。我们直接 exec 绝对路径时，
Android 动态链接器不会去 APK 的 lib 目录找依赖，于是 rc=1、端口永远起不来。

- `bin/lib-proot.sh` 探测 `PROOT_LIBDIR`：优先 proot 同目录，找不到再在 `/data/app` 里找
  `libtalloc.so` 所在目录
- `run-web.sh` 与 `run-app-proot.sh` 在 exec proot 前设置
  `LD_LIBRARY_PATH=${PROOT_LIBDIR}:…`；两个单元共用这套修复（bridge 之前也会栽在同一处）
- 版本：v0.4.6 / versionCode 65
- 验证：`sh -n` 通过；守卫 0 FAIL / 1 warn。真机待刷入确认 `[web] listening`

## v0.4.5

- **web 单元改为 `TYPE=proot`**：不再走 chroot。之前 `TYPE=auto` 会在「有 rootfs + unshare 探针
  通过」时选 chroot，真机上 chroot 的 `/sys`、模块只读挂载接连失败，开机早期还会先落到
  宿主直装；现在和 bridge 一样，固定用 DSH App 的 `libproot.so` + `runtime/rootfs`，
  探测不到就 78，不换路径
- `check-module` 增加硬性检查：`units/web/unit.conf` 必须是 `TYPE=proot`
- 文档同步：安全模型、安装、README 里「chroot 只留给 web」的说法全部改掉；
  chroot 代码路径保留但没有单元使用
- 版本：v0.4.5 / versionCode 64
- 验证：`unit.sh explain web` 显示 proot；守卫 0 FAIL / 1 warn

## v0.4.4

- **每次退避重启都带日志**：supervisor 循环在单元退出后把 `<unit>.log` 尾部 6 行写回
  supervisor（因此也进 `/sdcard/Bridge/Logs/supervisor.log`）。之前只有「未确认运行」才带，
  而单元「启动后立刻退出」这种情况（rc=0/1）恰好不带，导致只能看到 rc 看不到原因
- 版本：v0.4.4 / versionCode 63
- 背景：真机日志出现过 `web 退出 rc=1` 与 `rc=0` 交替，但单元日志没被带出来；同时发现
  开发机上的临时网关一直占着 8443，rc=1 很可能就是它导致的端口冲突（已停）

## v0.4.3

- **日志镜像到共享存储**：`bin/lib.sh` 的 `log()` 在写 `$DATA/logs/supervisor.log` 的同时，
  把同一行（已脱敏）追加到 `/sdcard/Bridge/Logs/supervisor.log`，超过 4MB 轮转一份 `.1`；
  DSH App 没有 root 也能直接读，排查不用再截图
- **启动失败自动带日志**：`unit.sh` 在「未确认运行」时把单元日志尾部 30 行写进 supervisor
  （因此也会出现在共享存储），并把整份 `<unit>.log` 脱敏复制到
  `/sdcard/Bridge/Logs/<unit>.log`——chroot 的「挂模块代码失败」这类只写在单元日志里的原因，
  现在一眼能看到
- 新增 `bin/export-logs.sh`：把 `$DATA/logs/*.log` 全部脱敏导出到
  `/sdcard/Bridge/Logs/export/`；`action.sh` 每次点「操作」也会顺带导出
- **模块代码挂载改为三级退让**：真机日志 `[web] 挂模块代码失败` 说明内核不允许对 bind
  再做 `ro` remount。现在依次尝试 `ro,nosuid,nodev,noexec` → `nosuid,nodev,noexec` →
  普通 bind，前两级降级都会打警告；只有 bind 本身失败才 78
- 版本：v0.4.3 / versionCode 62
- 验证：`log` 镜像写入实测；`export-logs.sh` 导出 4 个日志；共享存储只落脱敏内容

## v0.4.2

- **模块管理器里直接更新**：`module.prop` 增加 `updateJson`，指向仓库里的 `update.json`；
  Magisk / KernelSU 检测到 `versionCode` 变大就会出现更新提示，点一下自己下载安装，
  不用再手动导入 zip
- `update.json` 的 `zipUrl` 指向 `dist` 分支的 `tinda-bot-magisk.zip`（孤儿分支 + 强推，
  仓库不会因每个版本多 350KB 历史），`changelog` 指向 `CHANGELOG.md`
- 新增 `bin/publish-update.sh`：改完 `module.prop` 跑一次，自动同步 `update.json`、
  把 zip 推到 `dist` 分支
- 版本：v0.4.2 / versionCode 61

## v0.4.1

真机日志给出的第一条确凿证据：`[web] 挂 /sys（只读）失败`。web 不是「缺 node」，
而是 `unit.sh` 的 chroot 在给 sysfs 做 bind + ro remount 时被内核拒绝，直接 78。

- **/sys 改为可选**：chroot 里只有内核允许 ro remount 才挂；失败就 `umount` 掉半成品并跳过，
  打印「警告：/sys 只读挂载失败，已跳过」。`/proc`、`/dev`、模块目录、状态目录仍然必须成功
- **修正 v0.4.0 的边界**：`run-web.sh` 原来无条件进 proot，会把已经在 chroot 里的 web 再套一层
  （chroot 里没有 `pm`，proot 探测必然失败 → 78）。现在 `TINDA_RF` 非空表示已在受限 rootfs，
  直接跑；否则才探测 proot。规则仍是「受限 rootfs 或失败关闭」，宿主 exec 依旧禁止
- ADR-0012 措辞同步：「只跑 proot」→「只在受限 rootfs（proot/chroot）里跑」
- 版本：v0.4.1 / versionCode 60
- 验证：`sh -n` 通过；chroot 分支不再二次进 proot；守卫 0 FAIL / 1 warn

## v0.4.0

- **业务进程只跑 proot，删掉宿主回退**：宿主是 Android root 域，在那儿跑 node 等于把
  `/data` 和 root 权限交给会被 QQ 消息触发的代码。现在 `run-web.sh` 探测不到 proot/rootfs
  就 `exit 78`，错误里写明 `PROOT_BIN`/`PROOT_ROOTFS`/包名，**不退回宿主 node**
- 删除 `WEB_RUNTIME`（没有 host / auto 档）；宿主侧只剩 `unit.sh`/supervisor 这类生命周期脚本
- `check-module` 固化：`run-web.sh` 必须有 `TINDA_IN_PROOT` 重入保护与「不回退宿主」，
  且不能再出现 `command -v node` + `WEB_RUNTIME` 组合
- 新增 [ADR-0012](docs/adr/0012-业务进程只跑proot.md)，收紧 ADR-0010
- 版本：v0.4.0 / versionCode 59
- 验证：无 proot 环境下 `run-web.sh` 290ms 内以 78 退出并打印两个变量；守卫 0 FAIL / 1 warn

## v0.3.9

- **web 默认也走 proot**：和 bridge 统一运行时——有 DSH App 的 `libproot.so` + runtime rootfs
  就在里面跑网关（rootfs 自带 node/openssl），宿主不需要装 node；探测不到才退回宿主 node，
  都不可用才 78。新增 `WEB_RUNTIME=auto|proot|host`，默认 `auto`（proot 优先）
- 启动日志会写明实际运行时：`web 运行时：DSH proot（…/rootfs）` 或 `探测不到 DSH proot，
  退回宿主 node`
- 探测结果缓存到 `$DATA/run/proot.path`：`pm path` 是 binder 调用，开机时每个单元都探一遍太贵；
  缓存的二进制/rootfs 还在就直接用，不在（App 升级/卸载）就重新探测
- 版本：v0.3.9 / versionCode 58
- 验证：本机（无 proot）走 `auto` 时打印「退回宿主 node」并正常起网关；`PATH` 去掉 node
  且无 proot 时 78 并给出可读原因

## v0.3.8

- **web 不再要求宿主有 node**：真机 root 下 `PATH` 里通常没有 node，之前 `run-web.sh`
  直接 `exit 78`，所以开机日志里一直是「缺 node」，8443 永远起不来。现在检测不到 node 就
  借 DSH App 的 proot + runtime rootfs 再跑一遍自己（只 bind 模块目录与 `$DATA`，rootfs 里
  有 node 和 openssl），失败才 78
- 新增 `bin/lib-proot.sh`：把 `PROOT_PKG/PROOT_BIN/PROOT_ROOTFS` 的探测抽出来复用；
  探测不到就返回 1，由调用方给出可读错误
- `check-module` 增加两条硬性检查：proot 探测库存在、`run-web.sh` 已接回退
- 版本：v0.3.8 / versionCode 57
- 验证：把 `PATH` 里的 node 拿掉跑 `run-web.sh`，332ms 内以 78 退出并打印
  「缺 node：宿主 PATH 没有，DSH App 的 proot 也不可用」；真机 proot 分支待验证

## v0.3.7

- **模块页直接「打开」**：新增 `webroot/index.html`，KernelSU / APatch 的模块卡片会多出
  「打开」按钮，点进去就是状态页（版本、`AUTO_START`、web 运行态、地址、token 复制、
  证书到期、三个下游在线、`web.log` 末尾），并带「启动 / 停止 / 重启 / 打开控制台 / 刷新」
- 页面通过 KernelSU 的 `ksu.exec` 读真实状态、调 `unit.sh`；「打开控制台」用 `am start`
  交给系统浏览器（自签证书在内嵌 WebView 里过不了，不如交给浏览器）
- Magisk 没有 webroot 容器，仍走「操作」按钮 → `action.sh` → 浏览器打开 `/module/`
- 版本：v0.3.7 / versionCode 56
- 验证：webroot 脚本过 `node --check`；`check-module` 增加 webroot 与页面文件的硬性检查；
  zip 内含 `webroot/index.html` 且打包脚本已纳入该目录

## v0.3.6

- **新增模块信息页 `/module/`**（要 token）：版本/版本码、安装与数据目录、`AUTO_START`、
  `web`/`bridge`/`napcat` 的 pid 与存活、web 的监听/证书 SAN 与到期/token 掩码与一键复制/
  运行时长/内存/请求数/附加端口、三个下游在线状态、`web.log` 与 `supervisor.log` 末尾
- 数据走 `/module/data.json`（实时读盘，页面 5 秒自刷）；`/module/token` 仅在已鉴权时
  返回完整 token；导航页头部加「模块」入口
- `action.sh` 起完 web 后直接 `am start` 打开 `/module/`——Magisk 里点「操作」就能看，
  不必手动复制地址（Magisk 没有 WebUI 容器，所以走浏览器）
- `run-web.sh` 导出 `TINDA_DATA`/`TINDA_MODDIR` 给网关读 module.prop、pid、日志；
  chroot 里靠符号链接同样可达
- 版本：v0.3.6 / versionCode 55
- 验证：本机 8443 上 `/module/` 200（含标题）、`/module/data.json` 200 且版本/单元/证书/
  下游齐全、`/module/token` 返回的 token 与文件一致、无 cookie 时 401

## v0.3.5

- **刷完即用，不用先重启**：`customize.sh` 在安装结束前从暂存目录（`$MODPATH`）直接
  `unit.sh start web`（`setsid` 脱离安装进程），并把带 token 的地址打进 Magisk 安装日志。
  模块目录本身仍要重启才生效，但面板不必等——`web` 只依赖 `$DATA` 与模块代码
- 只起 `web`；`bridge`/`napcat` 不在这里起（依赖 QQ/NapCat 登录，留给手动或开机）
- 旧配置没有 `AUTO_START` 时，安装脚本同样按默认 `web` 处理；显式 `off` 才不启动
- 版本：v0.3.5 / versionCode 54
- 验证：模拟 Magisk 环境跑 `customize.sh`，安装日志直接打印
  `https://192.168.1.3:8443/?k=...`；安装脚本退出后进程仍在、8443 可连

## v0.3.4

- **启动提速（实测 `unit.sh start web` 2.4s → 0.4s，`boot-start.sh` 0.6s 返回）**：
  - `ensure_dirs` 里的配置补键不再每行 fork `printf|cut|tr` + `grep`（150 行模板手机上要 2 秒），
    改成先一次性读出已有键再比对：2094ms → 22ms
  - `unit.sh` 启动确认从固定 `sleep 1` 改成 100ms 轮询，进程起来就返回
  - `boot-start.sh`：只配 `web` 时不等 `sys.boot_completed`（bind 端口不需要）；含
    `napcat`/`bridge` 时最多等 20 秒；多单元改为并行拉起
- **修升级路径**：旧配置里没有 `AUTO_START` 这个键时，service.sh 原来按「空」处理 = 不启动，
  从 v0.3.1 升上来的人刷完新版重启还是空白；现在缺键按默认 `web` 处理并补写进配置，
  只有显式写 `off` 才是零动作
- 版本：v0.3.4 / versionCode 53
- 验证：连续三次 `unit.sh start web` 377/422/428ms；`boot-start.sh` 639ms 返回、端口随后 OPEN；
  `conf_sync` 单测 22ms；门禁 0 FAIL / 1 warn

## v0.3.3

- 新增根目录 `action.sh`：Magisk / KernelSU 里点模块的「操作」按钮即可
  `unit.sh start web`，并直接打印 `https://<IP>:8443/?k=<token>` 和 web.log 末尾；
  手机上不用开终端、不用记命令。实测在本机 8443 起网关，`/` 与 `/?k=` 均 200
- 只起 `web`，不动 `bridge`/`napcat`；重复点等于「已在运行」，不会起第二个
- 版本：v0.3.3 / versionCode 52

## v0.3.2

- **开机自启 web（默认）**：新增 `bin/boot-start.sh`，`service.sh` 初始化后把它 fork 到后台
  就 `exit 0`；等 `sys.boot_completed`（最多 90 秒）和逐个 `unit.sh start` 都在后台脚本里，
  开机阶段不再有长 sleep。刷完重启，`https://<IP>:8443/?k=<token>` 自己就能开
- 新增配置 `AUTO_START`，默认 `web`：`napcat bridge web` = 全自动，`off` = 回到旧的
  「开机零动作」。桥接默认仍手动起，避免白名单没配好时开机自动回 QQ 消息
- `bin/check-module.sh` 固化契约：`service.sh` 必须调 `boot-start.sh`，且不许自己出现
  `getprop sys.boot_completed` / `sleep 20`；`boot-start.sh` 必须等开机、读 `AUTO_START`
- **app 测试从 0 恢复到可跑**：`app/test/p1.test.js` 恢复时留了「[MISSING LINE n]」占位和缺行，
  整个文件语法错误、一条都跑不了。补回 /export 与 /health 用例，删掉无法恢复的尾段；现在 14 过 1 跳
- 同步修掉测试暴露的丢失行为：
  - `hardSplit` 回到「按 grapheme 切 + 代码围栏每段补回」，不再把 emoji 家族和代码块切碎
  - `parseActions` 先遮住围栏内的内容，代码示例里的 `[[react:]]` 不会真的去点表情
  - `validateSessionForResume` 支持 `apiMode`：API 传输能续 preset / 运行中的会话，并给出 warning
  - `/help <命令>` 生成单条用法；`/sessions` 带编号和标题，`/ws 2` 可按编号切（编号 10 分钟有效）
- 已知缺口：`app/test/offline/p0.test.js` 恢复时缺 89 行（`[MISSING LINE]` 占位），语法不成立、
  一条都跑不了；所有备份里都是同一份残件，无法恢复，已删除（原件仍留在 `originals/` 与
  `/sdcard/backup`）。它原本覆盖 turn 计数、投递失败、fork/恢复，这部分目前没有回归测试
- 已知缺口：原版四页面板（44px 触控 / 复制 id / `/config` `/logs` `/status` 分页）还没并回
  `app/src/panel.js`，对应用例标记为 skip，等 UI 合并后再打开
- 文档：新增 [ADR-0011](docs/adr/0011-开机自启.md)；更新安装、配置说明、网关、安全模型、
  README 里「默认不自动启动」的表述
- 版本：v0.3.2 / versionCode 51
- 验证：`AUTO_START=off` 不起单元；非法/不存在单元名被跳过并记 warn；`AUTO_START=web`
  在测试端口 18443 起网关，`/ `、`/?k=`、`/_/status` 全 200；门禁与 app/test 见提交。
  真机开机自启仍要在刷入后验证

## v0.3.1

- **bridge 改为 proot 独立 node**：`units/bridge/unit.conf` 从 `TYPE=exec` 改为
  `TYPE=proot`，由 `bin/run-app-proot.sh` 复用 DSH App 的 `lib/arm64/libproot.so`
  和 `files/runtime/rootfs` 启动；不 chroot、不 mount。proot 进程仍由 root 启动，`-0`
  只是 guest 假 root，不是降权
- 只 bind 运行必需面：`/dev /proc /sys /system /apex`、模块 `app/`、`$DATA/state/app`、
  `$DATA/etc/app.json`、从 `headless` 复制的 `qq` profile；**不 bind `/data`、`/sdcard`**
- `-0` 是 proot guest 假 root，不是降权；找不到 proot/rootfs/node、建不了 guest
  目录都退出 78，**不回退宿主 exec**
- 新增 `PROOT_PKG` / `PROOT_BIN` / `PROOT_ROOTFS` 配置；`qq` profile 从 `headless`
  复制并补 `credentials/authorization/deepseek-account`，不覆盖 rootfs 已有的 qq
- `unit.sh` 支持 `TYPE=proot`；`bin/run-bridge.sh` 兼容入口也转到 proot
- 启动仍手动，`service.sh` 零动作；v0.2.37 的 namespace/chroot 安全层未改
- 版本：v0.3.1 / versionCode 50
- 验证：假 proot 验证参数与 qq profile bind；缺 proot 时 exit 78；`unit.sh explain bridge`
  显示 `TYPE=proot`；app/test 7 个测试与模块门禁见提交。真实 Android + DSH App rootfs
  联调还没做
- 注意：proot 不是安全沙箱；它只做假 root/路径映射，bind 进来的目录仍可读写
## v0.3.0

- **单应用合并（阶段一）**：桥接运行时改为根目录 `app/`，由 `bridge` 单元启动；
  `units/legacy` 与旧的 `units/bridge/bridge.mjs` 不再作为运行入口。一个进程、一份
  `$DATA/etc/app.json`、一份状态，不再有“两个桥接二选一”
- 原版能力回到主路径：会话注册表/多工作区（`/ws`）、`/sessions`、`/model`、`/export`、
  DSH API/headless 双传输、管理接口与仪表盘
- 当前安全层并入：策略校验、outbox 补发、图片 SSRF、群上下文；新增 `/context` 查看/清空
  群缓冲，群消息在策略判定前记录，被 @ 时注入最近几条
- 收紧 `/ls`：只允许当前工作区内路径，绝对路径、`..`、符号链接逃逸都拒绝；
  原版能列整个宿主文件系统，属于糟粕
- 修复原版 `config.example.json` 在 80 行处被截断的问题（补全 `inputStatus`/
  `interactions`/`stateFile`），并加入 `behavior.groupContext` 默认值；坏模板会让首次
  启动直接失败
- 删除未接线的 `app/src/panel-client.js`、`qq-gateway.sh`、`qq-guard.sh`、
  `tools/doctor.js`：它们仍带恢复缺行，模块已由 `unit.sh`/`doctor.sh` 承担，
  不再把坏文件带进 zip
- 启动脚本：`bin/run-app.sh` 负责生成/读取 `app.json` 并启动 `app/src/index.js`；
  `bin/run-bridge.sh` 只做兼容转发。`TYPE=exec`，不 chroot、不 mount，v0.2.37 的
  零开机动作/挂载安全层未改
- 版本：v0.3.0 / versionCode 49
- 验证：`app/test/` 6 个测试全过（commands / group-context / http / onebot / onebot-http /
  smoke / turn）；headers/module 门禁通过。真实 NapCat/QQ 仍未联调
- 未完成：当前主桥的 `/output` 四档、typing、磁盘告警尚未搬进 app；面板写 UI 仍是
  原版缺口，阶段二继续
## v0.2.43

- **legacy HTTP 模式真正可接线**：`napcat-wire-onebot.sh` 支持用环境变量
  `BRIDGE_LISTEN` 覆盖事件推送地址，`BRIDGE_LISTEN=127.0.0.1:3002` 即可把
  NapCat 的 HTTP 事件推到 legacy 的 HTTP 监听端口；默认配置不变
- 文档补上完整两条命令，并强调 HTTP 模式只在单独运行 legacy 时使用
- v0.2.37 的开机零动作/挂载安全层未改
- 版本：v0.2.43 / versionCode 48
- 验证：临时 NapCat 配置跑接线脚本，`httpClients[0].url` 为
  `http://127.0.0.1:3002/`；legacy 5 个测试、headers/independence/deps 通过，
  check-module 0 FAIL/1 warn
## v0.2.42

- **原版 legacy 支持 HTTP 模式**：`onebot.mode` 新增 `http`，在 `listenHost:listenPort`
  接收 NapCat POST 事件，再用 `onebot.url` 调 `send_private_msg` / `send_group_msg`；
  `listenPort` 默认 3002，避免和 NapCat 自己的 3001 抢端口
- `config.js` 按模式校验 URL：HTTP 必须是 `http(s)://`，WS 必须是 `ws(s)://`；
  HTTP 模式同样校验 `listenPort` 为 1-65535
- 仪表盘概览新增「OneBot」行，显示模式、在线状态和地址
- 新增 `test/legacy-onebot-http.mjs`：假动作服务 + 真桥接监听，验证 POST 事件
  → 假 dsh → POST `send_private_msg`
- 同步到 `units/legacy/app/`；v0.2.37 的开机零动作/挂载安全层未改
- 版本：v0.2.42 / versionCode 47
- 验证：legacy-smoke / legacy-http / legacy-turn / legacy-onebot /
  legacy-onebot-http 全过；headers/independence/deps 通过，check-module 0 FAIL/1 warn
## v0.2.41

- **legacy 首次启动自动生成可用配置**：新增 `bin/legacy-config.mjs`，从
  `$DATA/etc/bridge-policy.json` 复制真实白名单，从 `NAPCAT_API` 生成
  `ws://127.0.0.1:3001`；没有策略文件才保留模板占位 `"0"`
- `run-legacy.sh` 不再简单 `cp` 模板；生成失败直接 78，不带着坏配置启动
- 文档更新首次启动说明；v0.2.37 的开机零动作/挂载安全层未改
- 版本：v0.2.41 / versionCode 46
- 验证：用临时 DATA + bridge-policy 生成 legacy.json，白名单/URL 正确；
  legacy-smoke/http/turn/onebot 全过；check-module 0 FAIL/1 warn

## v0.2.40

- **legacy 仪表盘升级**：不再用 7 行简化页，改用当前只读仪表盘的完整渲染
  （概览/会话/事件/配置四页 + 自动刷新）；`/state.json` 供页面轮询
- `panel.js` 的 `/` 返回 `renderPanel(snapshot)`；保留 `/api/status`、`/api/sessions`、
  `/api/logs` 和 token 保护的写接口
- `legacy-http` 改为断言「桥接器面板」并继续验证 admin/panel/command
- 同步到 `units/legacy/app/`；v0.2.37 的开机零动作/挂载安全层未改
- 版本：v0.2.40 / versionCode 45
- 验证：legacy-smoke / legacy-http / legacy-turn / legacy-onebot 全过；
  `check-module` 0 FAIL/1 warn；unit start/stop 后 admin 6701 / panel 6702 均 200

## v0.2.39

- **原版 legacy 的 OneBot WS 入站跑通**：假 OneBot WS 发私聊 → 假 dsh → 真实
  `send_private_msg`，回复「WS 回合回复」；修了三处：
  - `index.js` 和 `bridge.attach()` 重复注册 `handleEvent`，同一事件被处理两次
  - `persona.deliverBurst` 把 `shouldStop` 当成 `isCurrent`，WS 路径永远不发正文
  - `parseActions` 返回结构不对，导致回复正文被清空
- 新增 `test/legacy-onebot.mjs`：最小 RFC6455 服务端，验证真实 WS 入站/出站
- 同步修复到 `units/legacy/app/`；v0.2.37 的开机零动作/挂载安全层未改
- 版本：v0.2.39 / versionCode 44
- 验证：legacy-smoke / legacy-http / legacy-turn / legacy-onebot 全过；
  `check-module` 0 FAIL/1 warn；selftest 通过

## v0.2.38

- **原版 `napcat-dsh-bridge` 以 opt-in 单元接回**：`units/legacy/app/` 是从
  `dsh-backup-20261025-1230` 会话记录复原的原始桥接（`bridge.js` 2191 行完整）
- 补齐缺失模块：`onebot.js`（正向 WS）、`store.js`、`persona.js`、`interactions.js`、
  `auth.js`、`panel-config.js`、`export.js`、`state.js`、`audit.js`、`event-log.js`
- 接回 `admin.js` / `panel.js` / `panel-sessions.js`：`/status`、`/inject`、`/command`、
  只读仪表盘可用；原版完整 `panel-client` UI 仍有缺口，当前是简化页
- 原版指令已实测：`/help`、`/status`、`/new`、`/sessions`、`/ping` 均返回 200；
  假 dsh 的完整回合返回正确 `reply`/`sessionId`/`turns`
- `napcat-wire-onebot.sh` 打开 3001 的 `enableWebsocket`，让原版正向 WS 能连；
  HTTP API 仍可用，当前 `bridge` 不受影响
- `units/legacy/unit.conf` 固定 `TYPE=exec`：不 chroot、不 mount；默认不启动，
  v0.2.37 的开机零动作/私有 namespace 安全层完全不动
- 新增 [docs/原版桥接.md](docs/原版桥接.md)；`legacy` 与 `bridge` 不能同时开（会双回复）
- 版本：v0.2.38 / versionCode 43
- 验证：`test/legacy-smoke.mjs`、`test/legacy-http.mjs`、`test/legacy-turn.mjs` 全过；
  `unit.sh` 方式启动 legacy 后 admin/panel 均 200；`check-module` 0 FAIL/1 warn

## v0.2.37

- **真机反馈修复**：v0.2.36 的探针在 Android toybox 上确认 namespace 隔离成功，但
  `mount --make-rprivate` 不可用（toybox 不认 util-linux 的 `--make-*` 写法），
  导致 chroot 被保守拒绝
- 新增 `bin/make-private.sh`：chroot 前把当前 namespace 的传播设为「不回传宿主」。
  依次尝试 `--make-rprivate`、`-o remount,rprivate`、`-o rprivate`、
  `-o remount,private`、`-o private`；每一步后检查 `/proc/self/mountinfo`
  全树没有 `shared:` 才继续；否则退出 1
- toybox 的 `-o rprivate` 实际映射为 `MS_SLAVE|MS_REC`（不是严格 private），
  helper 只把它当「无 shared 的 slave 回退」，日志会写 warn；安全性依赖
  「没有 shared 传播」，不是私有权限本身
- `unit.sh` 的 `chroot_usable()` 与 `spawn_chroot()` 都改为：`unshare -m` 后
  先校验子进程 namespace id 确实变了，再调用 helper；删掉 `--make-private` 单层回退；
  helper 失败/仍有 shared 一律 exit 78。`auto` 探针不过时仍退回 exec
- `mount-probe.sh` 改为调用同一 helper；默认仍不创建挂载，`--mount` 才 bind/remount。
  新增 `prop-probe.sh` 仅用于打印各候选的原始报错和 `mountinfo`，不参与运行时
- 版本：v0.2.37 / versionCode 42
- 验证：shell `sh -n`、check-headers、check-module（0 FAIL/1 warn）、selftest；
  proot 下探针在 namespace 校验处失败关闭、宿主无残留。**真机上的 helper 回退
  尚未验证**；如果 `-o` 写法也不可用，仍会退回 exec，不会在宿主留挂载

## v0.2.36
- **启动/挂载安全重写（事故修复）**：v0.2.35 刷入后出现开机卡很久、系统服务/应用起不来。
  审计定位到 `service.sh` 最多等 `sys.boot_completed` 180 秒 + `sleep 20` 再拉起 4 个单元，
  以及 `unit.sh` 把 `/data/adb` bind 进 `/data/adb/tinda-bot/rootfs/data/adb` 的递归挂载；
  挂载没有 namespace/unmount，会留到重启。v0.2.35 模块包作废
- `service.sh` 改为**开机零动作**：只建目录/补配置/写日志，立即退出；不启动单元、
  不等 boot_completed、不 chroot、不 mount。服务改为手动 `unit.sh start`
- `unit.sh` 的 chroot 改为**私有 mount namespace**：`unshare -m` + `mount --make-rprivate`；
  探针不过就退回 exec，显式 chroot 失败关闭；namespace 退出即销毁挂载
- 不再 bind `/data/adb`、不再挂 `/sdcard`；只挂 `/proc`、`/dev`（nosuid,noexec）、
  `/sys`（ro,nosuid,nodev,noexec）、模块代码（ro）和 `etc/state/logs/run/secrets`；
  宿主路径用符号链接映射
- `napcat/unit.conf` 固定 `TYPE=exec`：Android QQ 是 bionic 二进制，不再被塞进 glibc rootfs
- 旧版递归挂载残留检测：`mountpoint -q <rootfs>/data/adb` 为真时拒绝启动并提示先重启
- 新增 [ADR-0008](docs/adr/0008-启动与挂载安全.md)，更新安装/生命周期/安全模型文档
- 版本：v0.2.36 / versionCode 41；模块 description 改为「默认手动启动」
- 验证：所有 shell 脚本 `sh -n`；`unit.sh explain` 在 proot 里 napcat/bridge/web 均为 exec；
  全套 22 个 JS 测试文件通过；门禁通过。**真实 Android 的 unshare/mount 仍未验证**，
  所以默认不动系统，失败关闭

## v0.2.35
- **P0-3 图片落盘**：新增 `units/bridge/image.mjs`——收到 `image` 段先下载到
  `$DATA/state/bridge/images`，再把本机路径交给模型用文件工具查看，不再只有
  `[图片]` 占位
- 安全边界：只允许 http/https；拒绝 `file://`/绝对路径；默认拒绝 localhost、
  私网、链路本地、多播（含 IPv4-mapped IPv6）；域名先 DNS 解析再逐个地址检查；手动跟 3xx，每一跳重新校验
  （防公网 URL 302 到 127.0.0.1）；content-type 白名单 png/jpeg/gif/webp；
  Content-Length 与流式读取双重大小上限；AbortController 超时
- 默认 10MB / 8 张 / 8 秒；目录 0700、文件 0600；目录已存在时也会 chmod 回 0700；
  文件名时间戳+随机，扩展名只由 content-type 决定
- 成功时任务末尾加「本轮附带 N 张图片，已保存到：…」；全部失败时正文前加
  「有 N 张图片没能读取…」，不让模型假装看过；部分失败在任务里注明
- 配置：`BRIDGE_DOWNLOAD_IMAGES`、`BRIDGE_IMAGE_DIR`、`BRIDGE_IMAGE_MAX_BYTES`、
  `BRIDGE_IMAGE_MAX_COUNT`、`BRIDGE_IMAGE_TIMEOUT_MS`、
  `BRIDGE_IMAGE_ALLOW_PRIVATE_HOSTS`；启动脚本、模板、面板「图片落盘」一行、文档已同步
- 测试：`test-image.mjs` 38 项（私网/映射 IPv6/尾点/协议/DNS/content-type/文案）+
  `test-roundtrip.mjs` 43 项（假图片服务器：成功落盘并给路径、404、错误 content-type、0600/0700 权限）；
  全套 22 个测试文件通过
- 边界：图片上传/导出未做；引用消息里的图片不下载；落盘目录不自动清理；
  没有真 QQ，图片 URL/CDN 行为以假服务器为准

## v0.2.34
- **P0-2 消息层**：新增 `units/bridge/message.mjs`，补齐旧版消息层的七项行为：
  引用回复、`[表情]`、`[戳一戳]`、不支持类型提示、群回复 @、群首次 AI 身份披露、
  群成员级会话
- **引用回复**：收到 `reply` 段先调 NapCat `get_msg` 取被引用消息；能读到就把
  「（引用回复 谁 的消息 「原话」）」拼在任务最前面，读不到明确写「引用消息不可读」，
  不让模型猜。群里「回复机器人那条」且被引用消息 sender 是机器人时按 @ 处理，
  不要求再单独 @
- **表情 / 戳一戳**：`face`/`mface` → `[表情]`，`poke` → `[戳一戳]`，进提示词
- **不支持类型**：`record`/`video`/`file`/`forward`/`json`/`xml`/`markdown`
  记进 `unsupported`；只发这类消息时直接回「暂不支持语音/文件消息…」，不烧 DSH 回合；
  文字 + 附件时在任务末尾注明「本轮还包含暂不支持的消息类型：…」
- **群回复 @**：`send_group_msg` 的 `message` 用 CQ 字符串前缀
  `[CQ:at,qq=<提问者>] `，只加在第一条气泡；补发队列里的回复不补 @
- **首次披露**：按 chatKey 只发一次（成员级会话时每个成员一次）；纯动作轮没有正文，
  不发披露。文案随成员级/每群一条变化
- **成员级会话**：`BRIDGE_GROUP_SESSION_SCOPE=member` 时 key 变成
  `group:<群号>:<QQ>`，同群两个人各自续自己的 DSH 会话；默认仍是每群一条
- 配置：`BRIDGE_GROUP_REPLY_AT`、`BRIDGE_AI_DISCLOSURE`、`BRIDGE_GROUP_SESSION_SCOPE`；
  `bin/run-bridge.sh` 与 `etc/tinda.conf.example` 已同步，面板加「消息层」一行
- 测试：`test-message.mjs` 28 项纯函数；`test-roundtrip.mjs` 36 项（新增引用可读/不可读、
  表情、戳、语音-only、群 @、首次披露、回复机器人算 @）；`test-headless.mjs` 15 项
  （新增成员级会话两个 key）；其余 bridge 测试文件全部保持通过
- 边界：图片仍只写 `[图片]`，没有下载/直传；流式、打断、熔断、会话归属仍未做。
  引用只取文字/图片数，不下载引用里的图片；`get_msg` 失败按「不可读」降级

## v0.2.33
- **P0-1b 修正 `[[recall]]` 语义**：P0-1 把它做成了「删本轮气泡」，模型说
  「正确的是 X + [[recall]]」时会把刚发的 X 也删掉。现在按聊天在内存里记
  `lastBubbles`（上一轮气泡 id），`[[recall]]` 只删上一轮，本轮正文留在聊天里
- 旧版 `emit()` 是「先动作、后发正文」，所以 recall 天然删上一轮；P0-1 改成了
  「先正文、后动作」（为了动作不挡正文），必须显式把上一轮 id 传进
  `runActions({ currentIds, prevIds })`。`currentIds` 只用于日志，不再当 recall 目标
- 没有上一轮（第一次对话 / 刚重启 / 上一轮是纯动作）时：recall 记 skipped，
  日志 `warn: 没有上一轮气泡可撤回`，这一轮不算失败
- 纯动作 `[[recall]]` 不发空消息，只删上一轮；`lastBubbles` 只存内存不落盘
  （旧 id 在 NapCat 会话结束后不可删，重启后陈旧 id 反而会报错）
- 提示词改口：`[[recall]] 撤回你上一轮发出的气泡（用于"上一句说错了，整段纠正"）；
  本轮正文不会被撤回。` 不再说「撤回本轮」
- 测试：`test-interactions.mjs` 58 项（新增 runActions 只删 prevIds/不删 currentIds、
  无上一轮 skipped）、`test-interactions-wire.mjs` 52 项（新增两轮、首次 recall、
  纯动作 recall、上一轮纯动作、连续三轮、总关闭、delete_msg 失败等场景）。
  **修正一条旧错断言**：P0-1 的「分条后逐条撤回」测的是「删本轮」，正是本 bug；
  现在改为「第 1 轮分条 → 第 2 轮 recall 只删第 1 轮 id，第 2 轮正文保留」
- 未做可选项：交互提示「已注入」标记与面板 `interactionTotals` 落盘（仍只存内存，
  重启后每个会话重注一次、面板计数清零）

## v0.2.32
- **P0-1 交互动作**：新增 `units/bridge/interactions.mjs`——模型在正文里写
  `[[react:赞]]` / `[[recall]]` / `[[poke]]`，桥接器执行后把标记从可见正文里删掉
- 表情回应：给用户那条消息调 `set_msg_emoji_like`（`emoji_id` 字符串）；中文名映射
  赞=76、爱心=66、笑哭=182、鼓掌=99、疑问=32、捂脸=264，数字 ID 原样传
- 撤回：`sendReply()` 改为返回 `data.message_id`，本轮每条气泡的 id 都收集；
  `[[recall]]` 等正文发完后逐条 `delete_msg`（分条时也是逐条删；**v0.2.33 已修正为「删上一轮」**）
- 戳一戳：私聊 `friend_poke`、群 `group_poke`；群默认关，打开配置才发
- **正文优先**：先发正文、再在总时限内执行动作；动作报错/超时只记
  `warn: 动作执行异常`，正文照常送达；纯动作回复不发空消息
- 解析：代码围栏（跨多行/未闭合）内不执行；每轮最多 N 个，多余的丢掉并记
  `忽略多余动作`；删标记后不留双空行，段落缩进不动
- 提示注入：每个 DSH 会话第一次拼 prompt 时注入一段短提示，内存 Set 按会话 id 记；
  `BRIDGE_INTERACTIONS=0` 时既不解析也不注入
- 配置：`BRIDGE_INTERACTIONS`、`BRIDGE_INTERACTIONS_GROUP_POKE`、
  `BRIDGE_INTERACTIONS_MAX`、`BRIDGE_INTERACTIONS_TIMEOUT_MS`；面板加「交互动作」一行
  （开关 + 最近一轮执行/失败数，不记正文）
- 测试：`test-interactions.mjs` 49 项（纯解析/围栏/上限/映射/空白/提示）+
  `test-interactions-wire.mjs` 33 项（假 NapCat + 假 DSH：正文无标记、撤回删对 id、
  群 poke 默认关/开关后发、纯动作不发空消息、动作 API 报错正文照发、总关闭原样保留、
  提示只注入一次、分条后逐条撤回）
- 推断说明：旧 `src/interactions.js` 已丢失（0% 可恢复），本版按 `bridge.js` 的调用点、
  任务书与 `docs/待恢复清单.md` 的证据重写；解析细节（未知动作原样保留、空参数不执行）
  是本次定的规则，不是逐字复原

## v0.2.31
- **补回「输入状态」（③ 的漏项）**：旧桥接器每轮私聊都会调 NapCat 的 `set_input_status`
  亮「正在输入…」，这次重建时整块丢了。新增 `units/bridge/typing.mjs`——
  开始即亮、每 8 秒续期、`finally` 里必关；只对私聊发（NapCat 只实现了 C2C）
- 配置：`BRIDGE_TYPING`、`BRIDGE_TYPING_KEEPALIVE_SEC`；面板加一行「输入状态」
- 对照旧源码的结论：分条回复与延迟回复**没丢**（`humanize.mjs` 已实现），
  但参数比旧版保守（3 条/240 字/350–1800ms 对旧版 6 条/320 宽/700–5200ms），
  旧 persona 的默认值已存进 `docs/拟人化-复原对照.md`
- 测试：`test-typing` 15 项、`test-typing-wire` 9 项（私聊亮起、结束必关、群里不发、开关能关）
- 顺手修 `test-commands-wire` 的过期断言：`/output` 在 v0.2.28 已转正，测试还在要求它回「还没实现」

## v0.2.30
- 修掉 `token is invalid` 的**根因**：NapCat 的登录凭据只存在浏览器 `localStorage`，
  而网关只把 token 补进「转发给下游」的查询串——SPA 读的是**浏览器地址栏**，补了个空
- 现在网关自己登录：`POST /api/auth/login {hash: sha256(token+'.napcat')}` 换 Credential，
  返回一张引导页写 `localStorage.token` 再跳回面板。地址栏不出现 token，凭据 45 分钟复用，
  1 小时过期后刷新一次自动续。换不到（NapCat 没起/没配 token）就退回它自带的登录页
- 控制台「重置面板」按钮和 `/reset` 保留：清浏览器凭据仍然是最快的排障手段
- 测试：`units/web/test-gateway.mjs` 加 7 条（引导页写入 Credential、不泄露 token、
  首屏只登录一次、第二入口复用缓存、带标记时直接反代、`__login` 不透给下游）

## v0.2.29
- 修复「NapCat 面板提示 token is invalid 却没地方救」：新增 `/reset` 页（8443 与各面板端口都有），
  清掉该 origin 的 `localStorage`/`sessionStorage` 与网关 cookie 后回首页
- 控制台右上角加「重置面板」按钮，直接打开 NapCat 独立端口的 `/reset`
- RUNBOOK 补这条：`token is invalid` 是 NapCat 服务端对错误 hash 的原话（实测复现），
  凭据只存在浏览器里、1 小时过期，清掉重进即可

## v0.2.28
- **输出四档（⑤）**：新增 `units/bridge/output.mjs`——minimalist / concise / detailed / complete，
  按 `dsh headless --json` 的 `thinking` / `tool_call` / `tool_result` / `text` / `final` 事件渲染
- `/output` 转正：无参打印当前档位（带 ▸，旧机器人原文格式），有参切换并回「下一轮生效」；
  档位**每个聊天一份**，落 `state/bridge/output.json`，默认 minimalist
- **自动压缩（⑤）**：headless 没有 `/compact`（实测它只会自己写段摘要），所以做成
  「聊满 N 轮 → 让 DSH 压成 ≤400 字摘要 → 换新会话 → 摘要放提示词最前面」，
  默认 15 轮，0 关闭；摘要落 `state/bridge/summaries.json`
- **维护期自动回复（⑤）**：新增 `units/bridge/relay.mjs`——连续失败 N 次后统一回维护文案，
  冷却内只回一次，成功即复位
- 配置：`BRIDGE_OUTPUT_DEFAULT`、`BRIDGE_AUTO_COMPACT_ROUNDS`、`BRIDGE_RELAY*`；
  面板加「输出档位 / 自动压缩 / 维护期回复」三行
- 自测：`test-output.mjs` 14 项 + `test-relay.mjs` 8 项 + `test-output-wire.mjs` 13 项
  （假 dsh 产出完整事件流，验证四档差异、档位按聊天隔离、自动压缩落摘要、连续失败进维护期）

## v0.2.27
- **群上下文（④）**：新增 `units/bridge/group-context.mjs`——每个群一段内存环形缓冲，
  只用纯文本，被 @ 时把最近几条拼进提示词（`[群聊上下文] …`），排除当前这句
- 没 @ 的群消息也进缓冲（否则被 @ 时上下文是空的）；字数不够时丢最旧的，保留「刚才在聊什么」
- 上限：每群 8 条、每条 300 字、最多 50 个群、2 小时过期、注入块 ≤1200 字
- 只在内存：不落盘、不进日志、面板只显示「几群/几条」没有正文
- `/context` 从「未实现」转正：看本群缓冲与下一条注入预览；`/context clear`（admin）清空
- 配置 `BRIDGE_GROUP_CONTEXT` / `_MAX` / `_CHARS`；面板加「群上下文」一行
- 自测 `test-group-context.mjs` 15 项 + `test-group-context-wire.mjs` 11 项（断言注入内容）

## v0.2.26
- **拟人化投递（③）**：新增 `units/bridge/humanize.mjs`——按标点断句、每条 ≤240 字、最多 3 条，
  条间按「字数 × 25ms」估打字时间（夹 350–1800ms、±25% 抖动），总等待封顶 4s
- 代码围栏整块不拆；超过条数上限时剩下的并进最后一条（刷屏比一条长更烦）
- 只有模型回复分条，命令回执仍是一条（`/help` 那种表格拆开就看不懂）
- 发到一半失败：已发的算数，剩下的进补发队列，不重发前面的
- 配置 `BRIDGE_HUMANIZE` / `_MAX_BUBBLES` / `_MAX_CHARS` / `_TOTAL_DELAY_MS`；面板显示节奏与最近分条
- 自测 `test-humanize.mjs` 16 项（纯计划）+ `test-humanize-wire.mjs` 10 项（真起桥接器数分段）

## v0.2.25
- **命令表（②）**：新增 `units/bridge/commands.mjs`，按旧机器人 `/help` 原文重建 23 条命令与别名
  （`/help /status /ping /new /stop /sessions /session /policy /notice` 已实现；
  `/context /ws /ls /model /effort /output /persona /balance` 标注「还没实现」；
  `/compact /export /feedback /goal /permission /plan` 原样透传给 DSH）
- 本地命令不进队列：`/stop` 才可能停掉正在跑的那一轮（排在队尾会永远等不到）
- 角色门槛：`/sessions all`、`/session use`、`/model`、`/effort`、`/output`、`/balance` 要 admin，
  `/permission` 只有 owner；不够就回「没有权限 + 当前角色」
- 不认识的 `/xxx` 有回执，不再沉默；命令一律不进模型（`/` 开头必不成为对话内容）
- 面板新增「命令」计数与「常用命令」；`snapshot()` 暴露 `commands.total/top`
- 文档：`docs/命令表-help原文.md` 补「实现状态」表；自测 `test-commands.mjs` 18 项 +
  `test-commands-wire.mjs` 19 项

## v0.2.24
- **回复策略（①/⑤ 的第一项）**：新增 `units/bridge/policy.mjs`，移植自旧桥接器完整救回的
  `src/policy.js`（白名单、群必须 @、owner/admin 分级、空白名单即拒绝、危险默认拒绝启动）
- 接入事件入口：自己 → 用户白名单 → 群白名单/模式 → 是否 @，被拒只记元信息不回消息
- 群里「只 @ 不写字」不再被当成空消息丢掉（会交给策略判定，避免 @ 了没反应）
- 面板新增「回复策略 / 策略来源 / 被拒原因」与「策略拒绝」计数；`doctor.sh` 加一段策略检查，
  未加固会 warn（谁都能触发）
- 配置：`BRIDGE_POLICY_FILE`（缺省 `$DATA/etc/bridge-policy.json`），模板 `etc/bridge-policy.example.json`；
  文件不存在用默认策略（私聊全接 + 群必须 @，标未加固），不阻断启动
- 自测：`test-policy.mjs` 24 项（纯函数）+ `test-policy-wire.mjs` 18 项（真起桥接器走一遍）

## v0.2.23
- **修「重启后答非所问」**：新增 `BRIDGE_MAX_EVENT_AGE_SEC`（默认 120 秒）——NapCat 断线重连会把
  积压事件补推上来，以前会在重启后一串回答十几分钟前的消息，看着像乱答；现在超过 2 分钟的旧事件
  直接记 skip、不回答
- **去重跨重启**：已处理的 `message_id` 落盘到 `state/bridge/seen.json`（最近 500 条），
  以前只在内存里，桥接器一重启就可能把同一条再答一遍
- **自助恢复会话**：私聊发 `/reset` 清掉该聊天的 DSH 会话映射、`/session` 查当前 session id；
  群聊不响应（避免任何人重置大家的会话）
- **测试**：`test-roundtrip` 18 → 22（控制命令 3 项、过期事件 1 项）

## v0.2.22
- **rootfs 复制模式**：`magisk-provision.sh --from` 默认用 tar 管道**复制**（新 inode，
  排除 `proc/dev/sys/sdcard/data`，保留符号链接与权限），`--link` 才用硬链接克隆。
  这样可以直接把这台手机 App 里装好的 Ubuntu（含 node/DSH/QQ 登录态）复制成模块的 rootfs，
  不用重新 apt/npm，也不怕两边互相改文件
- **日志更准**：`service.sh` 有 rootfs 时检查 rootfs 里的 node（而不是 Android PATH 的），
  开机日志能直接看出「rootfs 里没 node」；`unit.sh` 缺 `chroot` 命令时明确报错
- **文档**：安装文档给出直接复用手机现有环境的命令（7.7G、几分钟）、路径变化时怎么查、
  以及「proot 与模块两套不要同时占 8443」

## v0.2.21
- **chroot 落地**：单元改 `TYPE=auto` —— Android root 且有 `/data/adb/tinda-bot/rootfs/usr`
  才走 chroot，否则宿主直装；chroot 前把 `/data/adb`、`/sdcard`、`/proc`、`/dev`、`/sys`
  挂进去，代码/配置/日志/状态仍是 Android 侧那一份
- **rootfs 供给**：新增 `bin/magisk-provision.sh`（`--check` / `--from` / `--tarball`）：
  不带 `.sha256` 的 tar 包默认拒绝，非空 rootfs 默认拒绝覆盖；解包后打印装 node/dsh 的命令
- **可观测**：新增 `unit.sh explain <单元>`（打印 exec 还是 chroot），`service.sh` 重写为
  自带初始化 + 写 `$DATA/logs/module.log`（含形态、rootfs、node、每个单元的启动结果），
  不再依赖 `customize.sh`（KernelSU/SukiSU 不保证执行它）
- **模块门禁**：`check-module.sh` 增加 `unit.conf` 的 `TYPE` 校验与 `module.log` 检查
- **文档**：安装文档补 KernelSU/SukiSU 的 `ksud module install` 与 rootfs 三节；ADR-0005 补「落地」

## v0.2.20
- **Magisk 形态补齐**：修掉 `bin/lib.sh` 的数据目录判定 bug —— 以前首次安装时
  `/data/adb/tinda-bot` 还不存在，状态会落进模块目录，升级即丢；现在按模块自身路径
  （`/data/adb/modules/*`）直接认 `/data/adb/tinda-bot`
- **可刷性检查**：新增 `bin/check-module.sh`（module.prop 字段/id/versionCode、shebang、
  可执行位、CRLF、`service.sh` 是否真拉单元、有无自带 node），带 `--selftest` 反向用例；
  `customize.sh`/`uninstall.sh` 补 shebang，脚本统一 0755
- **出包**：新增 `bin/make-module.sh`，只打运行需要的 69 个文件（不含 `.runtime/.git/originals/local`），
  产出 `/sdcard/Download/DSH-Go/tinda-bot-v0.2.20-magisk.zip` + `.sha256`，并 `unzip -t` 校验
- **文档**：新增 [docs/安装-Magisk.md](docs/安装-Magisk.md)（前提、刷入、验证、卸载、回滚）与
  [ADR-0005](docs/adr/0005-magisk形态与chroot.md)（为什么模块只管生命周期、Linux 栈放 chroot）；
  清单 S-1/S-4 仍如实标 ⚠️：真机 root 与运行时来源都没验
- 说明：本机是 App 内 proot（无 `/data/adb`、无 `getprop`），只能「按模块格式准备好」，
  刷入与开机自启必须在真机 root 环境完成

## v0.2.19
- **T-4 资源上限**：桥接器/网关按配置设 V8 堆上限（`BRIDGE_HEAP_MB=256` / `WEB_HEAP_MB=192`，
  夹在 64–2048），node 单元 fd 软上限 `UNIT_MAX_OPEN_FILES=4096`；`doctor.sh` 新增
  「资源与依赖」段，直接读 `/proc/<pid>/cmdline` 与 `limits` 核对「实际生效」，
  而不是看配置里写了什么（PID 文件里是看守 shell，不是 node，这一点也一并修了）
- **T-8 断网补发 + 去重**：回复发不出去先原地退避重试（`BRIDGE_SEND_RETRY`），仍失败进
  `$DATA/state/bridge/outbox.json`（0600、最多 100 条、`BRIDGE_OUTBOX_TTL_MS` 过期丢弃），
  恢复后按 `BRIDGE_SEND_DRAIN_MS` 自动补发；NapCat 重推同一 `message_id` 只回答一次（窗口 500 条）
- **O-4 告警**：连续失败（`ALERT_FAIL_STREAK`）与磁盘占用（`DISK_ALERT_PERCENT`）可推到
  `ALERT_QQ` 私聊，同一类按 `ALERT_COOLDOWN_SEC` 节流；判定抽到 `units/bridge/alerts.mjs`，
  面板显示「已发/被压/最近一次」，`doctor.sh` 也报数据分区占用
- **S-9 依赖锁定**：新增 `bin/check-deps.mjs` + `bin/check-deps.sh`，只允许 `node:` 内置与
  相对路径；出现 `node_modules` / `dependencies` / 裸模块名即失败，已装进 pre-commit 与
  `doctor.sh`。本仓库零第三方依赖，因此没有 lockfile 与 `npm audit` 可做（没有依赖可审计）
- **面板**：概览新增「待补发」卡片与告警/磁盘信息行；配置新增「回发与告警」组；
  事件流记录「回复已入补发队列」「补发成功 / 超时丢弃」
- **配置清理**：运行态 `tinda.conf` 删掉 13 个旧键（`PORT_MODE` / `NODE_MAX_OLD_SPACE_MB` /
  `NAPCAT_WS_*` 等，代码不读），原文件备份为 `.bak-<时间戳>`；`snapshot.sh` 修掉
  「原因里带斜杠导致快照嵌进多层目录」的问题
- **测试**：`test-roundtrip` 11 → 18（重试、去重、补发）；新增 `test-alert` 9 项；
  合计 78 项全过；README / RUNBOOK / 配置说明 / Bridge 面板 / 生产就绪清单 / 安全模型 / AGENTS 同步

## v0.2.18
- 文档：新增《v0.2.18 全量复查报告》《Bridge 面板》《网关》，把问题清单、路由/状态契约、
  鉴权流程、失败模式与残余风险写成可查文档；生命周期补 `unit.sh stop` 的进程树语义
- **Bridge 面板重做**：会话/事件改成手机优先卡片（不再用需要横向滚动的表格）；
  配置页按组展示只读键值；事件支持成功/失败/跳过筛选；补手动刷新、自动刷新暂停、
  离线/401/超时错误条；会话 id 可复制；增加“跳过”计数与事件
- **修面板真实 bug**：页面直接开 `/panel/` 时，原代码会去取 `/panel/panel/state.json` 而永远
  连不上；现在页面相对取 `state.json`，桥接器同时提供 `/state.json` 与 `/panel/state.json`，
  `/`、`/panel/`、`/bridge/` 三种挂载都通；`GET /` 固定返回 HTML，`/healthz` 固定 JSON
- **网关安全**：`WEB_TOKEN` 为空直接拒绝启动（`WEB_ALLOW_NO_TOKEN=1` 仅本机调试）；
  cookie 改 HttpOnly，导航页不再把 token 拼进 iframe URL，`?k=` 加载后从地址栏抹掉；
  转发给下游前去掉 `tinda` cookie；`/logout` 清 cookie；`/bridge` 补 308 斜杠；
  DSH 401 只在 HTML 请求时换说明页，API 请求原样透传
- **桥接器健壮性**：DSH 会话失效（unknown session）自动清映射并重开一次；
  子进程提前退出时接住 stdin EPIPE，不再拖垮整个桥接器；DSH 输出/stderr 有上限；
  事件备注先脱敏再截断；SIGTERM 时一并收掉正在跑的 DSH 子进程；端口占用打印原因后退出
- **配置**：删除从未实现的 `BRIDGE_PANEL_PORT` 死键（面板与桥接器同端口，网关从
  `BRIDGE_LISTEN` 推导）；`ensure_dirs` 从 example 补缺键且不覆盖已有值；
  修复 `grep -F "^KEY="` 把 `^` 当字面量导致配置永远读不到、并反复追加重复键的 bug；
  token 空文件会补成 32 位十六进制；证书 SAN 不覆盖当前 IP 时自动重签；`WEB_HTTP_PORT` 真正接线
- **清理**：删除无法通过 `node --check`、且缺 `dsh/model/onebot/store` 实现的旧 `app/`，
  以及指向它的 `bin/run-bot.sh`、旧 bare 仓库脚本 `setup-git.sh`/`autocommit.sh`；
  契约检查器迁到 `bin/check-contracts.mjs`，契约 `implementedBy` 清空并如实告警；
  新增 `bin/install-hooks.sh`；`snapshot.sh` 修成全项目快照（以前漏掉 bin/units/contracts）
- **测试**：新增 `units/web/test-gateway.mjs`（16 项：鉴权/cookie/反代/401/失败关闭）；
  `test-panel` 扩到 23 项；`test-headless` 扩到 12 项（含会话失效重开）
- 文档同步：README / RUNBOOK / 配置说明 / 安全模型 / 生产就绪清单 / 接口与适配 / ADR-0004
  / contracts README；`module.prop` 修正「只监听 Unix socket」的过期描述并升到 v0.2.18

## v0.2.17
- 备份瘦身与可恢复：备份前 `git gc`，`.git` 从 404 个散对象文件降到 31 个
  （一次备份 681 → 322 个文件）；额外生成单文件 `repo.bundle`（220KB），
  `/sdcard` 的 FUSE 挂载会让 `git` 报 dubious ownership，bundle 不受影响，`git clone` 即可还原
- `RUNBOOK.md` 新增 §8.5：备份到底由什么组成（历史和快照占大头）、两种恢复方式（已实测）
- `AGENTS.md` 两条规则改成现行做法：源码目录 `app/` → `units/`；
  「一律 Unix socket」与实际（回环 TCP + 对外 8443 带 token）不符，改成带例外的表述

## v0.2.16
- 两份文档改成通用文件名，放仓库根：
  `docs/编码规范.md` → `AGENTS.md`（AI 工具和人都先读这个），
  `docs/操作手册.md` → `RUNBOOK.md`（运维手册的标准叫法）
- 全仓库的交叉引用同步更新；历史 CHANGELOG 条目保持原名不改

## v0.2.15
- 文档按当前真实流程重写：新增 `docs/操作手册.md`（九节，每条命令都实跑过），
  `README.md` 重写，`docs/配置说明.md` 只留真实存在的配置
- 旧实现的记录归档到 `docs/历史-变更记录.md`；`docs/命令表-help原文.md`、
  `docs/output-模式.md` 标注为「未实现素材」；生命周期/安全模型/生产就绪清单/接口与适配按现状改写
- `etc/tinda.conf.example` 对齐代码：删掉 PORT_MODE/SOCKET_PATH/NAPCAT_WS_* 等已不读的键，
  补上 BRIDGE_* / NAPCAT_API / WEB_*_ORIGIN_PORT 等真在用的键
- `bin/lib.sh`：`$DATA` 按「/data/adb/tinda-bot 在不在」判定，仓库内直跑退到 `.runtime/`；
  首次运行自动把 example 铺成 `$DATA/etc/tinda.conf`
- `bin/unit.sh`：外部单元状态改为探活（`PROBE_URL`），本机没有 curl 时用 node 探
- `service.sh`：之前漏了 `web` 单元，开机不会拉起控制台，补上并写明顺序
- `bin/doctor.sh` 重写：环境/权限/单元/端口/OneBot/面板/网关/备份/git/最近错误十段，任一项 FAIL 退出码 1
- `units/napcat/unit.conf` 从容器改回真实形态（`TYPE=exec` + `bin/napcat-start-host.sh`）
- `bin/napcat-install-host.sh` 补上注入步骤（写 launcher、改 `package.json` 的 `main`）；
  更正文档里「安装会编 gnutls-shim」的说法——QQ 3.2.34 下不需要

## v0.2.14
- 接通 NapCat 的 OneBot 11：`bin/napcat-wire-onebot.sh` 写 `httpServers`（127.0.0.1:3001，带 token）
  和 `httpClients`（事件推送到桥接器 6700），token 落在 `$DATA/secrets/napcat.token`（0600）
- 新增 `bin/napcat-start-host.sh`：Xvfb + QQ 主进程 + launcher 注入，一个入口把 NapCat 拉起来
- QQ launcher 支持快速登录：自动从 `onebot11_<uin>.json` 取账号补 `-q <uin>`，
  重启 NapCat 不用重新扫码
- headless 后端接上 App 的账号登录态：headless profile 默认关掉了交互式凭据库与账号插件
  （上游假设一次性任务用启动时给的 API key），本机没有 API key，所以在
  `$DSH_HOME/profiles/headless/cordis.patch.yml` 里重新打开并把默认模型指到 `deepseek-account`

## v0.2.13
- 桥接器补回网页面板 `units/bridge/panel.mjs`：概览（后端/运行时长/收到/成功/失败/排队）、
  会话表（chatKey → DSH 会话 id、条数、最近、耗时、是否在处理）、事件流（最近 100 条元信息）、只读配置
- 事件流只记「哪个聊天、多久、成没成」，不记聊天正文；配置里的 token 只显示「已设置/未设置」
- 面板用相对路径取状态（`panel/state.json`），挂在 `/bridge/` 前缀下面也不会失效
- 新增自测 `units/bridge/test-panel.mjs`（16 项，假 OneBot + echo 后端，不碰生产实例）

## v0.2.12
- 三个面板各自独立端口：`WEB_DSH_ORIGIN_PORT`（默认 8444）、`WEB_NAPCAT_ORIGIN_PORT`（默认 8445），
  根路径直通下游。DSH 与 NapCat 的前端都写死绝对路径（`/webui/assets`、`/api/…`），挤在 8443 的前缀
  下面必然白屏，改了前缀也改不动它们编译好的产物
- 导航页按端口拼 iframe 地址（`PORTS` 由网关注入），并带上 `?k=` 让独立端口也能认人
- NapCat 的 `token` 查询参数只补给页面请求，不补给 `/api/*`：实测 `/api/auth/login?token=…`
  会让它直接返回 `Unauthorized`，面板因此一直白屏
- DSH 的 401 由网关换成有说明的 HTML 页，不再给 iframe 一片空白
- 删除网关里「cookie 加 HttpOnly」的做法：页面自己要用 `document.cookie` 判断登录态

## v0.2.11
- 桥接器最小实现 `units/bridge/bridge.mjs`：OneBot 11 HTTP 事件入口（`POST /`）+ `GET /healthz`，
  回发走 OneBot HTTP API（`send_private_msg` / `send_group_msg`），同一聊天串行排队
- DSH 后端适配层：每轮 spawn `dsh headless --json`，任务走 stdin，会话 id 落盘后下一轮 `--session-id` 续接
- 自带两套自测：`units/bridge/test-roundtrip.mjs`（回路 11 项）、`units/bridge/test-headless.mjs`（适配层 9 项）
- 新增 `bin/run-bridge.sh`（装配环境后 exec，不重试不探活）与 `bin/rootfs-clone.sh`（硬链接克隆 rootfs）
- 桥接器接入单元管理：`units/bridge/unit.conf` → `bin/run-bridge.sh`，`HEALTH_PORT=6700`

## v0.2.5 – v0.2.10
- v0.2.5 每次更新落一份完整目录到 `/sdcard/backup`（含 `.git`、`originals/`，保留 20 份，`SHA256SUMS` 自校验）
- v0.2.6 补齐头注释与模块级配置文档、各加一道可执行门禁，补 `2026-11-15` 变更记录
- v0.2.7 接入 GitHub 远端；22 端口被封，改走 `ssh.github.com:443`
- v0.2.8 NapCat 离线优先的容器内安装器与安装文档
- v0.2.9 本机构建 NapCat rootfs（ubuntu 24.04 + node 24 + Qt 运行时依赖）
- v0.2.10 NapCat 降级为外部依赖：模块只拉起、探活、退避重启，不参与登录/版本/配置

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

## v0.2.9
- 在本机构建 NapCat 独立容器（Ubuntu 24.04.4 arm64 + Node 24.22.1 + Qt 依赖 + 中文字体，717 MB）
- 记录 chroot 构建方法：宿主 apt download + dpkg-deb -x，绕开 proot 下 dpkg 维护脚本失败

## v0.2.10
- 明确 NapCat 是外部依赖：模块只负责拉起容器与探活，不管理登录/配置/版本
