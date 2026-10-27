# 给开发这个 MCP 的队友

## 新功能尽量做成已有工具的参数

从 v0.16.0 起，作者装的是一个启动器，平台推荐新版后会自动换上，不用改配置、不用重开（见 README 的「v0.16.0：自动更新」）。

但客户端刷新工具列表的能力不一样：

- Claude Code：收到 `tools/list_changed` 会刷新，新工具在同一个对话里就能用。
- Codex：目前不刷新（它的 `mcp_tool_list_changed` 还在开发中、默认关）。已有工具会直接用上新代码，**新增的工具名要新开任务才出现**。

所以：

1. **新功能优先加在已有工具上**，用新的可选参数，例如 `set_game_media` 的 `replacePreview`。这样所有客户端当场就能用。
2. **只加可选参数，不删参数、不改名、不把可选改成必填。** 客户端可能还拿着旧的工具说明，照旧的写法调用，也要能用。
3. **实在要加新工具**（和已有工具都不沾边）：在 README 的版本说明里写一句「Codex 要新开任务才看得到」。
4. 工具说明（description）也会被缓存。改了行为，要让旧说明下的调用仍然得到合理结果，或者在返回结果里告诉 AI 怎么做。

## 发版

1. 本仓库测试通过（`npm test`），`package.json`、`package-lock.json` 和网站提示词的版本一致（网站仓库的 `tests/mcp-version-pins.test.ts` 会查）。
2. 公开仓库 `1gp-studio/publisher-mcp` 打标签 `vX.Y.Z` 并推送。
3. 网站 `public/mcp/release.json` 写上新版本和标签的提交号（`git ls-remote https://github.com/1gp-studio/publisher-mcp "refs/tags/vX.Y.Z^{}"`），跟提示词一起推网站。网站上线后，0.16+ 的作者会自动换到新版。
4. 回滚：把 `release.json` 改回旧版本和它的提交号，推网站。
