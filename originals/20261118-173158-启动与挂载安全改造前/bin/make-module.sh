#!/system/bin/sh
# 目的：把仓库打成可直接在 Magisk 里刷的 zip——只装运行需要的东西，不带 .runtime/.git/originals。
# 边界：不签模块、不改版本号、不刷机；不校验 Android 侧运行时（那是 check-module + S-4 的事）。
# 依赖：python3（zipfile 保留可执行位）、module.prop、bin/*、units/*；输出目录默认 /sdcard/Download/DSH-Go。
# 失败：module.prop 缺失或无 python3 → 78；打包后 unzip -t 校验失败 → 1。
# 副作用：写 $OUT 与同名 .sha256。

MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." && pwd)}
OUTDIR=${OUTDIR:-/sdcard/Download/DSH-Go}
[ -f "$MODDIR/module.prop" ] || { echo "FAIL 缺 module.prop，不像模块根目录：$MODDIR"; exit 78; }
command -v python3 >/dev/null 2>&1 || { echo "FAIL 缺 python3，无法建 zip"; exit 78; }

VER=$(sed -n 's/^version=//p' "$MODDIR/module.prop" | head -1)
VER=${VER:-dev}
mkdir -p "$OUTDIR" || exit 78
OUT="$OUTDIR/tinda-bot-$VER-magisk.zip"

python3 - "$MODDIR" "$OUT" <<'PY' || { echo "FAIL 打包失败"; exit 1; }
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
dirs = ['bin', 'units', 'contracts', 'etc', 'docs']
files = ['module.prop', 'customize.sh', 'service.sh', 'uninstall.sh',
         'README.md', 'RUNBOOK.md', 'AGENTS.md', 'CHANGELOG.md']
skip_names = {'.runtime', '.git', 'originals', 'local', 'node_modules', '__pycache__', '.DS_Store'}
skip_ext = ('.log', '.bak', '.tmp', '.pyc')

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    n = 0
    for f in files:
        p = os.path.join(root, f)
        if os.path.isfile(p):
            z.write(p, f)
            n += 1
    for d in dirs:
        base = os.path.join(root, d)
        if not os.path.isdir(base):
            continue
        for cur, subdirs, names in os.walk(base):
            subdirs[:] = [s for s in subdirs if s not in skip_names]
            for name in sorted(names):
                if name in skip_names or name.endswith(skip_ext):
                    continue
                p = os.path.join(cur, name)
                rel = os.path.relpath(p, root)
                z.write(p, rel)
                n += 1
    print('打包 %d 个文件' % n)
PY

unzip -t "$OUT" >/dev/null 2>&1 || { echo "FAIL zip 校验不通过：$OUT"; exit 1; }
( cd "$OUTDIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" 2>/dev/null ) || true
echo "OK $OUT ($(stat -c %s "$OUT" 2>/dev/null || echo '?') 字节)"
echo "sha256: $(cat "$OUT.sha256" 2>/dev/null | cut -d' ' -f1)"
