# /output 输出档位（从 QQ 聊天记录里捞回来的原文）

来源：QQ 与「Love Tinda」的聊天记录，2026-11-03 23:58 机器人回复。
（原文由 /output 无参数时打印，逐字复制）

```
当前输出档位：简洁（concise）

  minimalist  极简 — 只发最终总结
▸ concise     简洁 — 执行中的正文 + 最终总结
  detailed    详细 — 工具调用 + 正文 + 总结
  complete    完整 — 工具调用 + 思维链简要 + 正文 + 总结

用法：/output <档位>　　例如 /output detailed
只影响本聊天，下一轮生效；默认 minimalist。
```

## 从记录里能确定的行为

- 四档：`minimalist` / `concise` / `detailed` / `complete`
- 默认：`minimalist`
- 粒度：**每个聊天各自一份**（"只影响本聊天"）
- 生效：**下一轮**（不改当前正在跑的回合）
- 显示：`/output` 无参时打印当前档位（带 ▸ 标记）+ 全部档位 + 用法
- 切换：`/output detailed` 这样的形式；切换成功时机器人回「输出档位已切到：完整（complete）」并说明包含什么
  （2026-11-03 23:58 实测原文：「输出档位已切到：完整（complete）／工具调用 + 思维链简要 + 正文 + 总结／下一轮生效。」）
- 权限：文档命令表里 `/output` 是 **admin**

## 待重建时要落的点

1. `src/bridge.js`：出站渲染按档位过滤三类内容——工具调用步骤、思维链简要、正文/总结
2. 每聊天状态：`chat.outputTier`，与 `chat.agentPreset` 同处（`sessions.json`）
3. `src/commands.js`：`/output`（无参 → 上面那段原文；有参 → 校验四档并回执）
4. 面板：会话/DSH 分区加档位下拉
5. 文档：第 7 节补「输出档位」小节 + 变更记录一行
6. 测试：四档渲染差异（工具行是否出现、思维链是否出现）+ 默认 minimalist + 跨聊天隔离
