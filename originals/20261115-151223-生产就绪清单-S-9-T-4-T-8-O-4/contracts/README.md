# 接口契约（入 git）

目的：桥接器与外部世界有四个边界，每个边界先有契约、再有实现。
契约是**机器可读**的（JSON），`bin/check-contracts.mjs` 用它做一致性检查。

| 契约 | 边界 | 当前实现 | 允许本地覆盖 |
| --- | --- | --- | --- |
| `onebot.contract.json` | QQ ⇄ Bridge | 暂无（目标形态） | 是（`local/onebot-*.js`） |
| `dsh.contract.json` | Bridge ⇄ DSH | 暂无（当前用 `dsh headless` CLI） | 是 |
| `model.contract.json` | Bridge ⇄ 模型 | 暂无（模型由 DSH 内部选） | 是 |
| `store.contract.json` | Bridge ⇄ 状态 | 暂无（当前只有 sessions.json） | 否（状态层禁止本地魔改） |

## 当前真实状态（2026-11-15 v0.2.18）

- 四个契约的 `implementedBy` 都是空数组；`check-contracts` 会输出
  `warn <id>: 契约存在但还没有实现（0.x 允许）`。这是**如实告警**，不是通过。
- 旧实现 `app/src/*.js` 已在 v0.2.18 删除（无法通过 `node --check`，且 import 的
  `dsh.js` / `model.js` / `onebot.js` / `store.js` 根本不在仓库里）。需要参考时用
  `git log --all -- app/` 或 `originals/20261115-145050-full-audit-before-bridge-rework/`。
- 真正在跑的是 `units/bridge/bridge.mjs`（OneBot HTTP + DSH CLI）、
  `units/web/gateway.mjs`（鉴权 + 反代）和 `bin/*.sh`。

## 规则

1. 改契约 = 破坏性变更，必须同提交改所有实现与测试
2. 实现只能实现契约里声明的方法，**不得偷偷加**（避免实现漂移成事实标准）
3. 本地优化不得改契约，只能实现契约
4. 1.0 之前必须二选一：把 `units/bridge` 按契约补齐并登记 `implementedBy`，
   或删掉对不上的契约、按现有实现重写一份小的。在那之前，这一项只能是 `0.x`。
