# NapCat 安装（独立容器）

> 前提：模块已刷入、`bin/napcat.sh init` 已解出 rootfs。

## 需要准备两个包

| 包 | 从哪来 | 放进 |
| --- | --- | --- |
| QQNT Linux **arm64** `.deb` | im.qq.com/linuxqq 下载页，选 Linux / arm64 | `/sdcard/Download/DSH-Go/napcat-install/` |
| NapCat `Shell` 包 `.zip` | github.com/NapNeko/NapCatQQ/releases | 同上 |

文件名不必精确，只要匹配 `*linuxqq*arm64*.deb` 和 `NapCat*.zip`。

## 安装

```sh
su -c 'sh /data/adb/modules/tinda-bot/bin/napcat-install.sh'
```

它会：解包 → 容器内 `apt` 装依赖（libnss3、libgbm1、CJK 字体等）→ `dpkg -i` QQNT → 解 NapCat 到 `/opt/napcat/app` → 写 `/opt/napcat/start.sh`。

## 首次登录（人工）

```sh
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh start napcat'
su -c 'sh /data/adb/modules/tinda-bot/bin/unit.sh logs napcat 80'
```

日志里会出现二维码（ASCII 或图片路径），用手机 QQ 扫。**扫码这一步必须你本人**，我不代劳。

登录后 NapCat 会把票据存在容器内 `~/.config/QQ`，之后靠 `quickLogin` 续命。

## 接进桥接器

登录成功后 NapCat 监听 `127.0.0.1:3001`（ws 服务端）。桥接器侧配置：

```json
{ "onebot": { "mode": "forward-ws", "url": "ws://127.0.0.1:3001", "accessToken": "<secrets 里的 token>" } }
```

## 两个禁令

1. **同一个 QQ 号不能同时登两个实例**（手机 QQ + 容器 NapCat 也算两个，注意 NapCat 用的是独立协议端，通常不冲突，但别起两个 NapCat）
2. 不要把 `~/.config/QQ` 提交进 git——里面有登录票据
