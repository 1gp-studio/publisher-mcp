# 1GP Publisher MCP

在 Codex、Claude Code 等支持 MCP 的客户端里检查并发布当前游戏到 https://1gp-game-platform.vercel.app 。每个用户使用自己的平台账号，一次浏览器授权后即可发布。无需平台管理员的 Vercel 或 Supabase Token。

## 安装

需要 Node.js 24+、npm（首次从 GitHub 安装 MCP 时需要 Git）。游戏本身不需要 Git 仓库。这是标准的 stdio MCP 服务，任何 MCP 客户端都能使用。

### Codex

在 Codex 的 `~/.codex/config.toml` 中添加：

```toml
[mcp_servers.onegp]
command = "npx"
args = ["--yes", "github:1gp-studio/publisher-mcp#v0.2.0"]
startup_timeout_sec = 60
tool_timeout_sec = 180
```

保存并重新打开 Codex 任务。首次运行 npx 会下载本项目及依赖，需要网络访问。

配置字段依据 [Codex 官方配置文档](https://learn.chatgpt.com/docs/config-file/config-reference)。

### Claude Code

在终端运行（`--scope project` 会写入当前游戏目录的 `.mcp.json`，只对这个项目生效；去掉则只对你本人生效）：

```sh
claude mcp add onegp --scope project -- npx --yes github:1gp-studio/publisher-mcp#v0.2.0
```

或直接在游戏目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "onegp": { "command": "npx", "args": ["--yes", "github:1gp-studio/publisher-mcp#v0.2.0"] }
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

## 当前支持

- 直接发布当前本地游戏目录，不要求 GitHub、提交或推送。
- Vite + npm，含 package.json、package-lock.json、index.html；或 Godot 网页导出（见下）。
- `npm ci` → `npm run build` → `dist`，纯静态网页游戏。
- Vite / npm：最多 300 个源码文件，总计 2 MB；较大项目可在网页选择 GitHub 发布。
- 不支持 Next.js、后端 API、子模块、符号链接、工作区依赖、自定义 Vercel 配置、GDExtension。
- Godot 网页导出（目前支持 Godot 4.6.1-stable 的单线程 Release 导出）：在 Godot 中添加 Web 导出预设（关闭 Thread Support，Release 导出），导出文件名为 `index.html`、放在项目目录内（如 `build/web/index.html`），导出后直接 `publish_game`。MCP 读取 `export_presets.cfg` 找到导出目录，只上传其中 Godot 写出的 `index.*` 文件、不含引擎 wasm（限 3 MB / 300 文件），引擎由平台按 SHA-1 附加，因此不需要 GitHub 或另找托管；平台暂未登记的 Godot 版本会返回支持列表。超过 3 MB 时可把导出部署到别处，用 `publish_link` 发布网址。MCP 不运行 Godot，导出早于源码时 `inspect_game` 返回 `ready: false`，请先重新导出。名称和介绍读取 `project.godot`。
- 已部署在别处的可玩网址可用 `publish_link` 发布（或在网站用「已有游戏链接」接入），不需要重新构建。
- MCP 不执行本地项目脚本。上传当前源码（包括未提交修改），排除隐藏文件、node_modules、dist、coverage 和常见凭证文件；遇到疑似私钥或 Token 会拒绝发布。源码在隔离的 Vercel 项目中构建。

## 工具

| 工具 | 用途 |
| --- | --- |
| inspect_game(project_directory) | 只读检测当前绝对路径，返回支持情况及构建方式（web-npm / godot-web） |
| connect_platform() | 建立当前客户端连接，返回用户授权网址 |
| publish_game(project_directory, title?, description?) | 检测后发布；名称、介绍默认从项目读取 |
| publish_link(url, project_directory?, title?, description?) | 把已部署的可玩 HTTPS 网址发布为 1GP 游戏页，不构建；同一网址再次提交会更新同一作品 |
| get_publish_status(build_id) | 查询当前账号自己的构建和试玩网址 |

错误包含 `UNSUPPORTED_BUILD`、`POTENTIAL_SECRET`、`AUTH_REQUIRED`，`publish_link` 另有 `INVALID_URL`、`TITLE_REQUIRED`；连不上平台时为 `NETWORK_ERROR`。遇到网络不确定的发布结果不要自动重复提交，可到网站「我的发布」查看。

## 授权与限制

本地凭证保存在 `~/.config/1gp-studio/`，目录权限 0700，文件权限 0600。平台仅保存 SHA-256 哈希。凭证不会通过工具结果或浏览器 URL 输出。授权 90 天有效，仅允许发布和查询自己的构建；在网站「我的发布」撤销后，再运行 connect_platform 可重新连接。

平台目前限制全站同时 2 个构建、每个账号最多 50 个作品，不设每日次数限制。账号邮箱验证由 Supabase 负责；平台管理员必须配置生产邮件服务，才能支持组织外用户收取登录邮件。Vercel 的套餐、GitHub 访问授权及构建限制仍适用。

开发时可使用 `ONEGP_PLATFORM_URL` 指向另一 HTTPS 平台，或本机 HTTP localhost/127.0.0.1；凭证按平台分别保存。测试运行 `npm test`，包括真实 MCP stdio 客户端集成测试。
