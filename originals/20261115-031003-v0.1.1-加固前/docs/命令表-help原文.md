# /help 原文（从 QQ「Love Tinda」聊天记录里复制）

> 逐字保存。用于重建 `src/commands.js` 的命令总表与别名映射。

```
两种输入：
  · 以 / 开头  → 指令（下表；不会变成对话内容）
  · 其他内容    → 直接和 DSH 对话

DSH 原生命令（透传，和 WebUI 里敲的是同一条）：
  · /compact — 压缩更早的对话历史
  · /export — 导出本会话日志（ZIP）
  · /feedback [文字] — 记录对本次会话的反馈
  · /goal [目标|clear|edit <目标>|pause|resume] — 长任务目标：设置 / 查看 / 清除
  · /permission [预设] — 切换权限预设（沙箱 + 审批）
  · /plan [off|消息] — 进入 / 退出计划模式

桥接器命令：
  通用
    · /help [命令] — 这份帮助；给命令名看详细用法 · 别名 /? /帮助
    · /status — 连接 / 会话 / 工作区 / 模型状态 · 别名 /状态
    · /ping — 存活探测
  会话与上下文
    · /new [标题] — 开新会话（旧会话保留） · 别名 /reset /新会话 /重置
    · /stop — 中断当前任务 · 别名 /中断
    · /sessions [all] — 列出本聊天的会话 · 别名 /history /会话 /历史 /列表
    · /session [info|list|new|use|title|release|bind|who] — 会话详情与管理 · 别名 /sid /会话管理
    · /context — 群上下文缓冲：有哪些、下一条会带什么 · 别名 /上下文 /最近消息 /ctx
    · /ws [编号|会话 id|路径] — 切换会话或工作区 · 别名 /workspace /工作区 /use /switch /切换
    · /ls [子路径] — 列工作区文件 · 别名 /列目录
  模型与风格
    · /model [别名] — 查看或切换模型 · 别名 /模型
    · /effort [off|low|high|max|auto] — 推理强度 · 别名 /推理强度 /思考强度
    · /output [档位|--help] — 输出详细程度 · 别名 /输出
    · /persona [add <id> <名字> | <提示词>] — 人设 = DSH preset：查看/新建 · 别名 /人设
  管理与诊断
    · /balance — 查 DeepSeek 账户余额 · 别名 /余额 /查余额
    · /policy [测试文本] — 策略命中与能力 · 别名 /策略 /acl
    · /notice [off|on] — 本群使用提示的开关 · 别名 /提示 /使用说明

说明：
  · 群里需要 @ 我，或回复我的消息；文件引用用 DSH 的 @ 语法：@src/index.js、@"带 空格 的路径"。
  · 权限由 config.policy.rules 的 role / caps 决定；admin：/ws /model /effort /output /balance；owner：/permission。
  · 还需要 admin 的子命令：sessions all、session bind。
  · 传输层由 config.dsh.transport 决定：api/auto 走 DSH Host（与侧边栏同一批会话），headless 是一次性运行器。
  · 群里默认一个群一条会话；behavior.groupSessionScope="member" 可改成每人一条。
  · 详细用法：/help <命令>，例如 /help output。
```

## 相对 11-03 文档的新增（对照结论）

1. **DSH 原生命令清单**首次写全：`/compact /export /feedback /goal /permission /plan`
   - 文档只提过 `/permission` 一条
   - `/goal`、`/plan`、`/feedback` 是文档里完全没有的
2. `/context` 出现在正式命令表里（文档只在变更记录里提过它）
3. **别名表**完整：`/help`→`/?`、`/new`→`/reset`、`/sessions`→`/history`、`/ws`→`/workspace`、`/session`→`/sid`、`/output`→`/输出`、`/effort`→`/推理强度`、`/policy`→`/acl` 等
4. `/help [命令]` 支持按命令查详细用法（例：`/help output`）
5. `/effort` 的参数是 `off|low|high|max|auto`
6. `/output [档位|--help]`，属于「模型与风格」，权限 admin
7. `/persona` 语法：`add <id> <名字> | <提示词>`，也支持直接给提示词
8. 文件引用语法：`@src/index.js`、`@"带 空格 的路径"`
9. 明确了两条不变量：`/` 开头必不进模型；群聊默认「一 群一会话」
