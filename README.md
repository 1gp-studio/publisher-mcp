# 1GP Publisher MCP

在 Codex、Claude Code 等支持 MCP 的客户端里检查并发布当前游戏到 https://1gp-game-platform.vercel.app 。每个用户使用自己的平台账号，一次浏览器授权后即可发布。无需平台管理员的 Vercel 或 Supabase Token。

## 安装

需要 Node.js 24+、npm（首次从 GitHub 安装 MCP 时需要 Git）。游戏本身不需要 Git 仓库。这是标准的 stdio MCP 服务，任何 MCP 客户端都能使用。

### Codex

在 Codex 的 `~/.codex/config.toml` 中添加：

```toml
[mcp_servers.onegp]
command = "npx"
args = ["--yes", "github:1gp-studio/publisher-mcp#v0.5.0"]
startup_timeout_sec = 60
tool_timeout_sec = 600
```

保存并重新打开 Codex 任务。首次运行 npx 会下载本项目及依赖，需要网络访问。

配置字段依据 [Codex 官方配置文档](https://learn.chatgpt.com/docs/config-file/config-reference)。

### Claude Code

在终端运行（`--scope project` 会写入当前游戏目录的 `.mcp.json`，只对这个项目生效；去掉则只对你本人生效）：

```sh
claude mcp add onegp --scope project -- npx --yes github:1gp-studio/publisher-mcp#v0.5.0
```

或直接在游戏目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "onegp": { "command": "npx", "args": ["--yes", "github:1gp-studio/publisher-mcp#v0.5.0"] }
  }
}
```

重新打开 Claude Code，首次使用项目级配置时确认启用该服务器。首次 npx 下载较慢，可用 `MCP_TIMEOUT=60000 claude` 启动以放宽启动超时。

### 本地源码

也可克隆此仓库，运行 `npm ci --ignore-scripts`，将 command 设置为 Node 可执行文件的绝对路径，args 设置为 `src/server.js` 的绝对路径。

## 使用

1. 告诉 AI（Codex / Claude Code）：**连接 1GP 发布平台**。调用 `connect_platform` 后，用户本人打开返回的授权链接，登录并点击允许。对照页面与工具的客户端指纹。
2. 打开游戏项目，告诉 AI：**检查当前游戏，支持的话发布到 1GP，把试玩链接给我。**
3. MCP 自动读取名字和介绍（Vite 项目读 package.json，Godot 项目读 project.godot）以及要上传的文件；未提供介绍时使用中性的默认介绍，不推断玩法。
4. `publish_game` 返回构建 ID；每隔至少 10 秒调用 `get_publish_status`，直到 `ready` 或 `failed`。只有 ready 表示发布成功。

## 版本号与更新说明（v0.5.0）

每次发布前调用 `prepare_release(project_directory, gameSlug?, docker_project?)`，沿用游戏标识。工具将本地文件哈希与上次成功发布比较，返回新增、修改、删除的路径和版本建议。本地 AI 必须阅读相关代码，有 Git 历史时结合上次 sourceCommit 的 diff，按玩法、关卡、修复、平衡、界面和资源等主要方面精简概括。文件名不能证明具体玩法变化，没有基线时明确说明，不能编造差异。

- 首发 `1.0.0`；大规模玩法重做或存档不兼容升主版本；新玩法/关卡升次版本；修复、平衡或纯资源变化升补丁版本。
- 作者可以修改建议。所有发布工具需要 `release`，格式示例：`{"version":"1.1.0","title":"新关卡","notes":"关卡：新增森林挑战。修复：解决结算卡住。","changeType":"minor"}`。实际内容必须来自当前项目，`changeType` 为 `major`、`minor`、`patch` 或 `assets`。
- Docker 发布传入 `project_directory` 才能保存下一次比较的源码清单。只上传路径与 SHA-256 哈希，不上传源码正文；跳过隐藏文件、依赖、常见输出和凭证，比较上限为 1,000 文件、64 MiB。
- 成功后更新日志才对玩家展示；失败记录留在作者历史中。作者可在历史页修改版本和说明，回退可用的旧 Vercel 部署或 Docker 镜像。回退不恢复玩家存档或外部数据；产物被云服务删除后不可恢复。外部链接不支持回退。
- 升级后重启客户端，重新加载工具。下方参数示例用于检查；调用发布时须另加 `release`。

## 通用静态网页发布

发布不要求 Vite。平台需要的是能直接由浏览器运行的静态网页目录，根目录含 `index.html`。支持四种流程：

| 项目类型 | 调用方式 | 本地行为 |
| --- | --- | --- |
| 独立 HTML / JavaScript / Canvas 游戏，没有 package.json | 直接 `inspect_game` / `publish_game` | 打包当前目录中的浏览器文件，不运行 npm |
| 已有静态网页产物，任意构建工具或框架 | 指定 `output_directory` | 只打包选中的目录，不运行构建 |
| 使用 npm 脚本导出网页的项目 | 指定 `build_script` 和 `output_directory` | 在本地运行项目自己的脚本，不附加 Vite 参数，然后打包产物 |
| Vite 项目 | 不提供额外参数 | 在本地运行 build 脚本，使用独立临时输出目录；完成后清理 |

例如 Webpack / Parcel / Astro 等项目可以使用其自身的静态输出；Next.js 必须先配置并生成静态导出，再选择 `out`，不能上传 `.next` 服务端目录。目录名称取决于项目配置，不会仅根据框架名称猜测。依赖服务端的项目可由团队账号使用下方 Docker 托管流程；已有托管地址也可以调用 `publish_link`。使用 pnpm、yarn 或其他构建工具时，可让本地 AI 工具先构建，再选择输出目录发布；MCP 内置脚本执行器只运行 npm 脚本。

已有产物：

```json
{"project_directory":"/absolute/game","output_directory":"dist"}
```

先执行项目定义的脚本，再打包：

```json
{"project_directory":"/absolute/game","build_script":"export:web","output_directory":"site"}
```

两组参数均可用于 `inspect_game` 和 `publish_game`。检查不执行脚本；已有产物会返回上传文件清单和大小。无法自动识别时返回 `OUTPUT_REQUIRED` 和可用脚本名称，由 AI 读取项目配置，选择正确输出，不需要迁移到 Vite。`output_directory` 必须是项目内的相对路径，不能经过符号链接；有构建脚本的项目禁止选择项目根目录。未构建的项目源码树不会作为兜底上传。

运行构建前需自行安装项目依赖。自定义脚本模式最多执行 5 分钟，必须生成或更新输出目录的 `index.html`，否则停止，不上传旧产物，也不删除已有输出。使用增量构建且入口未变时，可明确以已有产物模式发布。项目身份取决于项目根目录，切换输出目录不会另建游戏。

Godot 保留专用流程：读取 `project.godot` 和 Web 导出预设，上传本地单线程 Release 导出的 `index.*`，引擎 wasm 按哈希使用平台托管版本。MCP 不运行 Godot；导出早于源码时须先重新导出。目前支持 Godot 4.6.1-stable。引擎版本不受支持时可使用 `publish_link`。

### 更新转移或移动后的游戏

本地项目默认按当前账号和项目根目录识别。接收游戏所有权后，或把项目移动到另一个文件夹、另一台电脑时，使用 `publish_game` 的可选 `gameSlug` 指定要更新的原游戏，避免另建作品。标识取自游戏页面网址的 `/games/` 后面，例如 `/games/my-game-a1b2c3d4` 对应 `my-game-a1b2c3d4`。

```json
{"project_directory":"/absolute/new-game-folder","output_directory":"dist","gameSlug":"my-game-a1b2c3d4"}
```

Godot 也使用同一个 `gameSlug` 参数，不需要 `output_directory`。平台只允许更新当前账号拥有的、本地上传的游戏；目标不存在、属于他人或来自 GitHub / 外部链接时会报错，不会退回到新建游戏。游戏页面标识和玩家数据保持不变。不指定 `gameSlug` 时，仍按原有文件夹规则发布。此参数需使用 MCP v0.3.1 或更新版本，以及支持游戏转移的平台版本；旧版 MCP 不会发送更新目标。

网页产物限 3 MiB / 300 文件（Godot 不含引擎）。支持 HTML、JS、CSS、JSON、字体、图片、音视频、WASM、glTF、data/bin/atlas、XML 和 webmanifest。source map、隐藏文件、依赖及常见项目配置不上传；内联 source map、检测到的凭证或符号链接导致拒绝。更大游戏可自行托管产物再接入链接。平台直接部署，不安装依赖或执行构建。

**浏览器 JavaScript 和资源会提供给平台及玩家。纯 HTML/JS 游戏的这些文件本身就是可发布代码，不能声称它们仍然私密。** 不要将私密内容放入网页目录或通过构建复制进产物；过滤无法识别所有私密文件。只在你信任的项目上运行构建脚本。上传的是明确选择的网页目录，不是整个框架源码项目。

## 工具

| 工具 | 用途 |
| --- | --- |
| prepare_release(project_directory, gameSlug?, docker_project?) | 对比上次成功发布并获取版本建议，不构建或发布 |
| inspect_game(project_directory, output_directory?, build_script?) | 只读检测当前绝对路径，返回支持情况及构建方式（web-static / godot-web） |
| connect_platform() | 建立当前客户端连接，返回用户授权网址 |
| publish_game(project_directory, title?, description?, output_directory?, build_script?, gameSlug?) | 检测后发布；可指定原游戏标识，在转移所有权或移动文件夹后继续更新同一游戏 |
| publish_link(url, project_directory?, title?, description?) | 把已部署的可玩 HTTPS 网址发布为 1GP 游戏页，不构建；同一网址再次提交会更新同一作品 |
| get_publish_status(build_id) | 查询当前账号自己的构建和试玩网址 |

需要指定输出时返回 `OUTPUT_REQUIRED`。错误包含 `LOCAL_BUILD_FAILED`、`UNSUPPORTED_BUILD`、`POTENTIAL_SECRET`、`AUTH_REQUIRED`，`publish_link` 另有 `INVALID_URL`、`TITLE_REQUIRED`；连不上平台时为 `NETWORK_ERROR`。遇到网络不确定的发布结果不要自动重复提交，可到网站「我的发布」查看。

## 授权与限制

本地凭证保存在 `~/.config/1gp-studio/`，目录权限 0700，文件权限 0600。平台仅保存 SHA-256 哈希。凭证不会通过工具结果或浏览器 URL 输出。授权 90 天有效，仅允许发布和查询自己的构建；在网站「我的发布」撤销后，再运行 connect_platform 可重新连接。

平台目前限制全站同时 2 个构建、每个账号最多 50 个作品，不设每日次数限制。账号邮箱验证由 Supabase 负责；平台管理员必须配置生产邮件服务，才能支持组织外用户收取登录邮件。Vercel 的套餐、GitHub 访问授权及构建限制仍适用。

开发时可使用 `ONEGP_PLATFORM_URL` 指向另一 HTTPS 平台，或本机 HTTP localhost/127.0.0.1；凭证按平台分别保存。测试运行 `npm test`，包括真实 MCP stdio 客户端集成测试。

## v0.4.0

打包时跳过项目顶层的 `1gp-kit/` 文件夹。这个文件夹是 1gp-store-kit Skill 生成的上架物料（封面、截图、预览视频），在网站上导入，不属于游戏本身；旧版本会把它一起上传，预览视频会超出 3 MB 上限。只改客户端，平台无需改动。

## v0.3.1 发布顺序

先同步游戏所有权管理所需的数据库迁移并部署支持 `gameSlug` 的平台，再发布 MCP 的 v0.3.1 tag。客户端需更新安装配置中的版本并重启，才能使用新参数。旧 v0.3.0 保留按文件夹发布的行为；转移或移动后的游戏应升级后再指定 `gameSlug` 更新。

## v0.3.0 发布顺序

先部署支持 `web-static` 的平台，再发布 MCP 的 v0.3.0 tag，最后更新客户端配置并重启。旧 v0.2.0 仍上传 Vite 源码；升级 MCP 才能使用本地构建。平台保留旧协议以兼容已有客户端。平台与 tag 发布前，请使用本地源码和测试平台验证。


## Docker 游戏：全程在本地 AI 工具里发布

需要 Node.js 24+、Docker（含 Buildx），Windows 的 Docker Desktop 需使用 Linux containers。
只需要已有的 **1GP 平台授权**；无需 AWS 账号、AWS SSO、Access Key 或 ECR 登录。
当前沿用团队管理员账号、单台主机一个游戏的实验范围。

可以直接告诉 AI：

> 用 1GP MCP 把当前游戏发布到 EC2 Docker 托管。检查代码并准备 Dockerfile 和 .dockerignore，在本地构建 Linux/amd64 镜像，上传给平台，等校验通过后发布，把可玩的链接给我。使用稳定的项目标识 my-game，更新时不要改变它。不要申请 AWS 凭证，也不要直接推送 ECR。

工具调用顺序：

1. `connect_platform`：复用现有授权。首次连接仍需用户本人在浏览器确认平台授权，之后不需要去网页上传。
2. 检查实际代码，使用本地编辑工具准备 Dockerfile 和 `.dockerignore`，本地测试 HTTP/WebSocket。MCP 不会猜测或自动覆盖 Dockerfile。
3. `build_docker_image({project_directory})`：执行固定参数的 Docker Buildx 构建与 `docker save`，返回本地 `archive_path`。也可跳过构建，使用已有 Docker archive。
4. `upload_docker_image({archive_path, project})`：流式上传文件至平台私有暂存区，返回 `upload_id`。不把镜像转成 Base64，也不把平台令牌发给 S3。
5. 每隔至少 10 秒调用 `get_docker_upload_status({upload_id})`，直到 `ready` 或 `failed`。准备好后才进入发布。
6. `publish_docker_game({upload_id, project, title, description})`：项目标识必须与上传时一致。返回构建 ID 后，每隔至少 10 秒调用已有的 `get_publish_status`，只有 `ready` 才表示发布成功。

上传任务 ID 会保存在 MCP 的本地私有配置目录。上传中断或工具重启后，可调用
`get_docker_upload_status({})` 恢复最后一次任务；如果文件已传完，会继续完成平台导入。
不会自动重复上传或重复发布。未传完的上传占位在 20 分钟后过期，可重用本地镜像文件重试。
发布请求的响应不确定时，不要直接再发一次发布；先检查已返回的构建 ID，或在平台确认状态。

镜像要求：Linux/amd64、非 root USER、无 VOLUME、监听 `0.0.0.0:3000`、`GET /` 返回 2xx。
运行资源为 512 MiB 内存、1 CPU、只读文件系统，仅 `/tmp` 可写（64 MiB）。持久化数据放外部服务。
导出的未压缩 `.tar` 最多 256 MiB，内部镜像层展开后最多 512 MiB；不支持 `docker export`。
导入不会运行游戏；发布同一项目会短暂断线并重置内存状态，部署失败会保留或恢复旧容器。

构建前 `.dockerignore` 必须至少包含下列规则，且不使用 `!` 重新包含；若有
`Dockerfile.dockerignore`，先合并到根 `.dockerignore`。还应检查项目自己的其他敏感文件。

```gitignore
**/.env*
**/.git
**/.aws
**/.ssh
**/.config
**/*.pem
**/*.key
```

这些规则不等于完整的镜像密钥扫描。不要在 Dockerfile、源文件或构建参数中嵌入凭证。
构建会在本机执行 Dockerfile；本地构建日志不经 MCP 返回，以免暴露构建过程里的敏感内容。
MCP 自动移除自己创建的临时镜像标签，保留私有临时目录中的 `.tar` 供重试；导入成功后可用本地工具删除该文件。
