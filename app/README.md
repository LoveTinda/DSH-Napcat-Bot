# QQ ↔ DeepSeek Harness 桥接

把 QQ 变成 DSH 的对话入口。每个会话对应一条持久 DSH session，所以它有记忆；
同时把 DSH 交互式 UI 的那套操作（/`compact`、工作区、`@` 文件引用）在 headless
通道上做了等价实现。

```
 QQ 客户端
    ↕  腾讯服务器
 NapCat（LinuxQQ arm64 + Xvfb，跑在本机 proot 容器里）
    ↕  OneBot 11 正向 WebSocket  ws://127.0.0.1:3001
 桥接器（Node，零第三方依赖）
    ↕  spawn + NDJSON 事件流
 dsh --profile qq --json [--session-id <id>] [--patch <模型覆盖>]
```

## 快速开始

日常只用 `tinda`——它已经把这个网关收成了一个工具（实现在 `qq-gateway.sh`）：

```bash
tinda qq            # 一键启动 NapCat + 桥接器（等价于 tinda qq start）
tinda qq web        # 打印只读仪表盘地址（浏览器打开，实时看桥接器在干什么）
tinda qq qrcode     # 取登录二维码，直接打印在终端里
tinda qq status     # 看状态（含仪表盘地址）
```

> 动词变更：`web` 以前是 `start` 的同义词，现在专指**仪表盘**。
> `start` 的别名保留 `up|run|open`；NapCat 自己的 WebUI 用 `tinda qq webui`
> （别名 `napui`，`ui`/`panel` 已让给仪表盘）。

`tinda qq` 的动词（别名对齐 `tinda dsh` 的习惯）：

| 动词 | 说明 |
| --- | --- |
| `start\|up\|run\|web` | 启动两者（默认，幂等） |
| `stop\|close\|end\|exit\|kill\|down` | 停止两者 |
| `restart\|reload\|renew` | 重启两者 |
| `status\|st\|info` | 状态、端口、WebUI 地址；有服务 down 时退出码非 0 |
| `doctor` | 只读体检：配置/白名单/端口/权限/guard/job/DSH 依赖 |
| `web\|dashboard\|board` | 打印仪表盘地址（只读面板，默认 http://127.0.0.1:6702/） |
| `qrcode\|qr\|login` | 检查登录态；未登录且二维码新鲜时渲染 |
| `logs\|log\|tail` | 跟随桥接器日志 |
| `nlogs` | 跟随 NapCat 日志 |
| `webui\|panel\|ui` | 打印 NapCat WebUI 地址（含 token） |

工具别名：`tinda qq` / `tinda napcat` / `tinda qqbot`。网关脚本路径可用
`TINDA_QQ_GATEWAY` 覆盖。

不用 tinda 时也可以直接调：

```bash
cd /root/dsh-projects/openclaw/napcat-dsh-bridge
bash qq-gateway.sh {start|stop|restart|status|logs|nlogs|webui|qrcode}
```

### 二维码：终端里直接看

**Termux 是纯终端环境，给一个 PNG 路径等于什么都看不到。** 所以 `tinda qq qrcode`
默认把二维码**渲染在终端里**：

- `tools/qr-terminal.js` 从 PNG 解码，用游程长度的最大公约数推断出模块网格
  （实测这台机器上是 **41×41 模块 / QR v6 / 每模块 3px / 四周 4 模块静默区**）；
- 用半块字符 `▀` 在一个字符格里显示上下两个模块，**前景色=上模块、背景色=下模块**，
  且黑白都用显式 256 色指定（`38;5;16` / `38;5;231`）。这样深色和浅色终端主题下
  对比度都是对的——NapCat 自己那份 ASCII 码是靠终端默认前景色画块字符的，在深色
  终端里会变成浅色码点配深色底，即反相，多数扫码器认不出来。

同时另存一份放大 4 倍的 PNG（`/root/dsh-projects/openclaw/qq-login-qrcode.png`）。

因为二维码显示在**本机屏幕**上，扫的时候要么用另一台设备，要么**截图后走
QQ「扫一扫 → 相册」**选那张截图。

判定顺序（P1-03）：**先查登录态** → 已登录直接说“无需扫码”并退出 0；
NapCat 未启动退出 1；二维码文件超过 3 分钟视为过期，不渲染旧码并退出 1；
新鲜码才渲染并退出 0。输出里**不会打印二维码里的登录票据 URL**，也不建议
把票据交给任何第三方二维码网站。

环境变量：`QRCODE_NO_COLOR=1` 关掉 ANSI 颜色；`QRCODE_PNG_ONLY=1` 只出 PNG 不打终端。

登录成功后 NapCat 用 `config/onebot11.json`（已预置）生成 `onebot11_<QQ>.json`，
在 **127.0.0.1:3001** 开正向 WS 服务端，桥接器自动接上。

## 仪表盘（`tinda qq web`）

```
tinda qq web          # → http://127.0.0.1:6702/
tinda qq status       # 状态里也会带一行"仪表盘: ..."
```

页面拆成四个路由（[`src/panel.js`](src/panel.js) + [`src/panel-client.js`](src/panel-client.js) + [`src/panel.css`](src/panel.css)，无外部依赖、无 CDN）：

| 页面 | 内容 |
| --- | --- |
| `/` 主页 | 健康总览、连接状态、运行时长、收发计数、最近事件、会话、运行摘要 |

| 页面 | 内容 |
| --- | --- |
| `/` 主页 | 健康总览、连接状态、运行时长、收发计数、最近事件、会话、运行摘要 |
| `/sessions` 会话 | **会话管理**：QQ 聊天 → DSH 会话归属表；切换、新建、改名、解绑、接管；未归属会话列表 |
| `/config` 配置 | 写 token 解锁、运行中设置（按聊天切换工作区/模型/权限/会话）、完整配置表单、高级 JSON、保存/备份/重启 |
| `/logs` 日志 | 实时事件流 + `bridge.log` / `guard.log`，类型筛选、搜索、跟随、下载 |
| `/status` 状态 | 分层健康检查、完整 `/api/status` 快照、会话表 |

设计取舍：

- **读页面不需要 token，但写入口默认关闭**（`panel.writeEnabled:false`）。
  控制台默认只监听 127.0.0.1；要暴露到局域网请改 `panel.host`，并加反代鉴权。
- 写入口开启后，`POST /api/command`、`PUT /api/config`、`POST /api/restart`、
  `POST /api/onebot`、`POST /api/sessions` 都必须带 `Authorization: Bearer <state/panel.token>`；
  这个 token 与 `state/admin.token` **完全独立**，不接受 query token。
- 写请求还要求 `content-type: application/json`、Host/Origin 命中本机白名单，
  否则分别返回 415/403。后端独立鉴权，不依赖前端隐藏表单。
- 配置保存复用启动时的 `validateConfig` + `validatePolicy`，原子写 + 自动备份；
  密钥只回显掩码，留空保持原值。大多数配置需要重启桥接器，运行中设置不需要。
- **事件留内存**（默认 300 条环形缓冲），`status.json` 的落盘做了 400ms 去抖：
  可观测性不该把磁盘写爆，也不该拖慢消息链路。
- 面板**不自己碰 QQ**：直通 OneBot 由桥接器代发，复用同一条 OneBot 连接；
  运行时指令走与 QQ/admin 相同的 `handleInbound`，`deliver=null`。
- 熔断状态显示在主页横幅，`/status` 会明确标出失败的 critical 检查。
- **可访问性**（P1-07）：关键点击区 ≥44px、正文/标签 ≥12px、深色/浅色都达到
  AA 对比度；状态同时用文字和圆点表达，不只用颜色。会话行有“复制 id”按钮，
  375px 窄屏不横向滚动。
- 日志页“清空本页”只清空当前浏览器显示；**服务器仍保留**，刷新会恢复。
- 面板端口被占用时，`panel.url` 不会写入，`tinda qq web` 探测失败并返回非 0；
  不会再打印一个“看起来可用”的地址。

### 熔断（出站止损）

`behavior.outboundFailThreshold`（默认 5）次**连续**出站失败后，桥接器会：

1. 设置 `fatal` 告警 → 状态变 `suspended`，仪表盘顶部出现红色横幅；
2. **停止一切出站**（丢弃消息并记事件），避免"被风控盯上还在猛发"；
3. 冷却 `outboundFailCooldownMs`（默认 10 分钟）后**自动放行**，成功一次就清零。

这是唯一能止损的机制：失败重试和硬上限都没做（重试会加重风控印象）。

## 状态与待机

桥接器的状态由事实推导，不靠各处手动设置：
| `idle` | 已连上 OneBot，随时接消息 |
| `busy` | 正在跑 dsh |
| `stopping` | 收到退出信号 |

三处都能看：`state/status.json`、`GET http://127.0.0.1:6701/status`、QQ 里发 `/status`。

## 不登录 QQ 也能测输入端：反向注入

QQ 没登录（standby）时，用本地管理接口把消息**反向灌进**入站链路，
回复直接从 HTTP 响应拿，不推 QQ：

```bash
node tools/inject.js "用 bash 跑 pwd，然后一句话告诉我工作目录"
node tools/inject.js --group 30003 "帮我看下 @src/index.js 存在吗"
node tools/inject.js --command "/status"
```

等价于裸 HTTP：

```bash
curl -sS http://127.0.0.1:6701/status
curl -sS -X POST http://127.0.0.1:6701/inject \
  -H 'content-type: application/json' \
  -d '{"text":"你好","kind":"private","id":"local"}'
```

`/inject` 与 QQ 事件走的是**同一条** `handleInbound`，区别只在 deliver 是推 QQ
还是塞进 HTTP 响应——所以它验证的是真链路，不是模拟。

## 指令面（两态输入）

规则只有一条，但它必须严格成立：

- **以 `/` 开头** → 指令。只有四种归宿，**都不会变成模型消息**：
  1. **DSH 原生命令** → 原样转发给 DSH（与 WebUI 里敲的是同一条命令）；
  2. **桥接器自己的连接指令** → 本地处理；
  3. **已废除的旧指令**（如 `/压缩`）→ 明确告诉你替代写法；
  4. **未知指令** → 拒绝 + 列出可用命令。
- **其他任何输入** → 文本，整段交给 DSH 对话。

> 为什么把"未知指令"单列：早期实现里没匹配上的 `/xxx` 会掉进文本分支，
> 既当不成指令、又白白烧掉一个模型回合，还会在侧边栏里多出一条新会话。
> 现在它只回一句提示，零成本。

| DSH 原生命令（透传） | 说明 |
| --- | --- |
| `/compact` | 压缩更早的历史（**由 DSH 的压缩引擎执行**，不是让模型写摘要） |
| `/goal <目标>｜clear｜edit｜pause｜resume` | 长任务目标 |
| `/plan [off｜消息]` | 计划模式 |
| `/permission <预设>` | 切换权限预设（沙箱 + 审批） |
| `/export` | 导出本会话日志：桥接器生成真实 ZIP 并用 OneBot 上传到当前聊天；生成/上传失败会明确说“仅 Web/失败”，不再 success 无产物 |
| `/feedback <文字>` | 记录反馈 |

> 这张表是**兜底**。桥接器不维护 DSH 的命令清单（会漂移）；真实清单由
> `commands/list` 现场取，见「改造方向」。配置里可用 `dsh.commandList` 覆盖。

| 连接指令（桥接器本地） | 说明 |
| --- | --- |
| `/help` `/?` | 帮助（两种输入的说明 + 两张表） |
| `/status` | 连接 / 会话 / 工作区 / 模型 / 拟人化参数 |
| `/new` `/reset` | 开一段新会话（turns=0）；**旧会话保留**，可随时 `/ws` 切回 |
| `/sessions` `/history` | 列出当前工作区会话：短 id/完整 id、更新时间、可续/不可续原因、已知轮数；`*` 标当前会话 |
| `/ws [路径|会话 id]` | **唯一的上下文切换入口**：给路径切工作区（按 realpath 归一，切回来接着聊）；给会话 id（支持唯一前缀）只绑定 **preset 为空、同 cwd、非 subagent/fork、非运行中** 的会话；不满足会明确拒绝 |
| `/ls [子路径]` | 列目录 |
| `/model [别名]` | 查看或切换模型 |
| `/stop` | 中断当前任务（`SIGINT` 优雅收尾，1.5s 不退才 `SIGKILL`） |
| `/ping` | 存活探测 |

> 换会话/换工作区会递增 **bindingGen**；正在跑的旧回合结束时如果发现绑定变了，
> 会丢弃写回和投递（日志/事件流记 stale），不会把用户刚切到的会话覆盖回去。
> 轮数只在已知时显示，未知就是“未知”，不会伪造成 0。

### 群聊礼仪、AI 身份与隐私

- **群回复 @ 提问者**：`behavior.groupReplyAtSender:true` 时，第一条气泡用
  OneBot `at` **消息段**（不是 CQ 字符串，也不会 `@全体`）指向提问者；默认关闭，
  README/帮助都写明“默认不 @”。
- **回复机器人也算 mention**：群消息 reply 到机器人自己的消息时，会先 `get_msg`
  确认目标 sender 是 selfId，再放行；确认不了就不假装是 mention。
- **群共享上下文要披露**：每个群首次触发时，回复末尾会说明“我是接入 DSH 的机器人，
  本群共用一条会话，群成员都能看到这段上下文”。`behavior.aiDisclosure:false` 可关闭，
  但帮助/README 仍保留说明。
- **不跨群共享**：会话键是 `group:<群号>`；A 群上下文不会给 B 群，也不会把私聊内容
  拼进群会话。
- **隐私**：state/日志/outbox 权限收紧到 0600（目录 0700）；事件流只在内存保留有限条，
  面板默认只监听 127.0.0.1；/export 只发到当前聊天，ZIP 里不含 token。
- **群 poke 默认关闭**：`behavior.interactions.groupPoke:false`，避免绕过 mention
  但帮助/README 仍保留说明。若 `behavior.groupSessionScope:"member"`，披露文案会改成
  “每个成员各自一条会话”。
- **不跨群共享**：默认会话键是 `group:<群号>`；A 群上下文不会给 B 群，也不会把私聊内容
  拼进群会话。设 `groupSessionScope:"member"` 后键变成 `group:<群号>:<QQ号>`，同群成员
  之间也不共享。
- **隐私**：state/日志/outbox 权限收紧到 0600（目录 0700）；事件流只在内存保留有限条，
  面板默认只监听 127.0.0.1；/export 只发到当前聊天，ZIP 里不含 token。
- **群 poke 默认关闭**：`behavior.interactions.groupPoke:false`，避免绕过 mention
  策略；需要时显式打开。

### 拟人化输出

回答不再"一次吐完"，而是按人的节奏分气泡：

| 参数（`behavior.humanize`） | 默认 | 作用 |
| `burst.gapMinMs` / `gapMaxMs` | `450` / `1800` | 相邻气泡之间的停顿（可不设或调 0） |
| `burst.hardLimit` | `4000` | 单条硬上限，**只作为传输约束**（防 QQ 截断），超过才按句末标点切 |

**分条按内容结构，不按字数**（这条被用户当面纠正过）：模型自己已经用空行分好段了，
桥接器不该再去切它。优先级：

1. **空行**（`\n\n`）= 段落边界，最尊重结构；
2. **列表项**：只有当这一段的宽度 > `listSplitMinWidth`（默认 320）才按项拆，
   否则 `三个要点：\n- a\n- b` 整段一起发（早期逐项拆，切出一堆 `· 想换个时间范围？` 碎片）；
3. **代码块**整体保留，不拆；
4. **什么都没有**（一段落到底）→ **一条发完**，不做任何宽度切分。

内容块多于 `maxBursts` 时，按 `ceil(剩余块/剩余条数)` **相邻合并**，
让每条块数尽量相等（早期写成"前 n-1 条照原样、其余塞进最后一条"，
会切出 `[48,48,316]` 这种畸形分布）。

#### 让模型自己决定在哪儿断：`[[br]]`

上面的规则只能看见**模型已经写出来的结构**（空行/列表/代码块）。如果它把三件事
写成一大段，桥接器就只会发一大条。要让"在哪儿断"由**模型按语义**决定，用 `[[br]]`：

```
结论：能跑，先别上线。[[br]]细节是 CDN 还没刷完，等十分钟再验一次。
         ↓ 投递时
「结论：能跑，先别上线。」      ← 第一条气泡
「细节是 CDN 还没刷完，等十分钟再验一次。」  ← 隔 0.45~1.8s 的第二条
```

- 一个 `[[br]]` = 换一条气泡（实现上就是把标记换成空行，直接吃上面第 1 条规则）；
- 标记本身**不会发给用户**，与 `[[react]]`/`[[recall]]`/`[[poke]]` 同一套解析；
- 提示词里只在 `burst.enabled` 且 `maxBursts > 1` 时才介绍它（见 `systemHint`）。

**为什么不用"再调一次 AI 来切分"**：那要额外一次请求（延迟 +1~3s、多一份失败面），
而且切分模型只看得到文本、看不到你本来想怎么讲。`[[br]]` 是**同一次生成**里顺手
标出来的——标记本身约 5 个 token，提示词一行约 40 token，按 deepseek-flash 的价格
（输入 1~2 元/百万、输出 4~8 元/百万）算，**一千条约 0.06 元**，等于不要钱。

> 早期实现是按"96 字符宽度"硬切的，把句子拦腰截断成
> `…也确实是 2026-10-15` + `发布的（新华社…）`——这是**错的**，已废弃。

本地 `/inject` 不走拟人化（一次成型，方便脚本取字段）。

### 输入状态（"对方正在输入…"）

用 NapCat 的扩展接口 `set_input_status`（OneBot action 同名，参数 `user_id` + `event_type`）：

- 收到消息后立刻亮起，回答发出后熄灭；
- 处理超过 `keepaliveMs`（默认 8s）会续一次，避免长任务时状态过期；
- **只对私聊生效**：NapCat 的实现走 C2C 通道（`KCHATTYPEC2C`），群聊不发；
- 事件类型默认 `eventStart: 0` / `eventStop: 1`。若实测**相反**（扫的时候看不到"正在输入"，
  反而是答完之后才显示），把这两个值对调即可——协议文档没写死这两个数字。
- 任何失败只记 debug，绝不影响回答投递。

启用输入状态后建议把 `behavior.ackAfterMs` 设为 `0`：那段"收到，正在处理…"
在有了"正在输入"之后就是多余的（默认配置已改）。

### QQ 侧小动作（Q 交互）

除了收发消息，桥接器还会用 NapCat 的几个扩展接口做"人会在聊天里做的小事"。
**由模型在回复里写标记来驱动**——什么时候做动作由语境决定，不由桥接器写死规则：

| 标记 | 实际调用 | 作用对象 |
| --- | --- | --- |
| `[[react:赞]]` | `set_msg_emoji_like` | **触发本轮的那条用户消息** |
| `[[recall]]` | `delete_msg` | **自己上一条消息**（所以能"发错→撤回→重说"） |
| `[[poke]]` | `friend_poke` / `group_poke` | 当前会话对端（仅私聊） |

标记会被执行并从可见文本里删掉，用户看不到标记本身。可用性开关在
`behavior.interactions`：`react` / `recall` / `poke` / `read`（收到即标记已读）/
`autoLike`（名片赞）/ `pokeBack`（被戳时戳回去 + 回一句）。

表情可以用同义词（`赞` `爱心` `笑哭` `鼓掌` `疑问` `捂脸` `旺柴` `666`…，见
[`src/interactions.js`](src/interactions.js) 的 `EMOJI_ALIASES`），也可以直接写数字 ID。
同义词表不是权威表——NapCat 的 `set_msg_emoji_like` 用的是 QQ 的 QSid 体系，
表里没有的直接写 ID 即可。

**被戳会回戳**：NapCat 会上报 `notice_type: "notify"` / `sub_type: "poke"`，
桥接器只在"戳的是自己"时响应（避免在群里乱插话），回戳一下并回一句"别戳了，痒。"

失败处理：所有动作失败**只记日志、不重试、不降级**。它们是锦上添花，
不该影响回答投递，风控上也更安全。

### 实测记录（NapCat 4.18.38，`tools/verify-interactions.js`）

用"自发 → 自测 → 自撤回"闭环自检，结果：

| 接口 | 结果 |
| --- | --- |
| `get_login_info` / `get_version_info` / `can_send_image` / `can_send_record` / `get_status` | ✅ |
| `send_private_msg` → short `message_id` | ✅ `{"message_id":972601149}` |
| `delete_msg`（撤回） | ✅ 会话列表里该条已空 |
| `mark_private_msg_as_read` | ✅ |
| `set_input_status` 0 / 1 | ✅ 均返回 `{"result":0,"errMsg":"success"}`（**具体哪个数字是"起"，需肉眼确认**） |
| `get_msg` 回读 | ✅ |
| `set_msg_emoji_like` | ⚠️ 对**自己发的消息**返回 `{"result":65011,"errMsg":"操作失败，请稍后再试哦"}`（QQ 侧不允许给自己消息点表情，或需要真实对端） |
| `friend_poke`（戳自己） | ⚠️ NapCat 内部报错（`Cannot read properties of undefined`），是 NapCat 对自己戳自己的限制；真实对象需第二个账号 |

`delete_msg` / `set_msg_emoji_like` 接受的 `message_id` 就是 `send_*_msg` 返回的那个短 id。

### 管理接口里的直通 OneBot 调用

排查 NapCat 接口、或想让 agent 自己调 OneBot，用管理接口的 `POST /api`：

```bash
TOKEN=$(cat state/admin.token)
curl -s -X POST http://127.0.0.1:6701/api \
  -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"get_group_list","params":{}}'
```

用它的理由不只是方便：**第二个 OneBot WS 客户端会和桥接器抢同一条连接，
调用响应会被路由到旧连接上**（我实测踩过：新起的探测脚本永远收不到响应）。
`POST /api` 复用桥接器已有的那条连接，所以不会出现这个现象。

`POST /api`、`/inject`、`/command` 都需要同一个本地管理 token
（`state/admin.token`，0600，启动时自动生成）。token 只能放在 header：
`Authorization: Bearer <token>` 或 `x-admin-token: <token>`，**不接受 query token**。
所有 POST 还要求 `content-type: application/json`，并校验 Host/Origin。

`/inject` 与 `/command` 的注入身份是已认证的 operator；它们显式使用
`adminBypass` 并写审计（operator/action/target/result），不再匿名 `trusted:true`。
`/command` 只接受 `/` 开头的指令，普通文本直接 400，不会 spawn 或建会话。

### `@` 文件引用

沿用 DSH `dsh-file-reference` 的语法：`@path` 在输入开头或空白之后触发，
`@"带 空格 的路径"` 用引号。桥接器**不读文件内容**（DSH 自己的语义也是
「选中候选不读取内容，模型必须调文件工具去看」），只做解析与存在性校验，
并把结果作为一小段提示附在任务后：

```
（@ 引用解析，当前工作区 /root/.../workspace：
  @package.json -> /root/.../workspace/package.json（未找到，需要先确认路径）
）
```

> 关于 `%%`：DSH 源码里 `%%` 只是日志转义符（`cordis/src/logger.ts`：
> `if (match === '%%') return '%'`），不是用户输入记号。真正有语法的引用符号是 `@`。

### 会话沿用失败：不再"偷偷换新会话"

每轮 spawn 一个 `dsh --session-id <id>` 的代价之一：如果那条会话**正被另一个进程持有写句柄**
（典型情形：WebUI 里正开着这条会话、或上一轮 dsh 还没退干净），沿用会失败。DSH 的报错是
`session "…" is already owned by an active write handle`。

**旧行为（错得离谱）**：捕获到任何带 "session" 的错误就直接 `delete sessionId`，然后用全新会话
重试。结果回答照常给出、用户毫无察觉，但**模型已经看不到之前任何一轮**——侧边栏里那堆
`okok` / `中文` / `问候与开场` 碎片就是它的产物。

**现在**：

1. 只有"会话不可用"类错误才进入恢复流程，其余错误原样抛出（不再吞）；
2. **先重试**（默认等 1.5s、4s 各一次，可配 `behavior.sessionResumeRetryMs`）——
   持锁进程通常很快退出，多数冲突会自行消失；
3. 重试仍失败才分叉，而且**明说**：事件流里记一条 `error`、仪表盘"会话被迫分叉"计数 +1；
   QQ 提示里给出**旧会话 id** 和可执行的 `/ws <old-id>`，并说明旧会话是否还在；
   `chat.lastFork={from,to,at,reason,recoverable}` 落盘，`/status` 能看到；
4. 新会话的 `turns` 从 0 重新计，不继承旧会话的轮数；旧会话文件不删除。

实测（注入失败驱动，见下）：
- 前两次失败、第三次成功 → 沿用原会话，**零分叉**；
- 一直失败 → 4 次调用（1 原 + 2 重试 + 1 新会话）、分叉计数 1、事件流有 warning+error 两条。

> 根因没消：spawn-per-turn 这条架构决定了冲突可能发生。要做到"根本不会分叉"，
> 需要换成常驻客户端（`dsh web` 的 `/api` + `session/follow`，见
> [协作诊断与改造方向.md](../协作诊断与改造方向.md) 第四节）。
> 在那之前，这个改动的价值是：**冲突从"静默失忆"变成"可见且可重试"**。

### `/compact` 与"命令走 API、对话走 headless"的必然冲突（实测）

好消息：DSH 命令**可以**通过 API 作用于桥接器建的会话——`commands/execute` 的
agent 查找会 resolve 冷会话，所以这条能用，而且结果是真处理器的（零模型调用）：

```
/permission → success  current preset danger-full-access (available: read-only, workspace-write, danger-full-access)
/goal       → success  No goal is currently set. Usage: /goal [<objective>|clear|edit <objective>|pause|resume]
/plan       → success  Plan mode on. Use /plan off to leave.
/compact    → success  Compacted 8 history items (~577 tokens).      ← 真的压缩了
/compact x  → error    Usage: /compact (no arguments)
未知命令     → 返回 undefined（RPC 仍 ok:true）→ 桥接器回"没有这个指令"
```

**但 `/compact` 压缩完立刻就废了**，实测日志：

```
04:44:10  DSH 指令 /compact → success            （web 端开始压缩，5 分钟）
04:44:21  沿用会话失败: session "…" is already owned by an active write handle
04:49:28  重试仍失败（等了 1500ms）
04:49:37  重试仍失败（等了 4000ms）→ 分叉到新会话
```

原因：**web 进程执行压缩期间一直持着该会话的写句柄**，桥接器的 headless 进程抢不到锁，
只能分叉；新会话里没有压缩后的历史，所以"压缩了等于没压"。

这不是 bug，是**混搭架构的必然后果**：命令走 API（常驻进程，持锁）、对话走
headless（每轮抢锁）。两者对同一条会话的操作天然互斥。

> 结论：在换成常驻客户端之前，`/compact` **不要指望它有用**——
> 它能执行、能报结果，但压缩后的历史不会被下一轮用到。
> 修法与"会话不出现在侧边栏"完全同一个：把对话也搬到 API 上
> （`session/prompt` + `session/follow`），那时命令和对话同进程、同句柄，不再抢锁。

### 为什么桥接器的会话不出现在侧边栏（确定行为，不再自检）

用户实测："`/ws` 到别的目录，侧边栏看不到会话"。这是**两条路径互斥**：

| 谁建会话 | `agentPreset` | headless 能不能沿用 | 侧边栏能不能看见 |
| --- | --- | --- | --- |
| 桥接器 spawn `dsh --profile qq` | `undefined` | ✅ 能 | ❌ 看不见（孤儿会话） |
| DSH Web API `session/create` | **总是带 preset**（默认 `standard`） | ❌ **不能** | ✅ 能 |
| GUI 自己建 | `ptc`（GUI 的 preset） | ❌ 不能 | ✅ 能 |

headless 一次性运行器的原话：

```
session "…" runs under agent preset "standard",
which the one-shot runner does not compose
```

**两个衍生机制**（都实测过）：

1. **孤儿会话**：spawn 出来的会话不属任何工作区（`workspace.json` 的 `sessionIds` 里没有它）、
   在 `session/list` 里连 `projections` 都没有；`workspace/insertSessionBefore` 会直接拒绝——
   `workspace/move-invalid: the session is not accounted`。所以侧边栏看不到。
2. **路径必须 realpath**：`/sdcard` 是指向 `/mnt/sdcard` 的符号链接，DSH 按 realpath 存会话
   （`~/.dsh/sessions/--mnt-sdcard-dsh-session--`）。用链接路径去找会话会"看起来对、其实错"。

**P0-01 之后桥接器不再跑 probe、也不再通过 API 建会话/注册工作区。**
启动日志直接写明"headless spawn；会话不会出现在 DSH 侧边栏"。`/ws` 绑定前会读
DSH 的会话投影，校验 `agentPreset` 为空、不是 subagent/fork、cwd 与工作区 realpath 一致；
不满足就拒绝，不会触发"沿用失败→分叉"。

> 真正解法仍是换成常驻客户端（`dsh web` 的 `/api` + `session/follow`）——那时会话由 Host
> 自己管理，既带 preset 又能被同一条通道续聊，不再有互斥。见
> [协作诊断与改造方向.md](../协作诊断与改造方向.md) 第四节。

### 工作区与 session 的绑定关系

DSH 的 `--session-id` 沿用是**按工作目录严格校验**的（README 原文：会拒绝
「记录在别的工作目录 / 没记录工作目录 / 是子 agent 或 fork 出来的」session）。
所以每个 `(会话, 工作区)` 各有一条独立 session，`/ws` 切过去会接着用那个工作区
原有的会话，而不是丢掉上下文。

## 配置

`config.json`：

```jsonc
{
  "onebot": {
    "mode": "forward-ws",          // forward-ws | reverse-ws | http
    "url": "ws://127.0.0.1:3001",
    "accessToken": "…",            // 与 NapCat onebot11.json 的 token 一致
    "reconnectMs": 3000            // 指数退避的基数，最多退到 30s
  },
  "dsh": {
    "profile": "qq",               // 不要改回 headless，见下文「坑 1」
    "timeoutMs": 900000,
    "maxConcurrent": 1,
    "models": {                    // /model 的别名表
      "flash": { "provider": "deepseek-official", "model": "deepseek-flash" }
    }
  },
  "admin": { "host": "127.0.0.1", "port": 6701 },
  "panel": {
    "host": "127.0.0.1", "port": 6702,
    "enabled": true,
    "writeEnabled": false          // 默认只读；开启后写请求要 Bearer panel.token
  },
  "policy": {
    "privateChat": "allowlist",    // allowlist | allow | deny
    "groupChat": "mention",        // mention | allow | deny
    "allowUsers": [],              // 空 + allowAllUsers=false => 拒绝启动（安全默认）
    "allowGroups": [],             // 空 => 所有群都拒绝，不是静默开放
    "ownerUsers": [],              // 不填 => 第一个 allowUsers 是 owner
    "adminUsers": [],              // 不填 => 其余 allowUsers 是 admin
    "allowAllUsers": false,        // 显式 true 才会对陌生人开放，启动会告警
    "allowAllGroups": false,
    "ignoreSelf": true
  },
  "behavior": {
    "ackAfterMs": 8000,            // 超时先回一句「正在处理」
    "maxReplyChars": 4000,
    "groupSenderPrefix": true,
    "groupReplyAtSender": false,   // 群回复首条是否 @ 提问者（用消息段，永不 @全体）
    "aiDisclosure": true,          // 群首次触发披露“机器人 + 本群共享会话”
    "downloadImages": true,
    "imageDownloadTimeoutMs": 8000,
    "imageMaxBytes": 10485760,
    "imageAllowPrivateHosts": false, // 默认阻断私网/回环图片 URL（SSRF）
    "exportMaxBytes": 20971520,
    "outboxMaxAttempts": 5,        // 退出/断网时落盘的未发消息最多补发几次
    "shutdownGraceMs": 120000
  },
  "stateDir": "",                  // 空 = <项目根>/state；测试用 BRIDGE_STATE_DIR 注入临时目录
  "stateFile": ""
}
```

相对路径（`dsh.cwd`、`stateDir`、`stateFile`）按**项目根目录**解析（`stateFile`
相对 `stateDir`），不按配置文件所在目录。**缺 config.json 不再回退到 example**，
而是 fail fast 并提示 `cp config.example.json config.json`；`dsh.profile` 必须是
`qq`，headless 会拒绝带 preset 的会话。

> ⚠️ 默认 `allowUsers` 为空且 `allowAllUsers:false`，桥接器会**拒绝启动**并打印原因。
> 这是 P0-04 的安全默认：先在 `policy.allowUsers` 填至少一个 QQ 号；
> 确实要对所有人开放时才显式写 `allowAllUsers:true`（启动会红色告警）。
>
> 命令分级（P1-21）：`owner` 可 `/permission`；`admin` 可 `/ws`、`/sessions`、`/model`；
> 普通白名单用户只能用 `/help`、`/status`、`/new`、`/ls`、`/stop`、`/ping`。
> 未显式配置 `ownerUsers/adminUsers` 时，第一个 allowUsers 是 owner、其余是 admin，
> 不会再把所有白名单用户都当管理员。

## 状态、健康检查与 doctor

- `GET http://127.0.0.1:6701/health` 返回分层 `checks`：
  `process/admin/panel/onebot/dsh/guard/job`。关键项失败返回 **503 + ok:false**，
  不再恒 `ok:true`。每项带 `ok/critical/detail`；guard/job 未配置时只报 warn。
- `tinda qq status`（`qq-gateway.sh status`）：NapCat 或桥接器任一未运行就**退出非 0**；
  进程死了但 `status.json` 还写 connected=true 时标“状态文件过期”；
  不打印 admin/panel token，QQ 号脱敏，WebUI 只给地址不给 token。
- `tinda qq doctor`：只读体检配置、白名单、state/日志权限、6701/6702/3001 端口、
  bridge/guard pid 是否僵尸、guard 心跳/定时任务、dsh 命令/profile/token 文件。
  有 FAIL 退出 1；**不会启停服务，也不会打印 token**。
- 启动时打印配置来源和生效摘要（profile/policy/端口/workspace/state），不含 token；
  空白名单、非 loopback 面板会明确告警。

## 本机踩到 / 绕过的坑（都有实测证据）

### 1. bubblewrap 在 proot 里起不来 → 必须换权限预设

`headless` profile 默认权限是 `workspace-write` + `approval: ask`。实测同一句
`echo`：

| profile | tool_result.status |
| --- | --- |
| `headless` | `error` |
| `qq` | `completed` |

`headless` 的失败原文：

```
Error: sandbox mode "workspace-write" is requested but no sandbox backend is usable
on this host; refusing to run the command unconfined.
Runner failure: bwrap: fchdir to oldroot: No such file or directory
```

proot 没有 user namespace，bwrap 起不来，于是任何 bash 调用直接失败；退而申请
`danger-full-access` 又需要审批，而 QQ 那头没有审批人，会 fail closed。

因此本桥接器用专用的 `qq` profile（`$DSH_HOME/profiles/qq/`，由 headless 复制而来），
把权限固定为 `danger-full-access` + `approval: never`。

> ⚠️ **QQ 通道里的 agent 拥有完整本机权限且永不征求同意。** 请用
> `policy.allowUsers` / `allowGroups` 限制谁能给它下指令。

### 2. arm64/proot 下 Electron UtilityProcess 会 SIGSEGV

NapCat 官方在 [PR #1984](https://github.com/NapNeko/NapCatQQ/pull/1984) 修掉，
解法是 `NAPCAT_FORCE_NODE_PROCESS=1` 改走 `child_process.fork`。
`qq-gateway.sh` 启动时已带上。

### 3. screen 的 `-X` 子命令在本环境会挂

`screen -X hardcopy` / `screen -X quit` 都会卡住不返回。所以：
NapCat 的 stdout/stderr 直接重定向到 `state/napcat.log`（不依赖 screen 回滚缓冲），
停服务用信号而不是 `screen -X quit`。

### 4. 任务用 stdin 传，不用命令行参数

消息以 `-` 开头时不会被 commander 当成选项，也没有 argv 转义问题。

### 5. 默认会话标识必须统一

`/inject` 与 `/command` 不传 id 时都落到 `local`。早期不一致会导致
「先 `/ws` 再提问」落到两个不同会话上——这类 bug 很难查。

### 6. 重启桥接器会砍断在跑的回合（用户侧表现为"消息没回"）

早期 `shutdown` 是 `setTimeout(process.exit, 300)`：正在跑 dsh 的那一刻收到 SIGTERM，
回合被连根拔掉，**用户只看到沉默**，日志里也几乎没有痕迹（只有一条 `收到 SIGTERM，退出`）。
2026-10-16 01:28:56 那条"分析十五五规划"就是这么丢的：发起 2 秒后进程退出。

现在改成**先收尾、后断 OneBot**：

1. `bridge.shutdown(graceMs)` 置 `shuttingDown`，拒绝新入站；
2. 等 **turn 级 in-flight 清零**——排队、dsh、投递、写 state 都算，
   不只是 `semaphore` 的 dsh 槽位（默认最多 120s，`behavior.shutdownGraceMs`）；
3. 退出前再补发一次 `state/outbox.json`；补不发完就留给下次启动，有次数上限与退避；
4. 最后才 `onebot.stop()`、关面板、`flushSync`。

投递按分片写 outbox，成功即删；失败保留 `chatKey/segments/attempts/lastError`。
`turns` 与 `lastReplyAt` 只在**投递完成并落盘**之后才更新。
实测：模拟一个 5 秒回合，shutdown 等待到回合结束；中间 SIGTERM 不会把最后一句话当成"已收尾"。

### 7. 同账号不能跑两个桥接器实例

两个实例连同一个 OneBot/QQ 账号时，**消息会被随机分给其中一个**：
我实测时第二个实例抢走了本该由主实例处理的一条用户消息，用户那侧就是"消息没回"。
所以桥接器把管理端口当单例锁（抢不到就退出）——**别绕过它**；
要隔离测试，请用 `test/mock-onebot.js` 起假 NapCat，而不是让测试实例连真账号。

### 8. 启动器旗标必须排在 app 旗标之前

`dsh` 启动器**只解析自己的旗标**：遇到第一个不认识的 token，就把后面所有参数原样交给 app。
所以 `--patch` 必须排在 `--json` 之前：

```bash
dsh --profile qq --json --patch x.yml    # ✗ {"type":"error","message":"unknown option '--patch'"}
dsh --profile qq --patch x.yml --json    # ✓
```

这个 bug 曾经让「设过 `/model` 别名」的会话**每一轮都失败**（`/model` 会把选择落成
`--patch` 覆盖文件，于是每轮都拼出上面那行错误顺序）。`src/dsh.js` 里已按正确顺序拼接。

### 9. headless 默认关掉 credentials → QQ 侧 `MISSING_CREDENTIAL`

`dsh` 的 headless bundle 自带一行 `- id: credentials / disabled: true`，注释写着
"一次性任务用启动环境里的凭据"。`qq` profile 从 headless 复制而来，于是也关着这个服务：
每轮 dsh 的 `resolveAuth` 只看进程环境，找不到 `DEEPSEEK_API_KEY` 就抛

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
```

而 Web「模型」页保存的 key 存在 `$DSH_HOME/.credentials.yaml` 里；桥接器的启动环境
（screen / setsid / guard 链）并没有 `DEEPSEEK_API_KEY`，两边对不上。日志只会看到
`回合失败 ... dsh 退出码 1`，QQ 那侧就是"发消息没回复"。

修法（已验证）：在 `$DSH_HOME/profiles/qq/cordis.patch.yml` 里把服务重新打开

```yaml
- id: credentials
  name: "@deepseek-ai/dsh-credentials-local"
  disabled: false
```

改完**不用重启桥接器**（每轮都是新 dsh 进程），下一条消息即生效；之后换 key 只在
Web「模型」页改一次，QQ 与 Web 共用同一份存储，不用手工 `export`。
模板见 `profile/qq-profile.cordis.patch.yml`，可用
`dsh --profile qq --dump-config | grep -A2 'id: credentials'` 确认是 `disabled: false`。

## 外部自愈（qq-guard）

```bash
bash qq-guard.sh status      # 守护/定时任务/上次 tick
bash qq-guard.sh start       # 后台起守护（幂等；flock 单例）
bash qq-guard.sh resume      # 清 hold + 启动网关，等进程/端口，成功才打印
bash qq-guard.sh job-status  # 9099 是否在 termux-job-scheduler -p 里
```

- `tinda qq start` / `qq-gateway.sh start` 会在拉起 NapCat + 桥接器后
  **确保 guard 在跑**；起不来会明确打印"外部自愈未运行"，不再假装已恢复。
- `qq-guard.sh start` 注册 **persisted 周期任务**：
  `--job-id 9099 --period-ms 900000 --persisted true`，并在 `-p` 里验证。
  不会再用 `--period-ms 0` 冒充周期自愈。
- 每次 tick / start / resume / repair 写 `state/guard.health.json`（0600）：
  `last_tick/last_action/last_result/next_tick/job_registered`。
  `/status`、面板和 `qq-gateway.sh status` 都只读这份心跳。
- `resume` 失败返回非 0，并给出下一步；只有桥接器真的活着才打印"已恢复"。

## 测试

不依赖真实 QQ，且**默认不写生产 state/**：

```bash
npm run test:unit            # P1 纯函数/面板/health 单测（快，不启 dsh）
npm run test:offline         # P0 离线单测 + guard 脚本测试
npm run test:scripts         # status/qrcode/面板地址脚本回归
node test/e2e.js             # 单轮：消息 -> DSH -> 回传（约 15s）
node test/e2e-multiturn.js   # 多轮：验证 --session-id 续聊有记忆（约 30s）
node test/mock-onebot.js     # 交互式：终端里手打发消息
```

所有 e2e 用 `mkdtemp` 临时 state、随机端口、`panel.enabled:false`，
并在失败/结束时清理；不会覆盖生产 `state/status.json`、`panel.url`、
`admin.token`、`sessions.json`。要手动指定隔离目录：
`BRIDGE_STATE_DIR=/tmp/xxx BRIDGE_WORKSPACE=/tmp/ws`。

## 排障

| 现象 | 处理 |
| --- | --- |
| `status` 显示 `standby` | QQ 未登录。`qq-gateway.sh qrcode` 取码扫 |
| 二维码扫不出/过期 | 先看 `qrcode` 是否提示“已登录/未启动/过期”；过期就等 NapCat 换新码，**不要把票据交给第三方网站** |
| 面板打不开 | `tinda qq web` 会先探测；端口被占时返回非 0，看 `state/bridge.log` 的“面板端口…已被占用” |
| 配置改了不生效 | 缺文件/坏 JSON/profile=headless/端口冲突都会 fail fast；看启动日志第一行配置来源和摘要 |
| 日志刷「OneBot 连接断开」 | 已修：只在上下线切换时打一行，重连走指数退避 |
| 回答里说沙箱不可用 | profile 被改回 headless 了，改回 `qq` |
| 想看 NapCat 控制台 | `qq-gateway.sh nlogs` |
| 桥接器在干什么看不见 | `tinda qq web` 开仪表盘（状态/事件流/会话表/直通调用） |
| 某条消息发出去了但没回复 | 看仪表盘事件流有没有该条 `in`；有 `in` 无 `out` = 回合被打断（重启/崩溃），日志里找 `收到 SIGTERM` |
| 日志出现 `dsh 退出码 1: MISSING_CREDENTIAL` | `qq` profile 的 credentials 服务被 headless 关掉了；按「坑 9」在 `cordis.patch.yml` 里加 `disabled: false` |

## 文件

| 路径 | 说明 |
| --- | --- |
| `src/index.js` | 入口：配置、状态板、OneBot、管理接口 |
| `src/bridge.js` | 入站主流程、会话映射、排队、可中断 |
| `src/commands.js` | 指令面、`@` 引用解析 |
| `src/dsh.js` | 调 `dsh --json` 并折叠 NDJSON 事件流 |
| `src/onebot.js` | OneBot 11 客户端（正向 WS / 反向 WS / HTTP） |
| `src/ws-server.js` | 最小 RFC6455 服务端 |
| `src/state.js` | 状态板（推导式状态） |
| `src/admin.js` | `/status`、`/health`、`/inject`、`/command` 本地接口 |
| `src/config.js` | 配置加载/校验/路径解析（fail fast） |
| `src/policy.js` | 默认拒绝/白名单/preset 摘要/脱敏 |
| `src/auth.js` | token 文件（0600）、常数时间比较、Host/Origin/JSON 校验 |
| `src/audit.js` | 本地审计 JSONL（operator/action/target/result） |
| `src/session-info.js` | 会话投影只读校验（P0-01 的 preset/origin/cwd 门） |
| `src/health.js` | 分层健康检查（process/panel/onebot/dsh/guard/job） |
| `src/session-meta.js` | DSH 会话文件头/可续性/running 元数据 |
| `src/export.js` | 会话 JSONL → 最小 ZIP（/export 真产物） |
| `src/persona.js` | 拟人化输出（字素/代码围栏感知分气泡 + 打字节奏） |
| `src/interactions.js` | QQ 侧小动作（代码块外解析、最多 2 个、群 poke 默认关） |
| `tools/verify-interactions.js` | NapCat 交互接口真机自检（自发→自测→自撤回） |
| `tools/doctor.js` | `tinda qq doctor` 只读体检 |
| `test/humanize-e2e.js` | 拟人化 + 输入状态的端到端回归测试 |
| `test/offline/p0.test.js` | P0 离线单测（策略/鉴权/outbox/ack/分叉/段数组） |
| `test/p0-scripts.sh` | P0-08 guard/job/heartbeat/resume 脚本断言 |
| `test/p1.test.js` | P1 单测（切分/动作/配置/会话/export/health/面板） |
| `test/p1-scripts.sh` | status/qrcode/面板地址脚本回归 |
| `src/panel.js` | 只读仪表盘（单文件 HTML + SSE 实时事件流） |
| `tools/inject.js` | 反向注入 CLI |
| `tools/upscale-png.js` | 零依赖 PNG 最近邻放大（为了二维码能扫） |
| `qq-gateway.sh` | start/stop/restart/status/doctor/logs/nlogs/webui/web/qrcode |
// [MISSING LINE 770]
// [MISSING LINE 771]
// [MISSING LINE 772]
// [MISSING LINE 773]
// [MISSING LINE 774]
// [MISSING LINE 775]
// [MISSING LINE 776]
// [MISSING LINE 777]
// [MISSING LINE 778]
// [MISSING LINE 779]
// [MISSING LINE 780]
// [MISSING LINE 781]
// [MISSING LINE 782]
// [MISSING LINE 783]
// [MISSING LINE 784]
// [MISSING LINE 785]
// [MISSING LINE 786]
// [MISSING LINE 787]
// [MISSING LINE 788]
// [MISSING LINE 789]
// [MISSING LINE 790]
// [MISSING LINE 791]
// [MISSING LINE 792]
// [MISSING LINE 793]
// [MISSING LINE 794]
// [MISSING LINE 795]
// [MISSING LINE 796]
// [MISSING LINE 797]
// [MISSING LINE 798]
// [MISSING LINE 799]
// [MISSING LINE 800]
// [MISSING LINE 801]
// [MISSING LINE 802]
// [MISSING LINE 803]
// [MISSING LINE 804]
// [MISSING LINE 805]
// [MISSING LINE 806]
// [MISSING LINE 807]
| `test/humanize-e2e.js` | 拟人化 + 输入状态的端到端回归测试 |
| `test/offline/p0.test.js` | P0 离线单测（策略/鉴权/outbox/ack/分叉/段数组） |
| `test/p0-scripts.sh` | P0-08 guard/job/heartbeat/resume 脚本断言 |
| `test/p1.test.js` | P1 单测（切分/动作/配置/会话/export/health/面板） |
| `test/p1-scripts.sh` | status/qrcode/面板地址脚本回归 |
| `src/panel.js` | 只读仪表盘（单文件 HTML + SSE 实时事件流） |
| `tools/inject.js` | 反向注入 CLI |
| `tools/upscale-png.js` | 零依赖 PNG 最近邻放大（为了二维码能扫） |
| `qq-gateway.sh` | start/stop/restart/status/doctor/logs/nlogs/webui/web/qrcode |
