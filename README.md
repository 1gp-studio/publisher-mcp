# 1GP Publisher MCP

在 Codex、Claude Code 等支持 MCP 的客户端里检查并发布当前游戏到 https://1gp-game-platform.vercel.app 。每个用户使用自己的平台账号，一次浏览器授权后即可发布。网页与受支持的服务端函数均由 1GP 统一托管，不需要用户登录 Vercel、提供 Vercel/Supabase Token、选择个人团队或新建个人云项目。

## 安装

需要 Node.js 24+、npm（首次从 GitHub 安装 MCP 时需要 Git）。游戏本身不需要 Git 仓库。这是标准的 stdio MCP 服务，任何 MCP 客户端都能使用。

**只装一次，装在用户级。** 一份安装对你所有的游戏项目都有效，不要在每个游戏项目里各装一份，也不要在游戏目录里新建 `.mcp.json`。已经装过的，只把配置里的版本号改成新版本即可。

如果某个游戏项目的 `.mcp.json` 里还有以前装的 `onegp`（项目级的会盖过用户级，版本停在旧的），请把那一项删掉，以免两个版本打架。

### Codex

在 Codex 的 `~/.codex/config.toml` 中添加（已有 `[mcp_servers.onegp]` 就只改版本号）：

```toml
[mcp_servers.onegp]
command = "npx"
args = ["--yes", "github:1gp-studio/publisher-mcp#v0.7.4"]
startup_timeout_sec = 60
tool_timeout_sec = 600
```

保存并重新打开 Codex 任务。首次运行 npx 会下载本项目及依赖，需要网络访问。

配置字段依据 [Codex 官方配置文档](https://learn.chatgpt.com/docs/config-file/config-reference)。

### Claude Code

在终端运行一次（`--scope user` 对你本人的所有项目生效）：

```sh
claude mcp add onegp --scope user -- npx --yes github:1gp-studio/publisher-mcp#v0.7.4
```

已经装过要升级时，先 `claude mcp remove onegp --scope user`，再运行上面这行。用 `claude mcp list` 可以看到当前装的是哪一份。

重新打开 Claude Code。首次 npx 下载较慢，可用 `MCP_TIMEOUT=60000 claude` 启动以放宽启动超时。

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

## 完整游戏 Vercel 发布（v0.6.0）

Vercel 发布同时包含网页和必要的服务端产物，只需 `connect_platform` 的 1GP 授权。**不要登录用户的 Vercel、读取其团队凭证、新建个人云项目或单独部署后端。** 1GP 使用平台自己的账号上传、部署和管理游戏前后端。

普通 **Vite + `api/*.js` / `api/*.ts` 游戏，无需预先准备 Vercel 产物**：先调用本地构建工具：

```json
{"project_directory":"/absolute/game"}
```

上述参数用于 `build_vercel_game`。工具执行项目已有 `build` 脚本，用 esbuild 将固定路径（含嵌套路径）的 API 和依赖打包，兼容 Node `req/res` 函数或默认导出的 `http.Server`。保留 `vercel.json` 中受支持的同源 `rewrites`、函数 `maxDuration`/`memory`；支持 `/api/:path*` → `/api/index?__path=/api/:path*` 和 `/healthz` 等规则，原查询参数继续保留。不会执行 API 入口、读取或内联 `process.env` 的值，也不改游戏玩法与存储。`ws` 的可选原生加速模块使用其官方 JavaScript 回退，避免将本机二进制带入 Linux 函数。

构建和完整校验成功后才写入工具管理的 `.1gp/vercel-output`，不会覆盖同名的未受管理目录；失败保留上次成功产物并清理临时目录。检查和发布可以自动识别该目录，也可明确使用工具返回的 `deployment_target` 和 `vercel_output_directory`。这一步不连接云端、不上传、不发布。之后调用 `prepare_release` 并提供版本说明，再 `publish_game`。

其他 npm 静态前端可给 `build_vercel_game` 传 `frontend_output_directory` 和可选的 `build_script`；仅给目录则使用已有前端产物。Next/其他 SSR、动态 API 文件名（如 `[id].ts`）、原生依赖、依赖 `import.meta.url` 的入口或其他不受支持配置会明确停止，需要专用框架适配器或 1GP Docker。

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

每个函数必须自包含，不支持引用输出外源码的非空 `filePathMap`。产物内指向同一输出目录的符号链接会安全展开，外部链接和循环链接拒绝。当前不支持 Edge、ISR/prerender、images、wildcard、crons、services/daemons 或动态 middleware；检测到会明确报错，不删除必要配置后继续发布。函数支持 Linux x86_64、最多 2048 MiB 内存、300 秒执行时间和单区域。需要常驻进程、WebSocket、进程内多人房间或其他运行能力时使用下方 **1GP Docker 托管**，不要为了部署自动改写玩法、存储方式或删除后端。

检查只读取项目，不运行构建。发现 API、server 或 SSR 而没有完整产物时返回 `VERCEL_OUTPUT_REQUIRED`；普通 Vite/API 项目调用 `build_vercel_game`，其他项目使用无需 Vercel 登录的专用框架适配器。仅执行 `next build` 不代表已生成此格式；不要上传 `.next` 目录或把后端塞进静态目录。工具本身不调用 Vercel CLI、创建云项目或修改游戏；其他包管理器可先在本地构建，再上传已有产物。发布时如指定完整产物构建脚本，必须生成新的 `config.json`，否则停止；明确上传已有产物时省略 `build_script`。

构建脚本预检支持静态命令、正常引号、受支持参数以及同一 `package.json` 中 npm/pnpm/yarn 子脚本和生命周期钩子。动态展开、无法解析的 shell 结构、切换其他项目及未知包管理器调用会被拒绝；这类项目可先自行构建再上传产物。此预检不是任意脚本的安全沙箱，无法证明 `node build.js` 等程序内部会执行什么，只应运行已经审阅并获准执行的项目构建脚本。

完整产物上限 **64 MiB、10000 个文件，单文件 16 MiB，配置 JSON 100 KiB**。工具先校验完整包，再分批上传（每批最多 200 文件、4 MiB JSON）；大文件压缩后仍无法放入一批时须缩小或拆分资源。平台返回 30 分钟有效、绑定当前账号和文件内容的回执，最终发布发送文件引用与必要配置；发布清单及版本说明合计最多 4300 KiB，超限在上传前停止。失败或响应不确定时不会自动重试。平台无需安装游戏依赖或执行云端构建。

source map 不上传；检测到凭据、私钥、`.env` 等文件会拒绝。浏览器资源对玩家公开，服务端产物提交给 1GP 并在服务端运行，不作为静态网页资源公开。不要把秘密写入产物；函数配置仅接受官方默认的空 `environment: {}`，不接受任何环境变量值、`env` 或 `envVarsInUse`。

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

| 工具 | 用途 |
| --- | --- |
| prepare_release(project_directory, gameSlug?, docker_project?) | 对比上次成功发布并获取版本建议，不构建或发布 |
| build_vercel_game(project_directory, frontend_output_directory?, build_script?) | 在本地将 Vite/npm 静态前端和 API 打包成完整 Vercel 产物，无需云登录，不上传或部署 |
| inspect_game(project_directory, deployment_target?, vercel_output_directory?, output_directory?, build_script?) | 只读检测当前绝对路径，返回支持情况及构建方式（vercel-output / web-static / godot-web） |
| connect_platform() | 建立当前客户端连接，返回用户授权网址 |
| publish_game(project_directory, title?, description?, deployment_target?, vercel_output_directory?, output_directory?, build_script?, gameSlug?) | 检测后发布；可指定原游戏标识，在转移所有权或移动文件夹后继续更新同一游戏 |
| publish_link(url, project_directory?, title?, description?) | 把已部署的可玩 HTTPS 网址发布为 1GP 游戏页，不构建；同一网址再次提交会更新同一作品 |
| get_publish_status(build_id) | 查询当前账号自己的构建和试玩网址 |
| find_my_game(project_directory, gameSlug?) | 按当前项目找到你自己的游戏；给了编号就核对它是不是这个项目的 |
| validate_game_text(project_directory, original, translations, separators?) | 上传前检查译文：键名、占位符、换行、分隔符、长度和字体 |
| set_game_covers(project_directory, gameSlug, base?, special?, modes?, position?) | 各语言封面：底图、专用封面、每种语言的选择和游戏名位置 |
| update_github_game(project_directory, gameSlug, release?) | 更新从 GitHub 发布的游戏：确认这是游戏的仓库、改动已提交并推送到发布分支，再让平台从最新提交重新构建；不会替你推送 |
| check_game_languages(project_directory) | 只读检查游戏有没有做多语言（语言文件、`?lang=`、浏览器语言、1GP SDK），返回检测到的语言、下一步和接入约定 |
| upload_game_text(project_directory, gameSlug, original?, translations?) | 上传游戏自己的原始语言文件和你的 AI 翻好的各语言文件（`{"键名": "文字"}`），平台在 `/i18n/<游戏>/<语言>.json` 提供给玩家 |
| get_game_text_status(gameSlug) | 每种语言：已翻译、缺哪些键、哪些键的原文改过要重翻 |
| set_game_details(gameSlug, titles?, descriptions?, languages?) | 设置各语言游戏名和简介（作者自己的，平台不覆盖；留空交回平台翻译）；没用平台语言文件、自带多语言的游戏也可告知支持哪些语言 |

需要指定静态输出时返回 `OUTPUT_REQUIRED`，需要完整服务端产物时返回 `VERCEL_OUTPUT_REQUIRED`。错误包含 `LOCAL_BUILD_FAILED`、`UNSUPPORTED_BUILD`、`POTENTIAL_SECRET`、`AUTH_REQUIRED`，`publish_link` 另有 `INVALID_URL`、`TITLE_REQUIRED`；连不上平台时为 `NETWORK_ERROR`。遇到网络不确定的发布结果不要自动重复提交，可到网站「我的发布」查看。

## 授权与限制

本地凭证保存在 `~/.config/1gp-studio/`，目录权限 0700，文件权限 0600。平台仅保存 SHA-256 哈希。凭证不会通过工具结果或浏览器 URL 输出。授权 90 天有效，仅允许发布和查询自己的构建；在网站「我的发布」撤销后，再运行 connect_platform 可重新连接。

平台目前限制全站同时 2 个构建、每个账号最多 50 个作品，不设每日次数限制。账号邮箱验证由 Supabase 负责；平台管理员必须配置生产邮件服务，才能支持组织外用户收取登录邮件。1GP 托管团队的 Vercel 套餐及运行限制仍适用；不占用用户个人 Vercel 账号。GitHub 来源继续遵守仓库授权与构建限制。

开发时可使用 `ONEGP_PLATFORM_URL` 指向另一 HTTPS 平台，或本机 HTTP localhost/127.0.0.1；凭证按平台分别保存。测试运行 `npm test`，包括真实 MCP stdio 客户端集成测试。

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

让游戏里的文字跟着玩家在 1GP 网站选的语言走：

1. 发布前 `check_game_languages`。已有多语言：确认打开时先读 `?lang=`；还没有：先问用户要不要做成多语言，同意才改。
2. 按约定改造（提示词 `make_game_multilingual`）：玩家看到的文字换成键名，写一份原始语言 JSON，接入 SDK 的 `AIMadeGames.i18n`，中日韩准备字体并保留已有其他语言字体，按钮给长文字留余量。
3. 用你自己的 AI 按当前网站目标 `zh`、`en`、`ja`、`ko`、`es` 补齐缺失或过期的翻译，跳过原始语言；原文不在目标列表中时保留原文并补齐全部五个目标。键名一致、占位符原样保留，已有其他语言继续保留。
4. 发布后 `upload_game_text` 上传改过的原始语言文件和本次补齐的翻译，`get_game_text_status` 核对，`set_game_details` 按需补齐五个目标语言的游戏名和简介（先给用户看）。

作者在 1GP 开发者中心手改过的条目不会被上传覆盖；原文改了，旧翻译会标成需要重翻，只重翻改过的条目。平台开通翻译时，缺的条目也会由平台补上。

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


## 按发布偏好使用 MCP 提示词

网页先区分“让 AI 帮我发布”和“自己选择发布方式”。MCP 同时提供：

- `choose_publish_path`：检查实际运行需求并推荐渠道，优先本地构建和 API 上传必要产物。
- `publish_local_artifacts`：固定本地 API 上传；已有产物先验证复用，没有则补齐构建，不要求网页手动上传。
- `prepare_github_publish`：传入 `repo`，可选 `kind`、`ref`、`check_result`，根据检查结果准备指定仓库。保持 GitHub 渠道，不静默改为本地上传或 Docker；完成后回原表单重新检查。
- `prepare_docker_publish`：固定 1GP 团队运营的 Docker/EC2，检查权限和运行限制，通过现有镜像上传及发布工具完成。
- `update_game`：更新已发布的游戏（传入 `gameSlug`），按 `prepare_release` 返回的发布方式走，不用按渠道选提示词。
- `make_game_multilingual`：把游戏里的文字做成多语言（键名 + 原始语言文件 + SDK），用你自己的 AI 按需补齐五个默认目标语言后上传，保留已有其他语言。

所有新增托管使用 1GP 的 Vercel/AWS 资源，不要求发布者的云账号或密钥。现成链接保持原站托管。手动选择渠道后，不兼容时解释原因并建议切换，不能自行更换。只做必要部署适配，不擅自重写玩法、协议或存储；部署 ready 不代表多人玩法已验证。
