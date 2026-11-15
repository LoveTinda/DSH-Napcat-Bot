#!/system/bin/sh
# 目的：在无显示器环境里拉起 NapCat——Xvfb + QQ 主进程 + tinda-launcher 注入。
# 边界：只负责启动，不探活、不重试、不装包；登录状态在 /opt/napcat/.config/QQ 里，重启不会掉号。
# 依赖：Xvfb、/opt/QQ、/opt/napcat/tinda-launcher.js、$DATA/logs。
# 失败：QQ 或 launcher 缺失 → 78；其它情况交给 supervisor 退避重启。
# 副作用：日志追加到 $DATA/logs/napcat.log（由调用方重定向）。

set -u
NAP_ROOT=${NAP_ROOT:-/opt/napcat}
QQ_BIN=${QQ_BIN:-/opt/QQ/qq}

[ -x "$QQ_BIN" ] || { echo "[napcat] 找不到 $QQ_BIN" >&2; exit 78; }
[ -f "$NAP_ROOT/napcat.mjs" ] || { echo "[napcat] 找不到 $NAP_ROOT/napcat.mjs" >&2; exit 78; }
[ -f /opt/QQ/resources/app/tinda-launcher.js ] || { echo "[napcat] 注入入口缺失：/opt/QQ/resources/app/tinda-launcher.js" >&2; exit 78; }

cd "$NAP_ROOT" || exit 78
export HOME="$NAP_ROOT"
export NODE_OPTIONS=
# wrapper.node 要 QQ 可执行文件里的符号，所以必须从 QQ 主进程里加载，不能单独跑 node。
exec xvfb-run -a -s "-screen 0 1280x800x24" "$QQ_BIN" --no-sandbox
