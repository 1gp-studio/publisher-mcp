# AIWANNA Publisher MCP

在 Codex、Claude Code 等支持 MCP 的客户端里检查并发布当前游戏到 AIWANNA（https://www.aiwanna.games）。每个用户使用自己的平台账号，一次浏览器授权后即可发布。网页与受支持的服务端函数均由 AIWANNA 统一托管，不需要用户登录 Vercel、提供 Vercel/Supabase Token、选择个人团队或新建个人云项目。

## 安装

需要 Node.js 24+、npm 和 Git，并且能访问 GitHub：首次安装由 npx 从 GitHub 下载本项目。游戏本身不需要 Git 仓库。这是标准的 stdio MCP 服务，任何 MCP 客户端都能使用。

**只装一次，装在用户级。** 一份安装对你所有的游戏项目都有效，不要在每个游戏项目里各装一份，也不要在游戏目录里新建 `.mcp.json`。从 v0.16.0 起会自动更新：启动时、约每 10 分钟、每次调用 `get_publisher_info` 时对照平台推荐版本，有新版就自动换上（正在进行的调用在旧进程里做完）。实际运行版本以 `get_publisher_info` 为准（它会先等更新完成再回答）；握手 `serverInfo.version` 是更新前的，不作数。本流程需要 **0.16.0 或更高兼容版本**。低于 0.16.0（或 `upgrade.automatic` 为 false）时，只把当前客户端已有 AIWANNA 配置里的固定版本改成 `v0.16.0`，保留其他参数、环境配置和授权凭证，这是最后一次手动升级；更高兼容版本不降级。设置环境变量 `ONEGP_MCP_AUTO_UPDATE=0` 可关闭自动更新。

手动改版本号后重新加载 MCP，再用 `get_publisher_info` 核对实际运行版本和工具；客户端无法重载时才请用户重启。配置已经写成新版、工具名称已经存在，都不能证明旧进程已经升级。自动更新后，Claude Code 会在同一个对话里刷新工具；不刷新工具列表的客户端（可能包括 Codex）里，已有工具会用上新代码，新增的工具要重启或新开对话才出现。读不到版本时说明情况，不假定已经完成。

如果某个游戏项目的 `.mcp.json` 里还有以前装的 `onegp`（项目级的会盖过用户级，版本停在旧的），请把那一项删掉，以免两个版本打架。

### Codex

在 Codex 的 `~/.codex/config.toml` 中添加（已有 `[mcp_servers.onegp]` 就只改版本号）：

```toml
[mcp_servers.onegp]
command = "npx"
args = ["--yes", "github:1gp-studio/publisher-mcp#v0.16.0"]
startup_timeout_sec = 60
tool_timeout_sec = 600
```

保存并重新打开 Codex 任务。首次运行 npx 会下载本项目及依赖，需要网络访问。装好 v0.16.0 后会自动更新，不用再改版本号；新增的工具要新开 Codex 任务才出现。

配置字段依据 [Codex 官方配置文档](https://learn.chatgpt.com/docs/config-file/config-reference)。

### Claude Code

在终端运行一次（`--scope user` 对你本人的所有项目生效）：

```sh
claude mcp add onegp --scope user -- npx --yes github:1gp-studio/publisher-mcp#v0.16.0
```

已经装过时，用 `claude mcp list` 确认当前生效的配置，只更新其中固定的包版本；保留既有参数和环境配置，不删除 AIWANNA 的授权凭证。上面的命令用于首次安装，不需要每次发布都重新添加。

重新打开 Claude Code。首次 npx 下载较慢，可用 `MCP_TIMEOUT=60000 claude` 启动以放宽启动超时。装好 v0.16.0 后会自动更新，新工具在当前对话里就会出现，不用再改版本号或重启。

### 本地源码

也可克隆此仓库，运行 `npm ci --ignore-scripts`，将 command 设置为 Node 可执行文件的绝对路径，args 设置为 `src/server.js` 的绝对路径。

## 使用

**第一次装好后要重开 AI 工具（或新开对话）。** Claude Code、Codex 都在开始会话时加载 MCP，装好的那个对话里通常还看不到新工具；重开后再说一次要做的事即可。

1. 告诉 AI（Codex / Claude Code）：**连接 AIWANNA 发布平台**。调用 `connect_platform` 后，用户本人打开返回的授权链接，登录并点击允许。对照页面与工具的客户端指纹。
2. 打开游戏项目，告诉 AI：**检查当前游戏，支持的话发布到 AIWANNA，把试玩链接给我。**
3. MCP 自动读取名字和介绍（Vite 项目读 package.json，Godot 项目读 project.godot）以及要上传的文件；未提供介绍时使用中性的默认介绍，不推断玩法。
4. `prepare_game` 一次返回项目识别、原发布渠道、版本差异、构建检查、语言、已有可选功能、页面物料 `materials` 和常规物料清单 `promotion`。AI 阅读代码并试玩，补缺的分类、作者主语言标签、主封面、制作信息和至少 3 张实机截图（首发需要）；预览可选，发布后问作者要不要做；即使不接多语言也检查这些项目。发布前不追问可选功能：多语言、云存档、排行榜沿用已有设置，作者主动要求时才接入，发布后按 `prepare_game.optionalFeatures` 提醒尚未使用的可选功能；复用已有授权和检查结果。
5. 异步发布返回构建 ID 后调用 `wait_for_publish`。每次最多等 45 秒；pending 时继续同一任务，省略 build_id 可恢复当前账号最近任务。只有 ready 表示部署成功，仍需验证实际游戏。
6. 更新收尾：主动问作者要不要把这版写进版本记录，附上拟好的标题 `title` 和说明 `notes`；作者同意后调用一次 `complete_game_update(..., approved:true)`，写进游戏页「版本更新」，不发帖。作者还没同意时保留草稿和同一 `update_id`。首发不用收尾，首发部署的标题和说明就是第一条版本记录。
7. 发布或更新后主动问作者要不要再发一篇社区帖并附上草稿；作者任何时候要发帖（任何数量）都用 `create_game_post({kind,title,body,approved:true})`：先把完整标题、正文和图片给作者看，同意后再发。
8. 截图、主封面、预览、各语言封面、名字简介、分类标签和制作信息以后都能按作者要求修改（`set_game_media` 的 `replaceCover` / `replacePreview` / `replaceScreenshots`、`edit_game_media`、`set_game_covers`、`set_game_details`）。

## 版本记录与删除

同一次任务的中间部署只记录在作者的构建历史，作者同意最终标题和说明后合并成一条版本记录。作者还没同意时保持草稿；不能为了收尾新建更新组或再部署一次游戏。

游戏页「版本更新」跟着「管理版本」走：每个版本号一条，默认显示。作者要改某条的文字时，先 `get_game_updates` 找到 `reference`，把完整新标题和说明给作者看，认可后 `edit_game_update({gameSlug,reference,title,notes,approved:true})`。作者要求删除（隐藏）旧版本时，先 `get_game_updates({gameSlug})`，按版本、日期和内容核对真实 `reference`；更早记录使用返回的 `nextCursor`。再调用 `delete_game_update({gameSlug,reference,approved:true})`。明确删除同一条的作者指令已经是授权，无需重复确认；不猜编号、不擅自批量清空。删除会隐藏这条公开版本记录及对应更新帖（如有），保留构建历史、部署产物、在线版本、回退能力和玩家数据。结果不明先查询同一游戏，只重试同一 `reference`；已删除的记录不会重建。

## 版本号与更新说明（v0.5.0）

推荐每次发布前调用 `prepare_game(project_directory, gameSlug?, docker_project?)`，其中已包含 `prepare_release` 的结果，沿用游戏标识。只有单独查看版本差异时才需要 `prepare_release`。工具将本地文件哈希与上次成功发布比较，返回新增、修改、删除的路径和版本建议。本地 AI 必须阅读相关代码，有 Git 历史时结合上次 sourceCommit 的 diff，按玩法、关卡、修复、平衡、界面和资源等主要方面精简概括。文件名不能证明具体玩法变化，没有基线时明确说明，不能编造差异。

- 首发 `1.0.0`；大规模玩法重做或存档不兼容升主版本；新玩法/关卡升次版本；修复、平衡或纯资源变化升补丁版本。
- 作者可以修改建议。所有发布工具需要 `release.updateId`，沿用 `prepare_game` 返回的真实 `updateId`；`release` 格式示例：`{"updateId":"从 prepare_game 返回的 UUID","version":"1.1.0","title":"新关卡","notes":"关卡：新增森林挑战。修复：解决结算卡住。","changeType":"minor"}`。实际内容必须来自当前项目，`changeType` 为 `major`、`minor`、`patch` 或 `assets`。
- Docker 发布传入 `project_directory` 才能保存下一次比较的源码清单。只上传路径与 SHA-256 哈希，不上传源码正文；跳过隐藏文件、依赖、常见输出和凭证，比较上限为 1,000 文件、64 MiB。
- 更新的成功部署只保存构建记录；作者同意最终标题和说明、收尾后才成为玩家看到的版本记录。所有构建尝试保留在作者历史中。作者可在历史页修改版本和说明，回退可用的旧 Vercel 部署或 Docker 镜像。回退不恢复玩家存档或外部数据；产物被云服务删除后不可恢复。外部链接不支持回退。
- 升级后重启客户端，重新加载工具。下方参数示例用于检查；调用发布时须另加 `release`。

## 完整游戏 Vercel 发布（v0.6.0）

Vercel 发布同时包含网页和必要的服务端产物，只需 `connect_platform` 的 AIWANNA 授权。**不要登录用户的 Vercel、读取其团队凭证、新建个人云项目或单独部署后端。** AIWANNA 使用平台自己的账号上传、部署和管理游戏前后端。

普通 **Vite + `api/*.js` / `api/*.ts` 游戏，无需预先准备 Vercel 产物**：先调用本地构建工具：

```json
{"project_directory":"/absolute/game"}
```

上述参数用于 `build_vercel_game`。工具执行项目已有 `build` 脚本，用 esbuild 将固定路径（含嵌套路径）的 API 和依赖打包，兼容 Node `req/res` 函数或默认导出的 `http.Server`。保留 `vercel.json` 中受支持的同源 `rewrites`、函数 `maxDuration`/`memory`；支持 `/api/:path*` → `/api/index?__path=/api/:path*` 和 `/healthz` 等规则，原查询参数继续保留。不会执行 API 入口、读取或内联 `process.env` 的值，也不改游戏玩法与存储。`ws` 的可选原生加速模块使用其官方 JavaScript 回退，避免将本机二进制带入 Linux 函数。

构建和完整校验成功后才写入工具管理的 `.1gp/vercel-output`，不会覆盖同名的未受管理目录；失败保留上次成功产物并清理临时目录。检查和发布可以自动识别该目录，也可明确使用工具返回的 `deployment_target` 和 `vercel_output_directory`。这一步不连接云端、不上传、不发布。已有 `prepare_game` 结果时直接沿用版本差异，提供版本说明后 `publish_game`；不要再传 build_script 重复构建，源码改变时重查相关部分。

其他 npm 静态前端可给 `build_vercel_game` 传 `frontend_output_directory` 和可选的 `build_script`；仅给目录则使用已有前端产物。Next/其他 SSR、动态 API 文件名（如 `[id].ts`）、原生依赖、依赖 `import.meta.url` 的入口或其他不受支持配置会明确停止，需要专用框架适配器或 AIWANNA Docker。

本地函数适配器只打包静态模块依赖，不追踪运行时文件。项目或任意传递依赖使用 `fs` / `fs/promises`、`module`、`child_process`、`worker_threads` 或 `vm` 时会停止，即使路径计算与读取分属不同模块。JSON 等数据可通过静态 `import` 打包；确实需要文件系统的项目应使用专用完整产物适配器或 Docker。

已有完整产物：

```json
{"project_directory":"/absolute/game","deployment_target":"vercel","vercel_output_directory":".vercel/output"}
```

本地已有适配器构建脚本：

```json
{"project_directory":"/absolute/game","deployment_target":"vercel","build_script":"build:game"}
```

参数适用于 `inspect_game` 和 `publish_game`；发布另加 `release`，更新原游戏可加 `gameSlug`。默认输出为 `.vercel/output`，也可指定项目内其他目录；`vercel_output_directory` 不能与静态模式的 `output_directory` 混用。不传参数时自动识别已有 `.vercel/output/config.json`。

完整产物遵循 [Vercel Build Output API v3](https://vercel.com/docs/build-output-api)，支持：

- `config.json` 的版本、固定同源路由、静态资源覆盖规则和框架元数据。捕获变量可放在路由目标的查询参数里。
- `static/` 内的网页、浏览器脚本和资源。
- `functions/<name>.func/` 内的 Node.js 22/24 函数、直接子级 `.vc-config.json`、入口和必要依赖；保留函数所需的 `node_modules`、`package.json` 等运行文件。API 和常规 SSR 与前端在同一部署中运行，SSR 根路由不要求静态 `index.html`。

每个函数必须自包含，不支持引用输出外源码的非空 `filePathMap`。产物内指向同一输出目录的符号链接会安全展开，外部链接和循环链接拒绝。当前不支持 Edge、ISR/prerender、images、wildcard、crons、services/daemons 或动态 middleware；检测到会明确报错，不删除必要配置后继续发布。函数支持 Linux x86_64、最多 2048 MiB 内存、300 秒执行时间和单区域。需要常驻进程、WebSocket、进程内多人房间或其他运行能力时使用下方 **AIWANNA Docker 托管**，不要为了部署自动改写玩法、存储方式或删除后端。

检查只读取项目，不运行构建。发现 API、server 或 SSR 而没有完整产物时返回 `VERCEL_OUTPUT_REQUIRED`；普通 Vite/API 项目调用 `build_vercel_game`，其他项目使用无需 Vercel 登录的专用框架适配器。仅执行 `next build` 不代表已生成此格式；不要上传 `.next` 目录或把后端塞进静态目录。工具本身不调用 Vercel CLI、创建云项目或修改游戏；其他包管理器可先在本地构建，再上传已有产物。发布时如指定完整产物构建脚本，必须生成新的 `config.json`，否则停止；明确上传已有产物时省略 `build_script`。

构建脚本预检支持静态命令、正常引号、受支持参数以及同一 `package.json` 中 npm/pnpm/yarn 子脚本和生命周期钩子。动态展开、无法解析的 shell 结构、切换其他项目及未知包管理器调用会被拒绝；这类项目可先自行构建再上传产物。此预检不是任意脚本的安全沙箱，无法证明 `node build.js` 等程序内部会执行什么，只应运行已经审阅并获准执行的项目构建脚本。

完整产物上限 **64 MiB、10000 个文件，单文件 16 MiB，配置 JSON 100 KiB**。工具先校验完整包，再分批上传（每批最多 200 文件、4 MiB JSON）；大文件压缩后仍无法放入一批时须缩小或拆分资源。平台返回 30 分钟有效、绑定当前账号和文件内容的回执，最终发布发送文件引用与必要配置；发布清单及版本说明合计最多 4300 KiB，超限在上传前停止。失败或响应不确定时不会自动重试。平台无需安装游戏依赖或执行云端构建。

source map 不上传；检测到凭据、私钥、`.env` 等文件会拒绝。浏览器资源对玩家公开，服务端产物提交给 AIWANNA 并在服务端运行，不作为静态网页资源公开。不要把秘密写入产物；函数配置仅接受官方默认的空 `environment: {}`，不接受任何环境变量值、`env` 或 `envVarsInUse`。

## 通用静态网页发布

发布不要求 Vite。平台需要的是能直接由浏览器运行的静态网页目录，根目录含 `index.html`。支持四种流程：

| 项目类型 | 调用方式 | 本地行为 |
| --- | --- | --- |
| 独立 HTML / JavaScript / Canvas 游戏，没有 package.json | 直接 `inspect_game` / `publish_game` | 打包当前目录中的浏览器文件，不运行 npm |
| 已有静态网页产物，任意构建工具或框架 | 指定 `output_directory` | 只打包选中的目录，不运行构建 |
| 使用 npm 脚本导出网页的项目 | 指定 `build_script` 和 `output_directory` | 在本地运行项目自己的脚本，不附加 Vite 参数，然后打包产物 |
| Vite 项目 | 不提供额外参数 | 在本地运行 build 脚本，使用独立临时输出目录；完成后清理 |

例如 Webpack / Parcel / Astro 等项目可以使用其自身的静态输出；Next.js 必须先配置并生成静态导出，再选择 `out`，不能上传 `.next` 服务端目录。目录名称取决于项目配置，不会仅根据框架名称猜测。需要 API/SSR 的游戏使用上方完整 Vercel 产物流程，常驻进程游戏可由团队账号使用下方 Docker 托管流程；已有托管地址也可以调用 `publish_link`。使用 pnpm、yarn 或其他构建工具时，可让本地 AI 工具先构建，再选择输出目录发布；MCP 内置脚本执行器只运行 npm 脚本。

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

纯静态网页产物限 3 MiB / 300 文件（Godot 不含引擎）；完整 Vercel 产物使用上方独立限制。支持 HTML、JS、CSS、JSON、字体、图片、音视频、WASM、glTF、data/bin/atlas、XML 和 webmanifest。source map、隐藏文件、依赖及常见项目配置不上传；内联 source map、检测到的凭证或符号链接导致拒绝。更大游戏可自行托管产物再接入链接。平台直接部署，不安装依赖或执行构建。

**浏览器 JavaScript 和资源会提供给平台及玩家。纯 HTML/JS 游戏的这些文件本身就是可发布代码，不能声称它们仍然私密。** 不要将私密内容放入网页目录或通过构建复制进产物；过滤无法识别所有私密文件。只在你信任的项目上运行构建脚本。静态模式上传明确选择的网页目录；完整 Vercel 模式上传完整运行产物，两种模式都不上传整个框架源码项目。

## 工具

当前提供 36 个工具；Docker 构建、上传、查询和发布工具见后文。

| 工具 | 用途 |
| --- | --- |
| prepare_game(project_directory, gameSlug?, docker_project?, features?, update_id?, new_update?) | 统一准备：识别游戏、沿用渠道、版本差异、构建/语言检查和可选功能；记住作者明确选择，不自动启用 |
| complete_game_update(project_directory, update_id, title, notes, approved:true) | 最终部署 ready 并检查后，把作者同意的标题和说明写进游戏版本记录（游戏页「版本更新」、关注动态、更新榜），不发帖；首发不用收尾，首发部署的标题和说明就是第一条版本记录；失败只重试同组同内容 |
| create_game_post(kind, title, body, gameSlug?, score?, images?, project_directory?, approved:true) | 作者要发帖时发一篇社区帖（攻略、晒战绩、开发日志、闲聊），任何时候、任何数量；先给作者看完整标题、正文和图片，同意后再发；图片是项目内相对路径 |
| get_game_updates(gameSlug, cursor?) | 查询自己游戏的公开版本记录，返回实际 reference、版本、标题、说明、日期和 nextCursor |
| get_game_posts(gameSlug) | 读作者自己关于这个游戏的帖子（首发帖、更新帖、网站上发的），给出 postId、标题、正文和链接 |
| edit_game_post(gameSlug, postId, title, body, images?, project_directory?, approved:true) | 改一篇已发出的帖子的标题、正文和图片；先给作者看完整新内容，认可后保存；不传 images 时图片不变，评论、点赞保留 |
| edit_game_update(gameSlug, reference, title, notes, approved:true) | 改游戏页「版本更新」里一条记录的标题和说明（版本号不变）；先给作者看完整新内容，认可后保存 |
| delete_game_update(gameSlug, reference, approved:true) | 从游戏页隐藏作者指定的版本（同一版本号的几次部署一起）及关联更新帖，作者可在「管理版本」重新打开；保留构建、在线版本和回退能力，重复操作幂等 |
| get_game_integrations(gameSlug, feature?, boardId?) | 读取自己游戏的云存档/榜单配置，可获取带真实 ID 与玩家平台 origin 的专属接入说明 |
| configure_cloud_saves(gameSlug, enabled, schemaVersion) | 作者选择后设置云存档，返回专属说明；不读取玩家存档、不修改游戏代码 |
| configure_leaderboard(gameSlug, configuration) | 创建或更新榜单；创建使用稳定 key 幂等重试，更新保留既有成绩与计分规则 |
| wait_for_publish(build_id?, wait_seconds?) | 等待或恢复当前账号同一个发布任务，最多 45 秒，不自动重新发布 |
| prepare_release(project_directory, gameSlug?, docker_project?) | 对比上次成功发布并获取版本建议，不构建或发布 |
| build_vercel_game(project_directory, frontend_output_directory?, build_script?) | 在本地将 Vite/npm 静态前端和 API 打包成完整 Vercel 产物，无需云登录，不上传或部署 |
| inspect_game(project_directory, deployment_target?, vercel_output_directory?, output_directory?, build_script?) | 只读检测当前绝对路径，返回支持情况及构建方式（vercel-output / web-static / godot-web） |
| connect_platform() | 建立当前客户端连接，返回用户授权网址 |
| publish_game(project_directory, title?, description?, deployment_target?, vercel_output_directory?, output_directory?, build_script?, gameSlug?) | 检测后发布；可指定原游戏标识，在转移所有权或移动文件夹后继续更新同一游戏 |
| publish_link(url, project_directory, title?, description?) | 把已部署的可玩 HTTPS 网址发布为 AIWANNA 游戏页，不构建；同一网址再次提交会更新同一作品 |
| get_publish_status(build_id) | 查询当前账号自己的构建和试玩网址 |
| find_my_game(project_directory, gameSlug?) | 按当前项目找到你自己的游戏；给了编号就核对它是不是这个项目的 |
| validate_game_text(project_directory, original, translations, separators?) | 上传前检查译文：键名、占位符、换行、分隔符、长度和字体 |
| set_game_covers(project_directory, gameSlug, base?, special?, modes?, position?) | 各语言封面：底图、专用封面、每种语言的选择和游戏名位置 |
| set_game_media(project_directory, gameSlug, cover?, screenshots?, preview?, fillMissing?, replaceCover?, replacePreview?) | 上传已准备好的主封面、实机截图和预览；只补缺主封面/预览，截图追加并按内容去重，保留现有物料；作者明确要求换主封面时传 `replaceCover:true` |
| edit_game_media(gameSlug, removeScreenshots?, screenshotOrder?, removePreview?) | 作者明确要求时删除截图、调整截图顺序、撤下预览；截图 id 来自 get_game_materials。换截图 = set_game_media 传新图 + 这里删旧图并排序。 |
| record_game_video(project_directory, director, root?, page?, size?, out?, arg?) | 用本机 Chrome/Edge 逐帧录宣传视频（≤5 MB，带声音）和截图（REC.shot），存进项目；拍什么由你的导演脚本决定。 |
| update_github_game(project_directory, gameSlug, release) | 更新从 GitHub 发布的游戏：确认这是游戏的仓库、改动已提交并推送到发布分支，再让平台从最新提交重新构建；不会替你推送 |
| check_game_languages(project_directory) | 只读检查游戏有没有做多语言（语言文件、`?lang=`、浏览器语言、AIWANNA SDK），返回检测到的语言、下一步和接入约定 |
| upload_game_text(project_directory, gameSlug, original?, translations?, use?) | 上传游戏自己的原始语言文件和你的 AI 翻好的各语言文件（`{"键名": "文字"}`），平台在 `/i18n/<游戏>/<语言>.json` 提供给玩家 |
| get_game_text_status(gameSlug, use?) | 每种语言：已翻译、缺哪些键、哪些键的原文改过要重翻 |
| get_game_text_source(gameSlug, use?) | 只读自动来源配置、来源指纹、待审候选与翻译状态；prepare_game.textSources 已含两种模式 |
| configure_game_text_source(gameSlug, enabled, locale, files, use?, excluded?, scan?) | 以当前 revision 保存设置，启用时默认扫描一次；不构建、不发布 |
| approve_game_text_candidates(gameSlug, keys, expectedRevision, expectedFingerprint) | 仅批准逐项审查的短语候选，绑定 config.revision 和 source_fingerprint |
| set_game_details(gameSlug, titles?, descriptions?, languages?, genre?, tags?, fillMissing?) | 游戏名、简介和支持的语言；fillMissing:true 还可补缺分类和作者主语言标签；不带 fillMissing 时，作者要求的 genre/tags 直接替换，保留已有内容 |

v0.9.0 还提供 `get_publisher_info`（实际运行版本和能力）、`get_game_materials`（页面物料与封面预览）。`set_game_details` 与 `set_game_covers` 的 `fillMissing:true` 用于只补缺失文案或未设置的封面模式，保留已有内容和作者选择。

### 自动同步游戏文字

已接入游戏可以登记公开原文来源。平台按当前游戏入口读取，不改变原发布渠道：

- `keys`：选一份公开 JSON 原文，例如 `locales/zh.json`，适合全自动更新。
- `phrases`：选最多 16 份 HTML/JS/MJS/PCK 文件，例如 `index.html`、`assets/game.js`。明确显示文本可自动登记，其余进入 `pending_entries`，逐项确认后调用批准工具。日志、内部标识和玩家输入不能当作游戏文案批准。

`configure_game_text_source` 先读取配置，再以该 revision 保存，遇到并发修改不覆盖。`scan` 默认为 true，启用设置后只请求一次有限扫描；false 只保存，关闭时也不扫描。已有设置通过 `prepare_game.textSources` 复用，不重复询问；旧服务器不支持或读取失败会标为不可用，不能当作关闭。来源文件相对当前公开游戏入口，不是本地源码路径，也不能填任意外部 URL。

后台每五分钟检查已启用来源，更新后沿用既有补翻队列，保留作者逐条校对。配置、扫描和翻译状态分开看：`engine: null` 表示平台翻译服务未启用，需要宿主 AI 补齐目标语言并上传；扫描失败不能宣称同步完成。批准候选必须使用同一份 `config.revision` 和 `config.source_fingerprint`，快照改变须重新审查，不能自动批准新内容。

`upload_game_text` 与 `get_game_text_status` 的 `use` 默认 keys，可传 phrases；两套词表相互隔离。短语原文键是 `p.<去除首尾空白后原文的完整 SHA-256>`，原文本身不得带首尾空白。上传前会验证编号，force 不能跳过。AI 译文上传须包含完整文件，不能仅上传新增片段；此前作者标记校对的条目仍被保留。

首次仍需在游戏里接入 SDK 或显示桥；Godot 新自绘、换行、字体和缓存路径仍须复核。`integration.state: not_verified` 明确表示显示尚未验证。图片文字、语音和未知引擎渲染不保证覆盖。配置保存不等于游戏已翻译，不触发发布；`wait_for_publish` 继续只查询构建状态。

### 常规上架物料

`prepare_game.promotion` 分别列出分类、标签、制作信息、主封面、截图和预览，不受多语言选项影响；首发需要除预览外的全部（`required`，截图至少 3 张）。先复用作者已有物料及项目根目录 `1gp-kit/game.json` 的安全候选；读取失败标为未知，不当作空内容覆盖。候选文件或已上传链接不等于质量已验证，AI 仍需查看图片、播放预览。分类按真实代码和试玩判断，从 casual、puzzle、action、strategy、simulation、adventure、idle、rhythm 中选一个；标签使用作者主语言，最多 5 个、每个最多 12 字，不能重复分类或虚构功能。

MCP **负责检查、上传和保存，不生成图片**；截图和宣传视频可用 `record_game_video` 录。宿主 AI 补齐缺失素材：标题在小尺寸仍清晰的 16:9 主封面、3–5 张不同实机截图（脚本或 `REC.shot` 截，抽看一两张）；预览可选，上线后问作者要不要做，直接出不超过 5 MB 的 MP4。先复用现有素材；只拍游戏里真实会发生的东西，不碰玩家存档，不用生成图片冒充实机。缺工具或作者明确跳过时逐项报告，不把部署成功等同于物料齐全。多语言无字底图和文字叠加另由 `set_game_covers` 处理。

取得真实游戏 ID 后，用 `set_game_details({gameSlug,genre,tags,fillMissing:true})` 和 `set_game_media({project_directory,gameSlug,cover,screenshots,preview,fillMissing:true})` 上传实际准备好的内容。媒体路径相对项目；整批安全读取并验证后才开始写入。图片源文件最多 20 MiB、2500 万像素，MCP 转为不超过 2 MiB 的 WebP；预览支持 GIF/WebP/MP4/WebM，最多 20 MiB，不在服务器转码。截图只追加，重复内容不重复添加；主封面和预览只补缺，已有内容及作者关闭预览的选择保留。修改现有内容仍使用作者编辑页。

媒体失败返回已保存、跳过和失败的逐项结果；结果不明先检查当前物料，再沿用相同内容重试，不盲目换文件重传。上传后查看保存的公开图片并验证视频可播放。`1gp-kit` 不进入游戏运行包；纯元数据或媒体修改无需部署或发布新日志。

需要指定静态输出时返回 `OUTPUT_REQUIRED`，需要完整服务端产物时返回 `VERCEL_OUTPUT_REQUIRED`。错误包含 `LOCAL_BUILD_FAILED`、`UNSUPPORTED_BUILD`、`POTENTIAL_SECRET`、`AUTH_REQUIRED`，`publish_link` 另有 `INVALID_URL`、`TITLE_REQUIRED`；连不上平台时为 `NETWORK_ERROR`。遇到网络不确定的发布结果不要自动重复提交，可到网站「我的发布」查看。

## 授权与限制

本地凭证保存在 `~/.config/1gp-studio/`，目录权限 0700，文件权限 0600。平台仅保存 SHA-256 哈希。凭证不会通过工具结果或浏览器 URL 输出。授权 90 天有效，可发布和管理自己游戏的构建、页面信息、翻译、封面及云存档/排行榜设置，并在作者同意后发社区帖，不能读取玩家存档或代玩家提交成绩；在网站「我的发布」撤销后，再运行 connect_platform 可重新连接。

平台目前限制全站同时 2 个构建、每个账号最多 50 个作品，不设每日次数限制。账号邮箱验证由 Supabase 负责；平台管理员必须配置生产邮件服务，才能支持组织外用户收取登录邮件。AIWANNA 托管团队的 Vercel 套餐及运行限制仍适用；不占用用户个人 Vercel 账号。GitHub 来源继续遵守仓库授权与构建限制。

开发时可使用 `ONEGP_PLATFORM_URL` 指向另一 HTTPS 平台，或本机 HTTP localhost/127.0.0.1；凭证按平台分别保存。测试运行 `npm test`，包括真实 MCP stdio 客户端集成测试。

## v0.16.0：自动更新

- 最后一次手动升级：只把已有配置里的固定版本改成 `#v0.16.0`（其他参数、环境配置和授权凭证不动），然后重启客户端或重新加载 MCP。
- 之后更新自己会来：启动时、约每 10 分钟、每次调用 `get_publisher_info` 时对照平台推荐版本（`/mcp/release.json`），有新版就自动换上，正在进行的调用在旧进程里做完。换完会通知客户端刷新工具（`notifications/tools/list_changed`），Claude Code 在同一个对话里就能用上新工具；换完后的第一条工具结果附一句提示。
- 实际运行版本以 `get_publisher_info` 为准（它会先等更新完成再回答），握手 `serverInfo.version` 是更新前的。它的 `upgrade` 字段：自动更新下是 `{automatic:true, reloadRequired:false}`，旧版是 `{automatic:false, reloadRequired:true}`。
- Codex 等不刷新工具列表的客户端：已有工具会用上新代码，新增的工具要重启或新开对话才出现。
- 关闭自动更新：设置环境变量 `ONEGP_MCP_AUTO_UPDATE=0`。
- 不需要迁移。

## v0.15.0：上传过的物料都能改

作者明确要求时，网页「编辑」能改的物料，MCP 现在也都能改。自动补全仍然只补缺，不动作者已有的内容。
- `set_game_media` 新增 `replacePreview:true`：用作者看过的新预览替换现有预览；作者关掉过预览时，也可以用它重新放上。
- 新增 `edit_game_media({gameSlug, removeScreenshots, screenshotOrder, removePreview})`：删除截图、调整截图顺序（列出的排在前面，其余保持原顺序）、撤下预览。截图 id 从 `get_game_materials` 的 `media.screenshots.items` 读取。换一张截图的做法：先用 `set_game_media` 传新图，再在这里删掉旧图、把新图排到原来的位置。
- `set_game_details` 不带 `fillMissing` 时，`genre` / `tags` 会替换已有的分类和标签（只给其中一个时，另一个保持不变）；带 `fillMissing:true` 时仍然只补缺。
- `get_publisher_info` 新增 `preview-replace`、`media-edit`、`labels-replace` 能力。平台接口早已支持，不需要迁移。
- 新增 `create_game_post`：作者要发帖时随时发社区帖，类型、次数不限；先给作者看完整内容，同意后再发。
- 移除 `get_game_announcement` 和 `publish_game_announcement`；`prepare_game` 不再有 `announcement` 选项，发布前什么都不问。
- `complete_game_update` 只写版本记录（游戏页「版本更新」、关注动态、更新榜），不再发社区帖，也不再接受 `image`；要发帖用 `create_game_post`。
- `edit_game_post` 可以改图片（`images` 列表）。
- 首发除分类、标签、主封面外，还需要制作信息（`maker`：AI 工具、屏幕、一局多久）和至少 3 张真实截图；预览改为上线后问作者要不要做，用 `record_game_video` 录，直接出不超过 5 MB 的 MP4，只拍游戏里真实会发生的东西，不碰玩家存档。`upload_game_text` 新增 `replaceEdited:true`（作者要求时连他在网站上改过的译文也替换），`set_game_media` 新增 `replaceScreenshots:true`（按给定顺序整组替换截图）。
- 新增 `record_game_video({project_directory, director, root?, page?, size?, out?})`：用本机 Chrome 或 Edge 无头打开游戏，运行你写的导演脚本，逐帧录宣传视频（带游戏声音），存成不超过 5 MB 的 MP4（浏览器不支持 H.264 时是 WebM），`REC.shot` 顺手存截图。不用另装 Python 或 ffmpeg。怎么拍由你决定，目标是让玩家一看就想玩，只拍游戏里真实会发生的东西，不动玩家存档。游戏代码在启动主循环那句前加 `/*TRAILER_HOOK*/` 时，导演脚本在游戏自己的作用域里运行；不加时在全局运行，页面的 requestAnimationFrame 和时钟被接管，用 `REC.advance(ms)` 推进。
- 需配套平台迁移 `202610270001_post_edits.sql`、`202610270003_update_without_post.sql` 和对应网站部署（均已上线）。

## v0.14.1：封面可以换，已有封面不被覆盖

- `set_game_media` 新增 `replaceCover:true`：作者明确要求换主封面时，用作者看过的 `cover` 替换现有主封面，和网页「编辑」里替换封面走同一个平台接口；不传时主封面仍然只补缺失，预览和截图规则不变。`get_publisher_info` 新增 `main-cover-replace` 能力；平台接口早已支持，不需要迁移。
- `set_game_covers` 跳过上传时返回 `preserved`，说明保留了哪些已有封面；上传前先压缩图片。
- 平台提示词要求的最低版本改为 0.14.1，安装固定到 `#v0.15.0`。不需要迁移。

## v0.14.0：评论建议完成后自动同步进度

- 新增 `read_comment_proposal({commentId})`：读取当前作者名下这条建议的游戏、进度和 `revision`。返回的 `platformOrigin` 来自当前连接配置，先与任务中的平台及游戏核对。
- 新增 `update_comment_proposal({commentId,status,previewUrl,note,expectedRevision})`：通过后台接口同步进度、独立试玩链接和公开说明，复用现有 `connect_platform` 授权；不会发布游戏或另发评论。`get_publisher_info` 新增 `comment-proposal-progress` 能力。
- 作者把网站生成的任务交给 AI 时，一并授权为这条建议回写实际进度。完成并验证、有可用的独立 HTTPS 试玩版时，写 `testing`（作者邀请试玩）；只有本地修改时使用 `in_progress`（作者开发中），不得降低已有更后面的状态。只有另行获准正式发布、发布成功且验证包含本次修改后，才写 `released`（作者已完成更新）。
- 开始工作前保留读取的 `revision`，回写时作为 `expectedRevision`。作者期间修改或移除进度后，旧任务收到 `PROPOSAL_CONFLICT`，应读取并说明变化，不能自动用新版本号强行覆盖。相同内容重试不重复通知；结果不明时先读回核实。
- `note` 最多 1000 字，对玩家公开，不包含凭证、私有路径或内部日志。工具未安装、账号未连接或回写失败时，继续能完成的工作，并明确报告尚未同步及手动恢复信息。
- 需要先执行平台迁移 `202610260003_comment_proposal_callback.sql` 并部署配套接口 `/api/comments/{commentId}/proposal`，再发布本 MCP 标签。作者升级并重新加载后，可用 `get_publisher_info` 验证实际运行版本和能力；已有发布能力与授权保持兼容。

## v0.13.0：版本记录、帖子和制作信息可以改

- 游戏页「版本更新」跟平台「管理版本」同步：每个版本号一条，默认显示，作者可在「管理版本」逐个版本隐藏或重新显示。`complete_game_update` 收尾时，作者认可的标题和说明写到最终版本上，同组的中间推送自动隐藏。首发部署的版本标题和说明就是游戏页第一条版本记录。
- 新增 `edit_game_update`：改一条版本记录的标题和说明（版本号不变）。
- 新增 `get_game_posts`、`edit_game_post`：读作者自己关于这个游戏的帖子，改已发出帖子的标题和正文；图片、评论、点赞保留。
- `set_game_details` 新增 `maker`：AI 工具、屏幕、一局多久、制作笔记、开源，只改传入的字段；`get_game_materials` 新增 `maker` 返回当前值。开源只按作者明确选择设置。
- `delete_game_update` 改为从游戏页隐藏整个版本（同一版本号的几次部署），作者可在「管理版本」重新显示。
- `get_publisher_info` 新增 `version-record-edit`、`post-edit`、`maker-details` 能力。需配套平台迁移 `202610260002_versions_follow_deployments.sql` 和对应网站部署，均已上线；0.12.1 仍可使用，只是没有这些新工具。

## v0.12.1：发布内容校验与作者文案保护

- GitHub 更新要求本地提交与远端发布分支完全一致，并让平台校验预期提交，避免发布未经检查的新代码。
- 托管 Vercel 构建记录源码指纹，拒绝过期产物、无效标记及构建期间的源码变化。
- 更新已有游戏时，省略标题或简介会保留作者的平台文案；读取失败时停止发布。
- 网页与 MCP 共用可选功能政策和接入说明，保留现有文字来源模式与作者选择。
- 先部署本次配套平台修复，再发布此标签。安装后重新加载 MCP，确认运行版本为 0.12.1 或更新版本。

## v0.12.0：社区帖带图

- `publish_game_announcement` 和 `complete_game_update` 新增可选 `image`：项目内图片的相对路径（JPG、PNG、WebP），转成 WebP（最长边 1600）后与帖子一起发布，作为帖子的第一张图（社区列表封面）。首发宣传带图时需同时传 `project_directory`。
- 图片是公告内容的一部分：和标题、正文一起给作者确认，作者认可的内容包括这张图时才传。没有 `image` 的调用与 0.11.0 相同。
- 同一账号、同一条帖子、同一个文件总是得到同一张已存图片，重试不会多存一份；帖子已发布后，用不同的图片重试按内容冲突处理（`ANNOUNCEMENT_CONFLICT` / `UPDATE_CONFLICT`）。
- `get_publisher_info` 新增 `post-images` 能力。需配套平台接口 `/api/developer/post-images` 和 `202610240002_post_images_from_tools.sql` 迁移；先完成平台迁移、验证与部署，再发布 MCP 标签。
- 默认平台地址改为 https://www.aiwanna.games，授权链接也在主域名，作者用网站上已有的登录即可。之前在 `1gp-game-platform.vercel.app` 上的授权继续有效，不用重新 `connect_platform`；`ONEGP_PLATFORM_URL` 指定的其他平台不受影响。
- 首发只要求分类、标签和主封面；截图和预览可以上线后补。发布前只问要不要顺手发首发社区帖，多语言、云存档、排行榜不再提前追问；`prepare_game` 新增 `optionalFeatures`，发布完成后据此提醒作者还能加哪些功能。`prepare_game` 返回去掉了重复的规则文字。
- 平台从这一版起让每个游戏保持固定地址，玩家本地存档跨版本保留。`inspect_game`、`prepare_game` 和 `publish_game` 新增 `warnings`：游戏用了 service worker（`SERVICE_WORKER`），或给不带内容指纹的文件设了长缓存（`LONG_CACHE`）时提醒作者，这两种情况会让玩家更新后还拿到旧版本；只提醒，不阻止发布、不改游戏。`get_publisher_info` 新增 `update-freshness-warnings` 能力。
- 游戏名优先取首页 `<title>`，`vite-project`、`my-app` 这类模板名不再当游戏名。
- 文字和说明里的平台名统一为 AIWANNA；工具名、`onegp` 配置名和凭证目录不变。

## v0.11.0：公告确认与更新记录管理

- `complete_game_update` 要求 `approved:true`，只有作者认可具体最终标题和说明才公开；游戏部署授权不代替公告认可，未确认保留草稿和更新组。
- 新增 `get_game_updates` 和 `delete_game_update`，可查询、分页并删除作者指定的公开版本公告及关联更新帖，保留技术部署历史、在线版本和回退能力。
- 网站五语提示与 MCP 使用同一份确认规则，并通过 `get_publisher_info` 的 `approved-update-announcements`、`update-history-delete` 能力识别实际支持情况。
- 需配套平台接口和 `202610220013_game_update_approval.sql` 迁移。数据库同时阻止旧版定时任务自动生成更新帖；先完成平台迁移、验证与部署，再发布 MCP 标签。升级后重载客户端并核对实际运行版本。

## v0.10.0：自动文字来源与更新补翻

- 新增 `get_game_text_source`、`configure_game_text_source` 和 `approve_game_text_candidates`。按当前公开游戏入口登记 JSON 原文或 HTML/JS/MJS/PCK 来源，沿用现有发布渠道；设置与候选批准分别绑定 revision 和来源指纹，遇到并发变化不会覆盖或自动重试。
- `prepare_game.textSources` 只读返回 keys / phrases 设置与状态，复用已有配置。配置启用后默认请求一次有限扫描；后台检查新版本并沿用既有补翻队列，保留作者校对。扫描排队、失败或结果被并发更新取代均如实报告，平台没有翻译服务时明确需要宿主 AI 补译。
- `upload_game_text` 和 `get_game_text_status` 新增 `use=phrases`，与 keys 词表隔离。短语原文使用完整 SHA-256 编号；AI 译文仍上传完整文件，原文指纹、占位符、文件安全和作者校对保护继续生效。
- 配置成功不等于游戏显示已接通。首次 SDK / Godot 显示桥、字体、换行和缓存仍需验证，新自绘路径仍需复核；本版本不在等待发布时暗中修改游戏或触发部署。

需要配套平台接口、后台任务和 `202610220007_game_text_sources.sql` 迁移（及已有 v0.9.0 基础迁移）。先完成平台迁移、验证与部署，再发布 MCP v0.10.0 标签；更新用户级配置后重载并核对实际运行版本。

## v0.9.0：版本核对、完整上架物料、可选首发宣传与合并更新

- 每次工作先核对实际运行版本，旧版配置升级后重载并复查。HTTP 401 统一返回 `AUTH_REQUIRED`，权限不足和其他失败不会误报成功或要求反复登录。
- `prepare_game.materials` / `get_game_materials` 展示现有游戏名称、简介、封面与相关翻译状态。选多语言后，AI 对五个目标语言检查游戏文字和页面物料，以作者原始语言为准；`set_game_details(fillMissing=true)` 只补缺文案，保留已有内容。
- 常规发布新增 `prepare_game.promotion` 五项清单和 `set_game_media` 上传能力；分类和标签不再依赖多语言选项，主封面、实机截图与预览由宿主 AI 准备后直接上传，不要求作者回网页逐个导入。填缺和幂等记录在服务端事务内保护，重复上传不增加截图，删除后的同一请求不复活内容。
- 自动封面使用**同一张无字底图加各语言游戏名字**，不是生成不同语言的游戏截图。复用底图，对非原始语言中未设置的模式用 `set_game_covers(fillMissing=true)` 补 `gen`，保留原始语言主封面、已有 main/special 模式和文字位置。实际查看预览；缺底图/名称而回退主封面的情况仍是未完成。标签、制作说明、版本说明由平台翻译；未完成时如实列出。
- 封面先整批验证并读取固定快照，再上传；阻止链接逃逸、硬链接、读取期间文件替换或超限。多步操作固定同一账号，失败会保留已完成项目。
- AI 译文上传带预检原文的语言及哈希，数据库原子检查；原文改变返回 `ORIGINAL_CHANGED`，必须重读并更新译文，不能把旧翻译标成最新。
- 一次逻辑更新沿用一个 `updateId`。`prepare_game` 仅在本地按账号、平台、项目保存 UUID，首次实际发布才幂等注册服务器更新组；所有渠道的发布都传 `release.updateId`，包括首发取得真实游戏 ID 所需的中间部署、可选功能接入和验证修复。尽量把改动一起做完再发布；仅修改平台文字、翻译或封面，无须新部署。
- 同一逻辑更新保留一组部署记录；当前流程还要求作者明确认可最终公告内容，最终部署 ready 且网页、接口与所选功能验证后，才调用一次 `complete_game_update(..., approved:true)`。首发组不发更新帖，私有游戏不向社区发帖。未确认保留草稿和原组；收尾结果不明只重试相同 ID 和已认可内容，不重发游戏；同内容完成重试幂等，已删帖子不复活。成功后清除本地活动组。已注册而未完成的旧组必须显式 `update_id` 恢复；确认是独立新任务才 `new_update=true`，不能把下一次更新悄悄混进旧组。
- `features.announcement` 只记录首发社区宣传意向。`get_game_announcement` 提供资格、`launchReference` 和草稿；AI 与其他发布物料一起展示标题和正文，只有作者明确批准相同内容后才提交 `approved:true`。最终发布 ready 且网页检查通过后，`publish_game_announcement` 发出帖子。重试沿用同一引用并返回原帖，删帖后不自动重发，更新版本不自动发首发宣传帖；发帖失败也不重新发布游戏。

此版本需要配套平台接口和数据库迁移：按序执行 202610220001_mcp_translation_snapshot.sql、202610220002_game_announcements.sql、202610220003_materials_snapshot.sql、202610220004_game_language_owner_writes.sql、202610220005_game_update_sessions.sql、202610220006_publishing_materials.sql（需已有语言文件、短语翻译与社区基础迁移）。它们提供原文指纹检查、首发去重标记、自动物料并发保护、写入时所有权校验、按逻辑更新合并开发日志和媒体上传幂等回执；游戏转交后旧作者的在途写入也会被拒绝。先完成平台验证与部署，再发布 MCP tag；本地版本号更新不代表公开版本已发布。

## v0.8.0：统一准备与按需接入

- `prepare_game` 合并原先找游戏、准备版本、检查构建、检查语言和查询可选功能的准备步骤。`features` 可记录作者对 `multilingual`、`cloudSaves`、`leaderboards` 的明确选择，按平台、账号和本地项目隔离；未选择为 null，不等于同意，false 也不会关闭已有功能。现有单项工具保留兼容。
- 云存档和排行榜独立可选。`get_game_integrations` 查询当前配置；选择后用 `configure_cloud_saves` 或 `configure_leaderboard` 配置并取得真实游戏/榜单 ID 与接入说明。没有游戏 ID 时须先发布，接入请求保持关闭。
- 榜单创建要求稳定 key；相同配置重试复用原榜单，不同配置返回冲突。更新只能修改名称、说明和启用状态，不重建榜单或清空成绩。云存档格式版本默认沿用，升级需要游戏实现迁移。
- 配置只解决平台设置，AI 仍需修改游戏、运行测试并在平台播放器验证。播放器的精确父窗口 origin 使用返回的 `platformOrigin`，不能使用 MCP 连接地址代替。作者发布凭证不能放进游戏，也不能作为玩家会话凭证。
- `upload_game_text` 在首笔写入前校验整个批次，按已验证快照上传。仅上传译文时读取平台原文，缺少原文返回 `ORIGINAL_REQUIRED`；不会绕过占位符、换行、键名和排版检查。原文或各译文旁可提供 `.limits.json`。`force` 只允许绕过文字一致性/排版问题，不能绕过格式、大小或路径安全限制。返回最终状态，无须再固定调用一次状态查询。
- `wait_for_publish` 自动等待并记录任务，中断或断网后恢复同一 ID；不自动重发。任务和功能选择只保存在本机用户配置目录，不含原始 token。已有授权直接沿用，安装说明只在首次安装或升级时使用。

升级安装配置到 `v0.8.0` 并重启 MCP 客户端。平台作者接口需同时支持此版本；旧服务器返回错误时先升级平台，不能据此把已有功能当作关闭。

## v0.7.4：自己找游戏、译文检查、各语言封面

- `find_my_game`：按当前项目的 GitHub 仓库、试玩网址（GitHub Pages、homepage、CNAME）或本地上传，找到你自己的游戏，不用填编号；多个就列出来选，给的编号和项目对不上会拒绝。`prepare_release` 也先做这一步。
- 外部链接的游戏：只上传语言文件、游戏名、简介时上传完就生效，不用发新版本；改了游戏代码才需要更新自己的托管。
- `validate_game_text`：检查键名、占位符、换行、分隔符、长度（`<原始语言文件>.limits.json`，中日韩字算 2）和字体能不能显示各语言的字；`upload_game_text` 上传前自动检查，有错误先列出来。
- 语言文件里的 `meta.title` 会补上平台还没有的各语言游戏名；和已有的不一样时只提醒。
- `set_game_covers`：上传底图和各语言专用封面，设置每种语言用主封面 / 生成 / 专用封面和游戏名位置，和编辑页同一套。
- 通用提示词只写通用步骤，项目结构以检查结果和项目自己的说明为准。

安装方式不变，把版本号改成 `v0.7.4` 后重启 MCP 客户端。

## v0.7.4：默认跟随网站的五种语言

默认推荐目标依次为简体中文、英文、日文、韩文、西班牙文（`zh`、`en`、`ja`、`ko`、`es`）。游戏内文字、游戏名和简介都按这五种目标按需补齐，只翻缺失或过期的内容，跳过原始语言。原始语言不在这五种中时保留原文，并补齐五种目标，不固定要求“另外四种”。

已有繁体中文、巴西葡语、德语、法语和俄语仍可检测、上传、读取状态和更新资料，不会删除或要求重新翻译。`check_game_languages` 的 `siteLanguages` 返回五个默认目标，`supportedGameLanguages` 返回兼容的十种游戏语言；上传工具和 `set_game_details` 接受全部十种语言，名称及简介可只提交需要更新的语言。

更新安装配置到 `v0.7.4` 后重启 MCP 客户端。游戏已经有的多语言实现和用户的原始语言保持不变。

## v0.7.2：更新游戏时自动走对的路

`prepare_release` 先说明这个游戏是怎么发布的（`channel`：github / local / external / docker / new）和下一步（`nextSteps`），更新时不用再按渠道选提示词：

- GitHub：不改成本地上传；确认改动已提交、推送（推送前先问用户），再用新工具 `update_github_game` 让平台从最新提交重新构建，不用回开发者中心点「发新版本」。
- 本地上传：`inspect_game` →（需要时 `build_vercel_game`）→ `publish_game`。
- 外部链接：先在自己的托管处更新，再用 `publish_link` 更新游戏信息；语言文件照样能上传。
- Docker：沿用原来的 Docker 流程。

提示词 `update_game` 是这套通用的更新流程。安装方式不变，把版本号改成 `v0.7.2` 后重启 MCP 客户端。

## v0.7.1

`set_game_details` 新增 `descriptions`：各语言的游戏简介，先给用户看再上传；上传的算作者自己的，平台翻译不会覆盖，留空就交回平台翻译。安装方式不变，把版本号改成 `v0.7.1` 后重启 MCP 客户端即可。

## v0.7.0：游戏内文字多语言

让游戏里的文字跟着玩家在 AIWANNA 网站选的语言走：

1. 发布前 `check_game_languages`。已有多语言：确认打开时先读 `?lang=`；还没有：先问用户要不要做成多语言，同意才改。
2. 按约定改造（提示词 `make_game_multilingual`）：玩家看到的文字换成键名，写一份原始语言 JSON，接入 SDK 的 `AIWanna.i18n`，中日韩准备字体并保留已有其他语言字体，按钮给长文字留余量。
3. 用你自己的 AI 按当前网站目标 `zh`、`en`、`ja`、`ko`、`es` 补齐缺失或过期的翻译，跳过原始语言；原文不在目标列表中时保留原文并补齐全部五个目标。键名一致、占位符原样保留，已有其他语言继续保留。
4. 发布后 `upload_game_text` 上传改过的原始语言文件和本次补齐的翻译，`get_game_text_status` 核对，`set_game_details` 按需补齐五个目标语言的游戏名和简介（先给用户看）。

作者在 AIWANNA 开发者中心手改过的条目不会被上传覆盖；原文改了，旧翻译会标成需要重翻，只重翻改过的条目。平台开通翻译时，缺的条目也会由平台补上。

## v0.6.2

修复跨模块依赖读取运行资源时的漏检，完整依赖图中使用文件系统或运行时加载的函数会明确停止，静态 JSON 导入和受支持的 ws 回退保持可用。构建脚本预检支持正常引号、参数和嵌套生命周期，无法可靠检查的动态 shell 会拒绝；握手版本直接读取包版本。

平台授权和发布协议不变。更新安装配置到 `v0.6.2` 后重启 MCP 客户端即可使用。

## v0.6.1

只改客户端，平台无需改动。构建检查补强：构建脚本里嵌套调用的脚本（含 `npm --silent run x`、pnpm/yarn、npm test/start）连同它们的 pre/post 钩子一起检查，藏在里面的 Vercel 发布命令会被拦下；API 函数如果在运行时读取文件（项目代码使用文件系统或用 `__dirname`/`process.cwd()` 拼路径，或依赖包读取自己旁边的文件），构建会直接报错并提示改成 import 引入，不再显示成功后上线才出错。

## v0.6.0 发布顺序

先部署支持 `vercel-output`、文件分批上传与回执校验的平台，再发布 MCP `v0.6.0` tag，最后更新客户端配置并重启。旧静态、Godot、Docker、`release` 和 `gameSlug` 协议继续兼容。平台与 tag 发布前使用本地源码验证；修改版本号本身不代表远程版本已经发布。

## v0.4.0

打包时跳过项目顶层的 `1gp-kit/` 文件夹。这个文件夹是 1gp-store-kit Skill 生成的上架物料（封面、截图、预览视频），在网站上导入，不属于游戏本身；旧版本会把它一起上传，预览视频会超出 3 MB 上限。只改客户端，平台无需改动。

## v0.3.1 发布顺序

先同步游戏所有权管理所需的数据库迁移并部署支持 `gameSlug` 的平台，再发布 MCP 的 v0.3.1 tag。客户端需更新安装配置中的版本并重启，才能使用新参数。旧 v0.3.0 保留按文件夹发布的行为；转移或移动后的游戏应升级后再指定 `gameSlug` 更新。

## v0.3.0 发布顺序

先部署支持 `web-static` 的平台，再发布 MCP 的 v0.3.0 tag，最后更新客户端配置并重启。旧 v0.2.0 仍上传 Vite 源码；升级 MCP 才能使用本地构建。平台保留旧协议以兼容已有客户端。平台与 tag 发布前，请使用本地源码和测试平台验证。


## Docker 游戏：全程在本地 AI 工具里发布

需要 Node.js 24+、Docker（含 Buildx），Windows 的 Docker Desktop 需使用 Linux containers。
只需要已有的 **AIWANNA 平台授权**；无需 AWS 账号、AWS SSO、Access Key 或 ECR 登录。
当前沿用团队管理员账号、单台主机一个游戏的实验范围。

可以直接告诉 AI：

> 用 AIWANNA MCP 把当前游戏发布到 EC2 Docker 托管。检查代码并准备 Dockerfile 和 .dockerignore，在本地构建 Linux/amd64 镜像，上传给平台，等校验通过后发布，把可玩的链接给我。使用稳定的项目标识 my-game，更新时不要改变它。不要申请 AWS 凭证，也不要直接推送 ECR。

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


## 按发布偏好使用 MCP 提示词

网页先区分“让 AI 帮我发布”和“自己选择发布方式”。MCP 同时提供：

- `choose_publish_path`：检查实际运行需求并推荐渠道，优先本地构建和 API 上传必要产物。
- `publish_local_artifacts`：固定本地 API 上传；已有产物先验证复用，没有则补齐构建，不要求网页手动上传。
- `prepare_github_publish`：传入 `repo`，可选 `kind`、`ref`、`check_result`，根据检查结果准备指定仓库。保持 GitHub 渠道，不静默改为本地上传或 Docker；完成后回原表单重新检查。
- `prepare_docker_publish`：固定 AIWANNA 团队运营的 Docker/EC2，检查权限和运行限制，通过现有镜像上传及发布工具完成。
- `update_game`：更新已发布的游戏（传入 `gameSlug`），按 `prepare_game` 返回的发布方式走，不用按渠道选提示词。
- `add_cloud_saves`：按作者选择复用或开启云存档，读取真实配置，指导接入并验证存档/恢复逻辑；不会顺带开启排行榜。原生 REST 按返回文档向所有官方域名尝试握手，核验父窗口、官方 origin 与 source/type/requestId，成功回复还需核验 `session.gameId` 和 `apiOrigin === event.origin`，之后使用实际回复的 origin；`platformOrigin` 不是唯一可用父页面域名，SDK 会识别实际父页面。
- `add_leaderboard`：按作者选择复用或创建榜单，明确计分规则，指导接入真实开局/结算流程；不会顺带开启云存档。
- `make_game_multilingual`：沿用 `prepare_game.textSources` 的 keys/phrases 模式和已有选择；按项目实现接 SDK 或已审查的显示桥，不强制改写成键名。需要时登记公开原文来源，逐项审查候选并绑定 revision 与来源指纹，再用自己的 AI 补齐五个默认目标语言的完整词表，保留已有其他语言。

所有新增托管使用 AIWANNA 的 Vercel/AWS 资源，不要求发布者的云账号或密钥。现成链接保持原站托管。手动选择渠道后，不兼容时解释原因并建议切换，不能自行更换。只做必要部署适配，不擅自重写玩法、协议或存储；部署 ready 不代表多人玩法已验证。
