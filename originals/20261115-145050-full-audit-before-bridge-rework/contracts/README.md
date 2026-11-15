# 接口契约（入 git）

目的：桥接器与外部世界只有四个边界，每个边界先有契约、再有实现。
契约是**机器可读**的（JSON），`bin/check-contracts.sh` 用它做一致性检查。

| 契约 | 边界 | 谁实现 | 允许本地覆盖 |
| --- | --- | --- | --- |
| `onebot.contract.json` | QQ ⇄ Bridge | app/src/onebot | 是（local/onebot-*.js） |
| `dsh.contract.json` | Bridge ⇄ DSH | app/src/dsh | 是 |
| `model.contract.json` | Bridge ⇄ 模型 | app/src/model | 是 |
| `store.contract.json` | Bridge ⇄ 状态 | app/src/state | 否（状态层禁止本地魔改） |

规则：
1. 改契约 = 破坏性变更，必须同提交改所有实现与测试
2. 实现只能实现契约里声明的方法，**不得偷偷加**（避免实现漂移成事实标准）
3. 本地优化不得改契约，只能实现契约
