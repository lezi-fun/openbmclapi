# BMCLAPI
BMCLAPI是@bangbang93开发的BMCL的一部分，用于解决国内线路对Forge和Minecraft官方使用的Amazon S3 速度缓慢的问题。BMCLAPI是对外开放的，所有需要Minecraft资源的启动器均可调用。


# OpenBMCLAPI

> 本仓库是 OpenBMCLAPI 的现代化维护版：在保持 BMCLAPI 控制面、节点注册和下载协议
> 兼容的前提下，升级到当前 Node.js 与现代依赖，提供 HTTP/2 支持，并强化缓存和存储
> 正确性。

这个项目的主要目的是辅助bmclapi分发文件
对节点的要求降低了不少

1. 公网可访问（端口映射也可），可以非80
2. 10Mbps以上的上行速度
3. 暂时不接受国外节点了
4. 可以长时间稳定在线
5. 暂不支持IPv6 only(可以双栈)

[Wiki](https://github.com/bangbang93/openbmclapi/wiki)

- 如果你是家庭宽带打算参与，配置信息可以参考 [家宽搭建说明](https://github.com/bangbang93/openbmclapi/wiki/%E5%AE%B6%E5%AE%BD%E6%90%AD%E5%BB%BA%E8%AF%B4%E6%98%8E)

- 如果你是国内服务器打算参与，配置信息可以参考 [国内服务器搭建说明](https://github.com/bangbang93/openbmclapi/wiki/%E5%9B%BD%E5%86%85%E6%9C%8D%E5%8A%A1%E5%99%A8%E6%90%AD%E5%BB%BA%E8%AF%B4%E6%98%8E)
- 如果你是Alist云盘分发打算参与，配置信息可以参考 [使用alist的WebDav模式挂载参数示例](https://github.com/bangbang93/openbmclapi/wiki/%E4%BD%BF%E7%94%A8alist%E7%9A%84WebDav%E6%A8%A1%E5%BC%8F%E6%8C%82%E8%BD%BD%E5%8F%82%E6%95%B0%E7%A4%BA%E4%BE%8B)

安装
---

### Docker Cli

如果你不熟悉docker，可以参考[Docker部署指北](https://github.com/bangbang93/openbmclapi/wiki/docker%E9%83%A8%E7%BD%B2%E6%8C%87%E5%8C%97)

```bash
docker run -d \
-e CLUSTER_ID=${CLUSTER_ID} \
-e CLUSTER_SECRET=${CLUSTER_SECRET} \
-e CLUSTER_PUBLIC_PORT=${CLUSTER_PORT} \
-e TZ=Asia/Shanghai \
-v /data/openbmclapi:/opt/openbmclapi/cache \
-p ${CLUSTER_PORT}:4000 \
--restart always \
--name openbmclapi \
bangbang93/openbmclapi
```

若无法访问 Docker Hub Registry, 可以使用国内镜像:

```bash
docker pull registry.bangbang93.com/bmclapi/openbmclapi
```

### Docker Compose
请先根据 [设置参数](#设置参数) 中说明的内容创建 `.env` 文件或直接更改 `docker-compose.yml` 文件, 然后运行以下命令:

```bash
docker compose up -d
```

## 配置

| 环境变量                | 必填 | 默认值          | 说明                                                                                                     |
|---------------------|----|--------------|--------------------------------------------------------------------------------------------------------|
| CLUSTER_ID          | 是  | -            | 集群 ID                                                                                                  |
| CLUSTER_SECRET      | 是  | -            | 集群密钥                                                                                                   |
| CLUSTER_IP          | 否  | 自动获取公网出口IP   | 用户访问时使用的 IP 或域名                                                                                        |
| CLUSTER_PORT        | 否  | 4000         | 监听端口                                                                                                   |
| CLUSTER_PUBLIC_PORT | 否  | CLUSTER_PORT | 对外端口                                                                                                   |
| CLUSTER_BYOC        | 否  | false        | 是否使用自定义域名, (BYOC=Bring you own certificate),当使用国内服务器需要备案时, 需要启用这个参数来使用你自己的域名, 并且你需要自己提供ssl termination |
| ENABLE_NGINX        | 否  | false        | 使用 nginx 提供文件服务                                                                                        |
| DISABLE_ACCESS_LOG  | 否  | false        | 禁用访问日志输出                                                                                               |
| ENABLE_UPNP         | 否  | false        | 启用 UPNP 端口映射                                                                                           |
| SSL_KEY             | 否  | -            | （仅当开启BYOC时）  SSL 证书私钥。可以直接粘贴证书内容，也可以填写文件名                                                              |
| SSL_CERT            | 否  | -            | （仅当开启BYOC时）  SSL 证书公钥。可以直接粘贴证书内容，也可以填写文件名                                                              |
| DISABLE_ACCESS_LOG            | 否  | false            | 关闭访问日志控制台输出                                                              |
| NODE_ENV            | 否  | -            | 开发调试环境（development）                                                              |
| CLUSTER_BMCLAPI            | 否  | https://openbmclapi.bangbang93.com            | 主控地址                                                              |

如果你在源码中发现了其他环境变量, 那么它们是为了方便开发而存在的, 可能会随时修改, 不要在生产环境中使用

### 安装包

从 [Github Release](https://github.com/bangbang93/openbmclapi/releases) 中选择对应你的系统的最新版本

### 从源码安装

#### 环境

- Node.js 24 以上、低于 27
- Bun 1.3 以上
- Windows/MacOS/Linux, x86/arm均可 (凡是nodejs支持的环境都可以)

#### 设置环境

1. 去 <https://nodejs.org/zh-cn/> 下载LTS版本的nodejs并安装
2. 安装 Bun

我们推荐使用 **Bun**。Bun 是一个面向现代 JavaScript 和 TypeScript 应用的一体化
工具链，内置运行时、包管理器、脚本运行器、测试运行器和打包器。

- 官方下载与安装地址：<https://bun.com/docs/installation>

3. Clone、安装依赖并启动

```bash
git clone https://github.com/lezi-fun/openbmclapi
cd openbmclapi
bun install
bun run build
bun run start
```

4. 如果你看到了 `CLUSTER_ID is not set` 的报错, 说明一切正常, 该设置参数了

#### 常用开发命令

| 作用 | npm | Bun |
|---|---|---|
| 开发模式 | `npm run dev` | `bun run dev` |
| 构建 | `npm run build` | `bun run build` |
| 启动构建产物 | `npm start` | `bun run start` |
| 测试（包含构建） | `npm test` | `bun run test` |
| 代码检查 | `npm run lint` | `bun run lint` |
| 完整检查 | `npm run check` | `bun run check` |

## 从 v1 迁移

以下步骤适用于源码安装的 v1 节点。迁移会保留原有 `.env` 和 `cache/`，不需要重新同步
已经缓存的文件。操作前先停止正在运行的 v1 进程、systemd 服务或进程管理器任务，避免
新旧版本同时写入缓存。

### 1. 升级 Node.js

现代版支持 Node.js 24、25 和 26，生产环境推荐安装 Node.js 24 LTS。请从
[Node.js 官方下载页](https://nodejs.org/en/download) 安装对应操作系统和架构的版本。
Node.js 25 已结束维护，仅作为兼容范围保留，不建议新安装。然后确认版本：

```bash
node --version
```

输出应为 `v24.x`、`v25.x` 或 `v26.x`。不要继续使用 v1 时代的旧 Node.js，也不要安装
超出 `package.json` 支持范围的 Node.js 27 或更高版本。

### 2. 安装 Bun

Bun 是现代 JavaScript/TypeScript 一体化工具链。本项目推荐使用 Bun 安装依赖和运行
项目脚本，但生产服务仍由 Node.js 执行。

macOS 或 Linux：

```bash
curl -fsSL https://bun.com/install | bash
```

Windows PowerShell：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

重新打开终端后确认安装成功：

```bash
bun --version
```

更多安装方式见 [Bun 官方安装文档](https://bun.com/docs/installation)。

### 3. 保留缓存并更新源码

先停止 v1 服务并进入原 v1 安装目录。下面的命令都应逐行执行；不要复制终端提示符，
例如 `root@server:~#` 或 `user@mac %`。

```bash
pwd
du -sh cache
[ ! -f .env ] || cp .env .env.v1-backup
```

`pwd` 必须显示实际的 v1 安装目录，`du` 必须能读取现有缓存。任何命令报错都应停下，
不要继续执行后面的命令。

如果目录中存在 `.git/`，使用下面的命令更新：

```bash
test -d .git && echo 'Git 仓库正常'
git status --short
git remote set-url origin https://github.com/lezi-fun/openbmclapi.git
git fetch origin master
git switch master
git merge --ff-only origin/master
node -e "const p=require('./package.json'); if (!p.version.startsWith('2.') || !p.scripts?.check || !p.scripts?.start) process.exit(1); console.log('OpenBMCLAPI', p.version)"
```

第一条命令必须输出 `Git 仓库正常`。如果 `git status --short` 有输出，先备份对应修改，
不要直接合并。最后一条命令必须输出 `OpenBMCLAPI 2.x.x`；否则说明源码没有完成更新，
此时 `check` 和 `start` 脚本也不会存在。

如果原 v1 是 Release 压缩包、目录中没有 `.git/`，不要在旧目录内执行 Git 命令。
保持当前目录为 v1 安装目录，将 v2 安装到当前用户可写的主目录，并链接原缓存：

```bash
OLD_OPENBMCLAPI_DIR="$PWD"
NEW_OPENBMCLAPI_DIR="$HOME/openbmclapi-v2"
echo "旧版本：$OLD_OPENBMCLAPI_DIR"
echo "新版本：$NEW_OPENBMCLAPI_DIR"
ls -ld "$OLD_OPENBMCLAPI_DIR/cache"
git clone https://github.com/lezi-fun/openbmclapi.git "$NEW_OPENBMCLAPI_DIR"
[ ! -f "$OLD_OPENBMCLAPI_DIR/.env" ] || cp "$OLD_OPENBMCLAPI_DIR/.env" "$NEW_OPENBMCLAPI_DIR/.env"
ln -s "$OLD_OPENBMCLAPI_DIR/cache" "$NEW_OPENBMCLAPI_DIR/cache"
cd "$NEW_OPENBMCLAPI_DIR"
node -e "const p=require('./package.json'); if (!p.version.startsWith('2.') || !p.scripts?.check || !p.scripts?.start) process.exit(1); console.log('OpenBMCLAPI', p.version)"
```

这组命令不需要 `sudo`。如果 `~/openbmclapi-v2` 已存在，`git clone` 会明确报错；不要
覆盖该目录，应检查后改用另一个新目录名。`cache/` 已被 Git 忽略，快进更新不会删除
其中的文件；Release 迁移方式也只是链接原缓存。不要运行 `rm -rf cache`、
`git clean -fdx` 或重新创建空的 `cache/`。

安装依赖、构建并验证：

```bash
bun install
bun run check
```

确认检查通过后，继续使用原来的 `.env` 和 `cache/` 启动：

```bash
bun run start
```

如果原服务由 systemd、Supervisor 或其他进程管理器托管，请保持原有工作目录、`.env`
和缓存路径，只将启动命令更新为 `bun run start`，然后重启对应服务。

### 设置参数

在项目根目录创建一个文件, 名为 `.env`

写入如下内容

```env
CLUSTER_ID=你的CLUSTER_ID
CLUSTER_SECRET=你的CLUSTER_SECRET
CLUSTER_PORT=对外访问端口
```

CLUSTER_ID 和 CLUSTER_SECRET 请联系我获取

如果配置无误的话, 运行程序, 就会开始拉取文件, 拉取完成后就会开始等待服务器分发请求了

### 同步数据

openbmclapi 会自行同步需要的文件, 但是初次同步可能会速度过慢, 如果您的节点是个全量节点, 可以通过以下命令使用rsync快速同步
以下三台rsync服务器是相同的, 你可以选择任意一台进行同步
- `rsync -rzvP openbmclapi@home.933.moe::openbmclapi cache`
- `rsync -avP openbmclapi@storage.yserver.ink::bmcl cache`
- `rsync -azvrhP openbmclapi@openbmclapi.home.mxd.moe::data cache`
