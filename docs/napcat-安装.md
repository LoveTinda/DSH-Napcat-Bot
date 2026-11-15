# NapCat 安装（宿主直装）

> 现在跑的是「QQ + NapCat 同一进程」的宿主安装，**不是**容器。
> 容器路线（chroot）在这台机器的 proot 引擎里跑不通：`chroot` 一律报
> `failed to run command '/bin/bash': No such file or directory`，所以放弃了。

## 1. 需要两个包

| 包 | 从哪来 | 放到 |
| --- | --- | --- |
| QQNT Linux **arm64** `.deb` | 腾讯官方 404 了所有旧链接；能下到的镜像：`https://mirrors.sdu.edu.cn/spark-store-repository/aarch64-store/chat/linuxqq/linuxqq_3.2.35-54395_arm64.deb` | `/sdcard/Download/DSH-Go/napcat-install/` |
| NapCat `Shell` `.zip` | GitHub releases 已 404；从官方 Docker 镜像的层里取（见下） | 同上 |

文件名只要匹配 `*linuxqq*arm64*.deb` 和 `NapCat*.zip` 就能被脚本认出来。

从镜像层取 NapCat 的办法（GitHub release 下不动时）：

```sh
# 1) 拿 token
TOKEN=$(node -e 'fetch("https://m.daocloud.io/auth/token?service=registry.docker.io&scope=repository:m.daocloud.io/napneko/napcatQQ:pull").then(r=>r.json()).then(j=>j.token).then(console.log)')
# 2) 列层 → 3) 下载最大的那层 → 4) 从里面翻出 NapCat.Shell.zip
```

## 2. 装

```sh
sh bin/napcat-install-host.sh
```

它做四件事：

1. 解 deb，把 QQ 放到 `/opt/QQ`
2. 解 zip，把 NapCat 放到 `/opt/napcat`
3. **注入**：写 `tinda-launcher.js`，把 `/opt/QQ/resources/app/package.json` 的 `main` 指过去
   （原文件备份 `.tinda-orig`），launcher 里带快速登录
4. 写 `/opt/napcat/start-tinda.sh`（只转发到 `bin/napcat-start-host.sh`）

`gnutls-shim.so` 已不再生成：QQ 3.2.34 下不需要。只在遇到
`libbugly.so: undefined symbol: gnutls_free` 时才手动编一个并 preload。

## 3. 关键：注入方式

NapCat 的 `wrapper.node` 引用了 `qq_magic_napi_register`，这个符号只有 QQ 可执行文件导出。
所以 **不能** `node napcat.mjs` 单独跑，必须让 NapCat 加载进 QQ 主进程：

- `/opt/QQ/resources/app/package.json` 的 `main` 改成 `./tinda-launcher.js`
  （原文件备份为 `package.json.tinda-orig`）
- `tinda-launcher.js` 先 `require('./application.asar/app_launcher/index.js')` 让 QQ 正常起来，
  2 秒后 `import('file:///opt/napcat/napcat.mjs')`
- 加载成功后写 `/tmp/tinda-inject.log`，排查注入问题先看它

launcher 还负责**快速登录**：读 `/opt/napcat/config/onebot11_<uin>.json` 拿到账号，
往 `process.argv` 补 `-q <uin>`，否则每次重启都退化成扫码。

## 4. 起与登录

```sh
sh bin/unit.sh start napcat
sh bin/unit.sh logs napcat 60
```

日志里出现二维码 → 手机 QQ 扫（必须本人）。扫码成功后 NapCat 会把票据存在
`/opt/napcat/.config/QQ` 下，之后重启靠 `-q` 快速登录续上。

## 5. 接进桥接器

```sh
sh bin/napcat-wire-onebot.sh
sh bin/unit.sh restart napcat
```

写的是 `httpServers`（3001，给桥接器回发）和 `httpClients`（推事件到 6700）。
细节见 `docs/配置说明.md` 第 5 节。

## 6. 坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `wrapper.node: undefined symbol: qq_magic_napi_register` | NapCat 没在 QQ 进程里跑 | 检查 `package.json` 的 `main` 是否指向 launcher |
| `libbugly.so: undefined symbol: gnutls_free` | 系统 gnutls 版本太新 | `gnutls-shim.so` 是否在、是否 `LD_PRELOAD` 进去 |
| 重启后要求扫码 | 没注入 `-q <uin>` | 看 `/tmp/tinda-inject.log` 有没有「注入快速登录」 |
| 3001 连不上 | NapCat 没加载 OneBot 网络配置 | 日志里找 `[Notice] [OneBot11] [network] 配置加载` |
| 面板白屏 | 用 8443 的 `/napcat/` 前缀访问 | 必须用 8445；前端写死绝对路径 |

## 7. 两个禁令

1. 同一个 QQ 号不要同时起两个 NapCat（本机已有账号时尤其注意，先 `pgrep -af '^/opt/QQ/qq'`）
2. `/opt/napcat/.config/QQ` 里有登录票据，**不要**提交进 git
