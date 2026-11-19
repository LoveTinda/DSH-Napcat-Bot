# 本地适配（不入 git）

这个目录是**为这台设备/这个账号做的特殊优化**，不会进仓库。

规则：
- 只允许“实现契约”，不允许“修改契约”
- 每个文件必须在头部写明：`// overrides: <契约 id>` 和为什么必须本地化
- 加载顺序：内置实现 → local/ 覆盖（同名导出被替换）
- `local/` 在 .gitignore 里；仓库里有本文件说明形状

示例：local/onebot-android.js 覆盖 connect()，改用 Unix socket 连本机 NapCat，
因为 Android 上 127.0.0.1 的 TCP 端口会被反作弊扫描。
