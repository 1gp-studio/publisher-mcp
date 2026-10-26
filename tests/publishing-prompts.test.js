import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import packageInfo from '../package.json' with { type: 'json' };
import { automaticPublishPrompt, localPublishPrompt, dockerPublishPrompt, multilingualPrompt, cloudSavesPrompt, leaderboardsPrompt, updateGamePrompt, githubPreparationPrompt } from '../src/publishing-prompts.js';
import { classificationGuidance } from '../src/classification-guidance.js';
import { updateApprovalGuidance, updateHistoryGuidance } from '../src/update-approval-guidance.js';
import { multilingualSourceGuidance, cloudSaveOriginGuidance } from '../src/integration-guidance.js';
import { publishingFeaturePolicy } from '../src/publishing-policy.js';

test('registered MCP prompts expose shared integration rules and schema-complete announcement examples', async () => {
 const client = new Client({ name: 'prompt-contract-test', version: '1.0.0' });
 const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/server.js', import.meta.url))],
  env: { PATH: process.env.PATH ?? '', ONEGP_PLATFORM_URL: 'http://127.0.0.1:1' },
  stderr: 'pipe',
 });
 try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, packageInfo.version);
  const { tools } = await client.listTools();
  const announcement = tools.find(tool => tool.name === 'publish_game_announcement');
  assert.ok(announcement, 'actual announcement tool is registered');
  const github = tools.find(tool => tool.name === 'update_github_game');
  assert.match(github.description, /no uncommitted source changes/);
  assert.match(github.description, /generated artifacts and publishing materials may remain/);
  assert.match(github.description, /HEAD to exactly match its remote tip, not merely be an ancestor/);
  assert.match(github.description, /publish the inspected commit SHA/);
  const { prompts } = await client.listPrompts();
  const multilingual = prompts.find(prompt => prompt.name === 'make_game_multilingual');
  assert.match(multilingual.description, /keys\/phrases/);
  let checkedAnnouncements = 0;
  for (const prompt of prompts) {
   const result = await client.getPrompt({ name: prompt.name,
    ...(prompt.name === 'prepare_github_publish' ? { arguments: { repo: 'example/game' } } : {}),
   });
   const text = result.messages.map(message => message.content.type === 'text' ? message.content.text : '').join('\n');
   if (['choose_publish_path', 'publish_local_artifacts', 'prepare_docker_publish', 'update_game'].includes(prompt.name)) {
    assert.ok(text.includes(publishingFeaturePolicy.zh), `${prompt.name}: optional feature policy`);
    const calls = [...text.matchAll(/publish_game_announcement\(\{([^}]+)\}\)/g)];
    assert.equal(calls.length, 1, `${prompt.name}: one executable announcement example`);
    const fields = calls[0][1].split(',').map(field => field.split(':')[0].trim());
    for (const required of announcement.inputSchema.required)
     assert.ok(fields.includes(required), `${prompt.name}: missing actual schema field ${required}`);
    checkedAnnouncements++;
   }
   if (['choose_publish_path', 'publish_local_artifacts', 'prepare_docker_publish', 'update_game', 'make_game_multilingual'].includes(prompt.name))
    assert.ok(text.includes(multilingualSourceGuidance.zh), `${prompt.name}: source workflow`);
   if (prompt.name === 'add_cloud_saves') assert.ok(text.includes(cloudSaveOriginGuidance));
  }
  assert.equal(checkedAnnouncements, 4);
 } finally {
  await client.close();
 }
});

test('publishing and updates explain mixed genres without overriding the author category', () => {
 for (const prompt of [automaticPublishPrompt, localPublishPrompt, dockerPublishPrompt, updateGamePrompt('game')]) {
  assert.ok(prompt.includes(classificationGuidance.zh));
  assert.match(prompt, /标签只避开与当前主分类重复的名称及其译名，可以使用其他分类名/);
  assert.match(prompt, /RPG 选 idle，标签 RPG、角色养成/);
  assert.match(prompt, /RPG 选 action，标签放置、RPG/);
  assert.match(prompt, /fillMissing=true 只补缺失，不自动纠正已有选择/);
  assert.doesNotMatch(prompt, /不重复分类|避免重复分类/);
 }
});

test('normal publishing fills store metadata and real media even when multilingual support is declined', () => {
 for (const prompt of [automaticPublishPrompt, localPublishPrompt, dockerPublishPrompt, updateGamePrompt('game')]) {
  assert.ok(prompt.indexOf('上架物料是常规发布步骤') < prompt.indexOf('已有或本次同意接入多语言时'));
  for (const item of ['prepare_game.promotion','set_game_details(fillMissing=true)','genre','tags','set_game_media(','3–5','12–18','20 MiB','主封面与多语言无字底图分别处理']) assert.ok(prompt.includes(item),item);
  assert.match(prompt,/用作者主语言/);assert.match(prompt,/保留已有分类和标签/);
  assert.match(prompt,/unknown 或读取失败不代表内容为空/);
  assert.match(prompt,/不强制接管游戏时钟、不改玩法、不碰玩家存档/);
  assert.match(prompt,/不用生成图片冒充游戏截图/);
  assert.match(prompt,/保留已有主封面和预览，截图只追加/);
  assert.match(prompt,/首发必须有分类、标签和主封面/);
  assert.match(prompt,/截图或预览没做时说明原因/);
  assert.match(prompt,/纯物料修改不部署、不发版本帖/);
 }
});

test('all MCP prompt entries check actual runtime compatibility before preparing work', () => {
 for(const prompt of [automaticPublishPrompt,localPublishPrompt,dockerPublishPrompt,multilingualPrompt,cloudSavesPrompt,leaderboardsPrompt,updateGamePrompt('game'),githubPreparationPrompt('org/game',undefined,'check')]) {
  assert.ok(prompt.indexOf('serverInfo.version')<prompt.indexOf('connect_platform'));
  assert.match(prompt,/get_publisher_info/);assert.match(prompt,/至少 0\.12\.1/);
  assert.match(prompt,/保留其他参数、环境配置和已有授权凭证/);
  assert.match(prompt,/重新加载 MCP 后复查实际运行版本/);assert.match(prompt,/不能重载时才请我重启/);
  assert.match(prompt,/更高且兼容的版本直接使用，不降级/);
 }
});

test('multilingual prompts fill missing materials and verify localized title overlays', () => {
 for(const prompt of [automaticPublishPrompt,localPublishPrompt,dockerPublishPrompt,multilingualPrompt,updateGamePrompt('game')]) {
  for(const item of ['prepare_game.materials','get_game_materials','set_game_details(fillMissing=true)','set_game_covers(fillMissing=true)','zh、en、ja、ko、es','ORIGINAL_CHANGED'])assert.ok(prompt.includes(item),item);
  assert.match(prompt,/同一张无字底图上叠加各语言游戏名字/);
  assert.match(prompt,/原始语言保留主封面/);assert.match(prompt,/保留已有 main、special、modes 和 position/);
  assert.match(prompt,/不生成不同语言的游戏截图/);assert.match(prompt,/回退主封面，不能算已完成/);
  assert.match(prompt,/尚未完成的明确列为待处理/);
 }
});

test('first-launch announcements remain separately approved and recover independently of deployment', () => {
 for(const prompt of [automaticPublishPrompt,localPublishPrompt,dockerPublishPrompt,updateGamePrompt('game')]) {
  assert.match(prompt,/features\.announcement=true/);assert.match(prompt,/get_game_announcement/);
  assert.match(prompt,/宣传意向不等于同意具体帖子内容/);assert.match(prompt,/此前已明确批准相同内容则沿用/);
  assert.match(prompt,/最终发布 ready 且网页检查通过后，才调用 publish_game_announcement/);
  assert.match(prompt,/重试沿用相同 launchReference/);assert.match(prompt,/作者删帖后不自动重发/);
  assert.match(prompt,/更新版本不自动发首发宣传帖/);assert.match(prompt,/宣传失败只查询或重试宣传，不重发游戏/);
 }
});

test('all publishing and optional integration workflows group necessary deployments and finalize only once', () => {
 for (const prompt of [automaticPublishPrompt, localPublishPrompt, dockerPublishPrompt, multilingualPrompt, cloudSavesPrompt, leaderboardsPrompt, updateGamePrompt('game')]) {
  for (const required of ['release.updateId', 'update_id', 'UPDATE_IN_PROGRESS', 'new_update=true', 'complete_game_update', '中间部署不发社区日志', '纯物料更新没有部署，不调用收尾']) assert.ok(prompt.includes(required), required);
  assert.match(prompt, /尽量只做一次最终发布/);
  assert.match(prompt, /首发组跳过更新日志/);
  assert.match(prompt, /收尾失败或结果不明只重试同一 update_id 和相同内容，不重发游戏/);
  assert.ok(prompt.includes(updateApprovalGuidance.zh));
  assert.ok(prompt.includes(updateHistoryGuidance.zh));
  assert.doesNotMatch(prompt, /complete_game_update\(\{project_directory,update_id,title,notes\}\)/);
 }
});

test('all five shared announcement rules require exact content approval and preserve deployment history on deletion', () => {
 for (const language of ['zh', 'en', 'ja', 'ko', 'es']) {
  const approval = updateApprovalGuidance[language], deletion = updateHistoryGuidance[language];
  for (const text of ['complete_game_update({project_directory,update_id,title,notes,approved:true})', 'get_publisher_info', 'approved-update-announcements', 'update_id']) assert.ok(approval.includes(text), `${language}: ${text}`);
  for (const text of ['get_game_updates', 'nextCursor', 'delete_game_update({gameSlug,reference,approved:true})']) assert.ok(deletion.includes(text), `${language}: ${text}`);
 }
 assert.match(updateApprovalGuidance.zh, /游戏发布或技术部署授权不等于版本公告认可/);
 assert.match(updateApprovalGuidance.zh, /相同内容已有明确认可就沿用，不重复询问/);
 assert.match(updateApprovalGuidance.zh, /内容改变后须重新确认/);
 assert.match(updateApprovalGuidance.zh, /保留草稿和同一 update_id/);
 assert.match(updateHistoryGuidance.zh, /构建历史、部署产物、在线版本、回退能力和玩家数据保留/);
});

test('author documentation describes confirmation and safe removal without automatic legacy posts', async () => {
 const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
 for (const item of ['approved:true', 'get_game_updates', 'delete_game_update', 'nextCursor', '构建历史', '回退能力']) assert.ok(readme.includes(item), item);
 assert.doesNotMatch(readme, /成功后更新日志才对玩家展示|仍沿用按发布记录生成日志的兼容行为/);
});

test('package, lock and active install examples agree without rewriting historical changelog entries',async()=>{
 const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
 const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');
 assert.equal(packageInfo.version,'0.14.0');assert.equal(lock.version,packageInfo.version);assert.equal(lock.packages[''].version,packageInfo.version);
 const install=readme.split('## 使用')[0];assert.ok(install.includes('#v0.14.0'));assert.ok(!install.includes('#v0.13.0'));assert.ok(!install.includes('#v0.12.1'));assert.ok(!install.includes('#v0.11.0'));assert.ok(!install.includes('#v0.10.0'));assert.ok(!install.includes('#v0.9.0'));assert.doesNotMatch(readme,/本地包，尚未公开发布|当前仅准备本地安装包/);
 for(const heading of ['## v0.14.0','## v0.13.0','## v0.12.1','## v0.12.0','## v0.11.0','## v0.10.0','## v0.9.0','## v0.8.0','## v0.7.4','## v0.6.2'])assert.ok(readme.includes(heading));
});
