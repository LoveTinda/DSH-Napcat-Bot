# Bridge 面板：路由、数据和界面行为

> 目的：把“桥接器面板”当成一个有契约的页面写清楚，而不是一张临时 HTML。
> 边界：只读；不提供配置写入、会话删除、重启按钮；不显示聊天正文。
> 依赖：`units/bridge/bridge.mjs` 的 `snapshot()`；`units/bridge/panel.mjs` 的 `renderPanel()`；
>       网关 `/bridge/` 反代（见 [网关.md](网关.md)）。
> 失败：取不到状态只显示错误条/离线角标，不白屏、不抛未捕获异常。

## 1. 设计目标

1. **手机先能用**：不出现需要横向滚动的表格；390px 宽度下会话、事件、配置都能读。
2. **只读且诚实**：只展示桥接器进程实际拿到的环境变量；改配置必须编辑文件并重启。
3. **挂在哪都能用**：`/panel/`、`/`、`/bridge/` 三种入口都能取到同一份状态。
4. **出错能自查**：401、超时、502、桥接器未启动都有可读提示和对应排查命令。

## 2. 路由

桥接器默认监听 `127.0.0.1:6700`（`BRIDGE_LISTEN`），同时承担 OneBot 事件入口和面板：

| 方法 | 路径 | 返回 | 说明 |
| --- | --- | --- | --- |
| GET/HEAD | `/`、`/panel`、`/panel/`、`/index.html` | HTML | 固定返回面板，不靠 `Accept` 猜 |
| GET/HEAD | `/state.json`、`/panel/state.json` | JSON | 同一份只读快照 |
| GET/HEAD | `/healthz` | JSON | `{ok,backend,listen}`，网关探活用 |
| GET | `/favicon.ico` | 204 | 避免浏览器 405 噪音 |
| POST | `/` | 204 | OneBot 11 事件入口；业务异步做 |
| 其它 | 任意 | 405/400 | 405 非 POST；400 坏 JSON |

为什么 `/state.json` 和 `/panel/state.json` 都有：

- 页面在 `/panel/` 下用相对 `state.json` → `/panel/state.json`
- 页面在 `/` 下用相对 `state.json` → `/state.json`
- 页面在 `/bridge/` 下用相对 `state.json` → 网关 `/bridge/state.json` → 桥接器 `/state.json`

旧实现用 `panel/state.json` 相对路径，在 `/panel/` 下会拼成 `/panel/panel/state.json`，
这是本次修掉的 P0。

## 3. 状态 JSON 契约

`snapshot()` 返回的对象就是面板数据源。字段只增不改；新增字段必须同步本文件和
`units/bridge/test-panel.mjs`。

```json
{
  "ok": true,
  "backend": "headless",
  "listen": "127.0.0.1:6700",
  "napcatApi": "http://127.0.0.1:3001",
  "uptimeMs": 123456,
  "counts": {
    "incoming": 4,
    "ok": 3,
    "failed": 1,
    "skipped": 3,
    "busy": 0,
    "outbox": 0,
    "requeued": 0
  },
  "alerts": {
    "qq": "12*****89",
    "sent": 1,
    "suppressed": 2,
    "lastKind": "fail",
    "lastAt": 1763200000000,
    "streak": 0,
    "failStreak": 3,
    "cooldownMs": 1800000,
    "diskPercent": 74,
    "diskAlertPercent": 90
  },
  "interactions": {
    "summary": "开 · 每轮最多 2 个 · 总时限 2500ms · 群 poke 关",
    "enabled": true,
    "last": { "at": 1763200000000, "executed": 1, "failed": 0, "skipped": 0, "kinds": ["react"] },
    "totals": { "turns": 2, "executed": 3, "failed": 0, "skipped": 1 }
  },
  "sessions": [
    {
      "key": "private:20001",
      "sessionId": "session-1b20fd7a-4f6b-4107-81dd-1f5f458ccb9d",
      "messages": 2,
      "lastAt": 1763200000000,
      "lastMs": 812,
      "busy": false
    }
  ],
  "events": [
    {
      "at": 1763200000000,
      "status": "ok",
      "key": "private:20001",
      "ms": 812,
      "note": "12 字"
    }
  ],
  "config": {
    "BRIDGE_LISTEN": "127.0.0.1:6700",
    "BRIDGE_BACKEND": "headless",
    "BRIDGE_ALLOW_GROUP": true,
    "BRIDGE_TIMEOUT_MS": 180000,
    "BRIDGE_PERMISSION_MODE": "(profile 默认)",
    "BRIDGE_MAX_EVENT_AGE_SEC": 120,
    "BRIDGE_SEEN_FILE": "/root/workspace/tinda-bot/.runtime/state/bridge/seen.json",
    "BRIDGE_SEND_RETRY": 3,
    "BRIDGE_SEND_DRAIN_MS": 15000,
    "BRIDGE_OUTBOX_TTL_MS": 21600000,
    "BRIDGE_OUTBOX_FILE": "/root/workspace/tinda-bot/.runtime/state/bridge/outbox.json",
    "ALERT_QQ": "(未设置)",
    "ALERT_FAIL_STREAK": 3,
    "ALERT_COOLDOWN_SEC": 1800,
    "DISK_ALERT_PERCENT": 90,
    "NAPCAT_API": "http://127.0.0.1:3001",
    "NAPCAT_TOKEN": "(已设置)",
    "DSH_BIN": "/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js",
    "DSH_HOME": "/root/.dsh",
    "BRIDGE_STATE_FILE": "/root/workspace/tinda-bot/.runtime/state/bridge/sessions.json"
  }
}
```

### 字段语义

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 快照是否可用；正常固定 true |
| `backend` | string | `headless` 或 `echo` |
| `listen` | string | 实际监听地址 |
| `napcatApi` | string | 回发消息用的 OneBot API 根地址 |
| `uptimeMs` | number | 进程启动至今毫秒 |
| `counts.incoming` | number | 通过分类、进入处理的消息数 |
| `counts.ok` | number | 成功回发的轮数 |
| `counts.failed` | number | 失败轮数 |
| `counts.skipped` | number | 跳过的事件数（含非消息事件/空消息/自己发的/群关闭） |
| `counts.busy` | number | 有排队/处理中任务的聊天数 |
| `counts.outbox` | number | 当前待补发的回复条数 |
| `counts.requeued` | number | 累计进入补发队列的次数（只增） |
| `interactions.summary` | string | 交互动作开关、每轮上限、总时限、群 poke 状态 |
| `interactions.enabled` | boolean | 总开关；false 时正文标记原样保留 |
| `interactions.last` | object \| null | 最近一轮动作：执行/失败/跳过数、动作种类；没有执行过为 null |
| `interactions.totals` | object | 累计轮数、执行数、失败数、跳过数 |
| `alerts.qq` | string | 告警接收人（打码）；未设置时为 `(未设置)` |
| `alerts.sent` / `suppressed` | number | 已发告警条数 / 被冷却压掉的次数 |
| `alerts.streak` | number | 当前连续失败次数（成功一次清零） |
| `alerts.lastKind` / `lastAt` | string / number | 最近一次告警的类型与时间 |
| `alerts.diskPercent` | number \| null | 数据分区已用百分比；拿不到为 null |
| `sessions[].key` | string | `private:<qq>` 或 `group:<group_id>` |
| `sessions[].sessionId` | string | DSH 会话 id；空 = 尚未建立 |
| `sessions[].messages` | number | 成功轮数 |
| `sessions[].lastAt` | number | 最近活动毫秒时间戳；0 = 无 |
| `sessions[].lastMs` | number | 最近一轮耗时 |
| `sessions[].busy` | boolean | 该聊天当前是否有任务 |
| `events[].status` | string | `ok` / `fail` / `skip` |
| `events[].note` | string | 脱敏、压缩空白、≤120 字符；成功时为“N 字” |
| `config` | object | 进程实际环境变量；token 只显示“已设置/未设置” |

### 保留与上限

- `events` 只保留最近 100 条，面板展示全部 100 条；重启清空。
- `chatStats` 超过 500 个聊天时按 `lastAt` 删最旧的（防止内存无界增长）。
- 事件备注先 `redactText()` 再截断；**聊天正文永远不进入快照**。
- 失败摘要可能包含 DSH 的 stderr 尾部，已脱敏，但仍不建议外发。

## 4. 页面结构

### 4.1 概览

- 指标卡：收到消息、成功回复、失败、跳过、排队中、待补发、运行时长。
- 信息行：后端、监听、NapCat API、状态文件、补发队列、告警接收、磁盘占用、交互动作。
- 失败/排队/待补发 > 0 时数字用警示色。

### 4.2 会话

- 每个聊天一张卡：chatKey、处理中标签、最近活动、条数、最近耗时、完整 sessionId。
- sessionId 有“复制”按钮；空时显示“未建立 DSH 会话（下一轮会新建）”。
- 不再只显示 8 位前缀。

### 4.3 事件

- 过滤：全部 / 成功 / 失败 / 跳过。
- 每条：状态标签、chatKey、时间（当天只显示时分秒，跨天带日期）、耗时、备注。
- 空态区分“还没有事件”和“筛选无结果”。

### 4.4 配置

- 按组展示：连接、行为、交互动作、DSH、回发与告警、其它。
- 值只读；空值显示 `(空)`；布尔显示 `开/关`。
- 底部提示：改 `$DATA/etc/tinda.conf` 后 `bin/unit.sh restart bridge`。
- **没有保存按钮**，这是安全边界，不是漏做。

### 4.5 控制命令（私聊）

桥接器只认两个命令，其余文本一律当普通问题交给 DSH：

| 命令 | 行为 | 为什么需要 |
| --- | --- | --- |
| `/reset` | 清掉这个聊天的 DSH 会话映射，下一条开新会话 | 会话续接错了（答非所问、上下文串了）时自己救，不用改 state 文件 |
| `/session` | 回当前会话 id，没有就明说 | 核对映射是否指向你以为的那个会话 |

只对**私聊**生效：群里发 `/reset` 会当普通问题处理，避免任何人一句话重置大家的会话。

### 4.6 补发与告警（只读）

- 概览的「待补发」= `counts.outbox`，来自 `$DATA/state/bridge/outbox.json`；
  断网时已生成的回复会留在这里，恢复后由桥接器自己补发，面板不提供「重发/删除」按钮。
- 「告警接收」显示打码后的 `ALERT_QQ` 与已发条数；没配时显示「未设置」，
  按设计此时连续失败/磁盘告警都不会发。
- 事件流里，补发成功记一条 `ok`（备注「补发成功」），入队失败记 `fail`（备注「回复已入补发队列」），
  过期丢弃记 `fail`（备注「补发超时丢弃」）。
- 这些状态都只在内存 + 一个 0600 的队列文件里，**不显示回复正文**。

## 5. 轮询与错误态

- 默认每 2 秒 `fetch('state.json', {cache:'no-store', credentials:'same-origin'})`。
- 页面隐藏（`document.hidden`）时暂停轮询；回到前台立即拉一次。
- “自动”按钮可暂停/恢复；“刷新”立即拉一次。
- 401：提示从 8443 控制台进入或加 `?k=<WEB_TOKEN>`。
- 超时（5 秒）：提示“状态请求超时”，给 `unit.sh status/logs` 命令。
- HTTP 非 200：显示“状态接口返回 HTTP N”，不再说“连接不上”。
- 连续失败：角标变红，保留上一份数据，错误条常驻直到下一次成功。
- 请求带 `AbortController`，避免慢请求堆积；用序号丢弃过期响应。

## 6. 安全边界

- 面板与 OneBot 入口共用 `127.0.0.1:6700`；默认只绑回环。
- 面板没有鉴权，依赖“只有本机能连”；如果 `BRIDGE_LISTEN` 改成 `0.0.0.0`，
  `doctor.sh` 会直接 FAIL。
- 面板不接受写操作，避免本机任意进程通过 6700 改配置/重启。
- 网关 `/bridge/` 外层有 token + HttpOnly cookie；但桥接器自己不知道 token。
- 不内联用户可控的 HTML；所有数据用 `textContent` 写入。
- 嵌入 `<script>` 的初始快照用 `safeJson()` 转义 `< > & U+2028 U+2029`。

## 7. 测试与验收

`units/bridge/test-panel.mjs` 覆盖：

- 面板页可打开、根路径也是 HTML
- 相对 `state.json`、`/state.json` 与 `/panel/state.json` 等价
- 无 `<table>` 回归
- 手动刷新/错误条/跳过卡片存在
- 事件秒回 204、成功计数、会话出现、事件无正文、排队归零
- 空消息计入跳过、skip 事件进入事件流、不回发
- 快照里有交互动作配置与统计；面板页有「交互动作」一行

人工验收：

```sh
cd /root/workspace/tinda-bot
bin/unit.sh restart bridge
# 手机浏览器打开（token 从 secrets/web.token 取）
# https://<局域网IP>:8443/?k=<WEB_TOKEN>
# 然后点「桥接器」；再试 /bridge/state.json 与 /panel/
```

## 8. 加字段的检查清单

新增一个面板字段时，必须同时改：

1. `bridge.mjs` 的 `snapshot()`（只加，不改旧字段语义）
2. `panel.mjs` 的渲染（会话/事件/配置对应区域）
3. `units/bridge/test-panel.mjs` 的断言
4. 本文件的字段表
5. `CHANGELOG.md` 一行

不要把聊天正文、完整 token、DSH 凭据放进快照。
