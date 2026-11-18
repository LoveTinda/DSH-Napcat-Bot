#!/system/bin/sh
# 目的：在已 root 的 Android 上准备模块的 Linux rootfs（Magisk/KernelSU/SukiSU 通用）：
#       校验 tar 包、解到 $DATA_ROOT/rootfs、clone 现成目录树，并检查里面的 node/dsh 是否可用。
# 边界：不联网下载、不装 apt/npm 包（只打印下一步命令）；不动宿主的 /system；
#       不改 tinda.conf。rootfs 里装什么由人决定。
# 依赖：root、/data/adb、tar、sha256sum（或 shasum）、可选 chroot；bin/rootfs-clone.sh。
# 失败：非 root/缺 /data/adb → 78；tar 校验失败 → 1；解包后没有 /usr → 1。
# 副作用：创建 $DATA_ROOT/rootfs 并写入文件；不删除已有 rootfs（重跑会拒绝覆盖）。

set -u
MODDIR=${MODDIR:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}
DATA_ROOT=${DATA_ROOT:-/data/adb/tinda-bot}
ROOTFS="$DATA_ROOT/rootfs"
FORCE=0
LINK=0
MODE=""
SRC=""

usage() {
  cat <<EOF
用法: sh $0 [--check]
      sh $0 --from <已解包的 Ubuntu 目录> [--force]
      sh $0 --tarball <ubuntu-base-*.tar.gz> [--force]

  --check          只报告现状（rootfs / node / dsh / 挂载点），不写文件
  --from DIR       复制一份现成目录树（新 inode；默认排除 proc/dev/sys/sdcard/data）
  --link           配合 --from：改用 bin/rootfs-clone.sh 硬链接克隆（快，但和源共享 inode）
  --tarball FILE   解包 Ubuntu base（要求同目录有 <FILE>.sha256，--force 可跳过）
  --force          目标 rootfs 非空时仍然继续（默认拒绝）

环境变量: DATA_ROOT=$DATA_ROOT（测试时可改）
EOF
}

die() { echo "FAIL $*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --from) MODE=clone; SRC=${2:-}; shift ;;
    --link) LINK=1 ;;
    --tarball) MODE=tarball; SRC=${2:-}; shift ;;
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "不认识的参数：$1" ;;
  esac
  shift
done

[ "$(id -u)" = "0" ] || die "需要 root（uid=$(id -u)）"
# 测试/演练时允许把 DATA_ROOT 指到别处；只有真的往 /data/adb 写才要求 Android root 环境。
case "$DATA_ROOT" in
  /data/adb/*)
    [ -d /data/adb ] || {
      if [ "$MODE" = check ] || [ -z "$MODE" ]; then
        echo "warn: 没有 /data/adb：这不是 Android root 环境（proot 里只能跑宿主直装）"
        check 2>/dev/null || true
        exit 0
      fi
      die "没有 /data/adb：这不是 Android root 环境（proot 里只能跑宿主直装）"
    } ;;
  *) echo "warn: DATA_ROOT 不是 /data/adb（演练模式，仅用于测试）" ;;
esac

check() {
  echo "DATA_ROOT=$DATA_ROOT"
  if [ -d "$ROOTFS/usr" ]; then
    echo "rootfs: 已就绪（$(du -sh "$ROOTFS" 2>/dev/null | cut -f1)）"
    if [ -x "$ROOTFS/bin/sh" ] || [ -x "$ROOTFS/usr/bin/sh" ]; then
      for b in node npm dsh; do
        if chroot "$ROOTFS" /bin/sh -lc "command -v $b" >/dev/null 2>&1; then
          echo "  $b: $(chroot "$ROOTFS" /bin/sh -lc "command -v $b" 2>/dev/null)"
        else
          echo "  $b: 缺"
        fi
      done
    else
      echo "  warn: rootfs 里没有 /bin/sh，跑不起来"
    fi
  else
    echo "rootfs: 未初始化（$ROOTFS）"
  fi
  echo "代码: $MODDIR（$(ls "$MODDIR/bin" 2>/dev/null | wc -l) 个 bin 脚本）"
  echo "单元启动方式："
  for u in napcat bridge web; do
    sh "$MODDIR/bin/unit.sh" explain "$u" 2>/dev/null | head -1
  done
}

if [ "$MODE" = check ] || [ -z "$MODE" ]; then check; exit 0; fi

if [ -d "$ROOTFS" ] && [ -n "$(ls -A "$ROOTFS" 2>/dev/null)" ] && [ "$FORCE" -ne 1 ]; then
  die "$ROOTFS 已存在且非空（重跑会覆盖别人的系统）。确认要覆盖就加 --force"
fi

mkdir -p "$DATA_ROOT" || die "建不了 $DATA_ROOT"

case "$MODE" in
  clone)
    [ -d "$SRC/usr" ] || die "--from 需要指向一个解包好的 Ubuntu 目录（缺 $SRC/usr）"
    [ "$FORCE" -eq 1 ] && rm -rf "$ROOTFS"
    if [ "$LINK" -eq 1 ]; then
      echo "硬链接克隆（与源共享 inode，任何一侧原地写都会影响另一侧）"
      sh "$MODDIR/bin/rootfs-clone.sh" "$SRC" "$ROOTFS" || die "克隆失败"
    else
      # 默认用 tar 管道复制：新 inode，符号链接/权限保留，不会和源打架。
      # 必须排除 proc/dev/sys/sdcard：源里这些可能是挂载点，跟着复制会把内核文件系统翻一遍。
      mkdir -p "$ROOTFS"
      echo "复制 $SRC → $ROOTFS（几 GB 要几分钟；排除 proc/dev/sys/sdcard/data）"
      ( cd "$SRC" && tar -cf - --exclude=./proc --exclude=./dev --exclude=./sys \
          --exclude=./sdcard --exclude=./data . ) | ( cd "$ROOTFS" && tar -xf - ) \
        || die "复制失败（磁盘满了？或 tar 不支持 --exclude）"
    fi
    ;;
  tarball)
    [ -f "$SRC" ] || die "找不到 tar 包：$SRC"
    SUM="$SRC.sha256"
    if [ -f "$SUM" ]; then
      WANT=$(cut -d' ' -f1 "$SUM" | head -1)
      if command -v sha256sum >/dev/null 2>&1; then GOT=$(sha256sum "$SRC" | cut -d' ' -f1)
      elif command -v shasum >/dev/null 2>&1; then GOT=$(shasum -a 256 "$SRC" | cut -d' ' -f1)
      else die "没有 sha256sum/shasum，无法校验"; fi
      [ "$GOT" = "$WANT" ] || die "sha256 不匹配：期望 $WANT，实际 $GOT"
      echo "sha256 ok：$GOT"
    elif [ "$FORCE" -ne 1 ]; then
      die "缺少 $SUM；不校验的运行时不能装（S-4）。确认来源可信就加 --force"
    else
      echo "warn: 跳过 sha256 校验（--force）"
    fi
    mkdir -p "$ROOTFS"
    echo "解包 $SRC → $ROOTFS"
    tar -xzf "$SRC" -C "$ROOTFS" 2>/dev/null || { gzip -dc "$SRC" | tar -xf - -C "$ROOTFS"; } || die "解包失败"
    ;;
esac

[ -d "$ROOTFS/usr" ] || die "$ROOTFS 里没有 /usr，不像 Ubuntu rootfs"

echo
echo "rootfs 就绪：$ROOTFS"
echo "下一步（在 root shell 里跑，需要网络）："
echo "  chroot $ROOTFS /bin/bash -lc 'apt-get update && apt-get install -y nodejs npm ca-certificates'"
echo "  chroot $ROOTFS /bin/bash -lc 'npm i -g @deepseek-ai/dsh'"
echo "然后把 $DATA_ROOT/etc/tinda.conf 里的 DSH_BIN 指到 rootfs 内路径，再："
echo "  sh $MODDIR/bin/unit.sh restart bridge   # 会打印「启动方式 chroot」"
echo
sh "$0" --check 2>/dev/null | head -12
