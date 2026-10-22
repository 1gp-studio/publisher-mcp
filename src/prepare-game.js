import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { prepareRelease } from './releases.js';
import { inspectGame } from './inspect.js';
import { checkGameLanguages } from './languages.js';
import { getGameIntegrations } from './integrations.js';
import { getGameMaterials } from './materials.js';
import { preparePromotion } from './promotion.js';
import { prepareGameUpdate } from './game-updates.js';
import packageInfo from '../package.json' with { type: 'json' };

const featureNames = ['multilingual', 'cloudSaves', 'leaderboards', 'announcement'];
const cleanChoices = input => Object.fromEntries(featureNames.filter(key => input && Object.hasOwn(input, key) && typeof input[key] === 'boolean').map(key => [key, input[key]]));
async function preferenceDirectory(path, create = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Invalid options directory');
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const part of full.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe options directory');
  }
}
async function readPreferences(path) {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) throw new Error('Unsafe options file');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino) throw new Error('Options file changed');
    const buffer = Buffer.alloc(4097), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error('Unsafe options file');
    return cleanChoices(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  } finally { await handle?.close(); }
}
async function preferences(platform, root, choices, token) {
  if (!token) throw new Error('No account for saved choices');
  const key = createHash('sha256').update(JSON.stringify([platform.origin, token, root])).digest('hex');
  const directory = platform.directory, path = join(directory, `options-${key}.json`);
  await preferenceDirectory(directory, true);
  const saved = await readPreferences(path);
  const next = { ...saved, ...cleanChoices(choices) };
  if (choices && Object.keys(cleanChoices(choices)).length) {
    const temporary = `${path}.${randomBytes(8).toString('hex')}`;
    try {
      await preferenceDirectory(directory);
      await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      await preferenceDirectory(directory);
      await rename(temporary, path);
    }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return next;
}

// One entry point for read-only preparation; optional choices remember only what the author
// explicitly selected. They never enable services, change code, publish or override live settings.
export async function prepareGame(platform, projectDirectory, options = {}) {
  if (!isAbsolute(projectDirectory)) return { error: '请提供当前游戏项目的绝对路径。', code: 'INVALID_PROJECT' };
  const token = typeof platform.token === 'function' ? await platform.token() : null;
  // One preparation belongs to the account that started it. Never let a credential-file change
  // switch subsequent reads or move the author's choices into another account's preferences.
  const client = Object.create(platform);
  if (token) {
    client.token = async () => token;
    client.request = (path, options = {}) => platform.request(path, { ...options, token });
  }
  const changed = async () => token && await platform.token() !== token;
  const accountChanged = () => ({ code: 'ACCOUNT_CHANGED', error: '连接账号已变更，请使用当前账号重新准备游戏；本次选择不会保存到新账号。' });
  const root = await realpath(projectDirectory);
  const release = await prepareRelease(client, root, options.gameSlug, options.dockerProject);
  if (await changed()) return accountChanged();
  if (release.error || release.code === 'CHOOSE_GAME') return release;
  const [inspection, languageCheck, integrations, materials] = await Promise.all([
    inspectGame(root, options.buildOptions), checkGameLanguages(root),
    release.gameSlug ? getGameIntegrations(client, release.gameSlug) : Promise.resolve(null),
    release.gameSlug ? getGameMaterials(client, release.gameSlug).catch(() => ({ error: '暂时无法读取平台物料；先恢复连接，不能把未知状态当作缺失。', code: 'MATERIALS_UNAVAILABLE' })) : Promise.resolve(null),
  ]);
  if (await changed()) return accountChanged();
  // Keep the original path for the safety checks; realpath must not hide a linked kit ancestor.
  const promotion = await preparePromotion(projectDirectory, { gameSlug: release.gameSlug, materials });
  let choices = {}, preferenceWarning;
  try { choices = await preferences(client, root, options.features, token); }
  catch { preferenceWarning = '本机未能保存功能选择；本次明确选择仍有效，下次可能需要重新确认。'; choices = cleanChoices(options.features); }
  if (await changed()) return accountChanged();
  const update = token ? await prepareGameUpdate(client, root, { token, gameSlug: release.gameSlug, updateId: options.updateId, newUpdate: options.newUpdate }) : null;
  if (await changed()) return accountChanged();
  if (update?.error && update.code !== 'UPDATE_STORAGE_ERROR') return update;
  const live = integrations?.error ? null : integrations;
  const requested = Object.fromEntries(featureNames.map(name => [name, choices[name] ?? (
    name === 'multilingual' && languageCheck.multilingual || name === 'cloudSaves' && live?.cloudSaves?.enabled || name === 'leaderboards' && live?.leaderboards?.length ? true : null
  )]));
  // The standalone language checker can suggest asking about initial setup. Combined preparation
  // already knows the author's choice; keep nested guidance consistent with that choice too.
  if (requested.multilingual === false) {
    languageCheck.nextSteps = ['作者已选择本次不做多语言改造，保留游戏当前语言和已有功能，不重复询问或关闭已有多语言。'];
  } else if (requested.multilingual === true && !languageCheck.multilingual) {
    languageCheck.nextSteps = ['作者已选择接入多语言，按 convention 改造并验证，无需再次询问。', ...languageCheck.nextSteps.slice(1)];
  }
  return { project_directory: root, ...release, inspection, languageCheck, integrations, materials, promotion, publisherVersion: packageInfo.version, features: requested,
    ...(update?.error ? { updateWarning: update } : update ? { updateId: update.id, update } : {}),
    ...(preferenceWarning ? { preferenceWarning } : {}),
    decisions: featureNames.filter(name => requested[name] === null && (name !== 'announcement' || release.channel === 'new')),
    instructions: `${release.instructions}\n先执行 promotion 的分类、主语言标签、主封面、真实截图和短实机预览五项清单；它独立于多语言选择。依据代码和实玩证据用 set_game_details 只补缺失 genre/tags，用 set_game_media 上传已核对的主封面、截图和预览；复用现有素材，已有作者截图不足 3 张时建议补到 3–5 张；仅有精选截图时直接复用，因为新增作者图会替换整组精选展示，不为凑数自动上传。保留作者关闭预览。MCP 不自带截图、图像或视频生成，缺少宿主工具时如实列出阻碍。平台物料状态未知先恢复读取；上传成功或部署 ready 都不能代替实际视觉/播放验证。\n准备已包含游戏识别、发布渠道、项目检查和语言检查，不必再单独 find_my_game、prepare_release 或 check_game_languages；仅源码/配置变化后重查相关项。只集中询问尚未决定且本次相关的功能，已有会话授权和已保存选择直接沿用。features 是作者意向，不代表已接入；false 不会关闭已有功能。云存档/排行榜默认不改，只有作者选择时才用配置工具和专属接入说明修改游戏。配置接口失败时先解决，不把未知状态当作未启用。materials 包含已有物料，读取失败时先解决，不能把未知状态当作空白。多语言需包含游戏文字、名字、简介和同一底图叠加译名的自动封面；保留已有作者设置。首次发布可集中询问 announcement；它只记住发帖意向，发布具体内容还需作者批准，可与物料和发布方案一次确认。更新不自动发首发宣传帖，宣传失败不得重发游戏。尽量先完成全部选定功能再做一次最终发布。新游戏必须先发布以获得真实 ID 时，必要的中间部署与随后接入功能后的部署沿用本次 updateId，不得编造 ID 或宣称已接通。重查或记住 features 时传同一 update_id；所有渠道发布均带 release.updateId。仅修改平台语言文件、名称、简介、封面或配置，不因物料改动重新发布。中间部署不发社区日志；最终 ready 且网页、接口和所有选定功能验证后才 complete_game_update 一次，汇总最终说明；首发组跳过更新日志。收尾失败只重试同一更新，不重发游戏。发布成功返回 build ID 后用 wait_for_publish 继续原任务；结果不明不得重复发布。`,
  };
}
