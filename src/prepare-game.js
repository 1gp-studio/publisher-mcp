import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { prepareRelease } from './releases.js';
import { inspectGame } from './inspect.js';
import { checkGameLanguages } from './languages.js';
import { getGameIntegrations } from './integrations.js';
import { getGameMaterials } from './materials.js';
import { getGameTextSource } from './text-source.js';
import { preparePromotion } from './promotion.js';
import { prepareGameUpdate } from './game-updates.js';
import packageInfo from '../package.json' with { type: 'json' };

const featureNames = ['multilingual', 'cloudSaves', 'leaderboards'];
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
  const [inspection, languageCheck, integrations, materials, textSources] = await Promise.all([
    inspectGame(root, options.buildOptions), checkGameLanguages(root),
    release.gameSlug ? getGameIntegrations(client, release.gameSlug) : Promise.resolve(null),
    release.gameSlug ? getGameMaterials(client, release.gameSlug).catch(() => ({ error: '暂时无法读取平台物料；先恢复连接，不能把未知状态当作缺失。', code: 'MATERIALS_UNAVAILABLE' })) : Promise.resolve(null),
    release.gameSlug ? Promise.all(['keys', 'phrases'].map(async use => [use, await getGameTextSource(client, release.gameSlug, use)])).then(Object.fromEntries) : Promise.resolve(null),
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
    name === 'multilingual' && (languageCheck.multilingual || Object.values(textSources ?? {}).some(source => !source.error && source.config?.enabled)) || name === 'cloudSaves' && live?.cloudSaves?.enabled || name === 'leaderboards' && live?.leaderboards?.length ? true : null
  )]));
  const textSourceEnabled = Object.values(textSources ?? {}).some(source => !source.error && source.config?.enabled);
  // The standalone language checker can suggest asking about initial setup. Combined preparation
  // already knows the author's choice; keep nested guidance consistent with that choice too.
  if (requested.multilingual === false) {
    languageCheck.nextSteps = ['作者已选择本次不做多语言改造，保留游戏当前语言和已有功能，不重复询问或关闭已有多语言。'];
  } else if (textSourceEnabled) {
    languageCheck.nextSteps = ['已有自动文字来源配置，沿用 textSources 中的模式和文件，不重复询问或重新配置。配置和词表就绪不等于 SDK/Godot 显示接入已验证；核对 integration、待审条目与实际游戏。', ...languageCheck.nextSteps.slice(1)];
  } else if (requested.multilingual === true && !languageCheck.multilingual) {
    languageCheck.nextSteps = ['作者已选择接入多语言，按 convention 改造并验证，无需再次询问。', ...languageCheck.nextSteps.slice(1)];
  } else if (!languageCheck.multilingual) {
    // Not asked before publishing; the integration convention is fetched only once the author opts in.
    languageCheck.nextSteps = ['还没做多语言。发布前不追问，发布后作为可选功能提醒；作者要做时再调用 check_game_languages 取得接入约定。'];
    delete languageCheck.convention;
  }
  return { project_directory: root, ...release, inspection, languageCheck, integrations, materials, textSources, promotion, publisherVersion: packageInfo.version, features: requested,
    ...(update?.error ? { updateWarning: update } : update ? { updateId: update.id, update } : {}),
    ...(preferenceWarning ? { preferenceWarning } : {}),
    // Nothing is asked before publishing; optional features are offered once the game is live.
    decisions: [],
    optionalFeatures: [...['multilingual', 'cloudSaves', 'leaderboards'].filter(name => requested[name] !== true),
      ...['preview'].filter(key => ['prepare_needed', 'local_candidate'].includes(promotion.items[key]?.state))],
    instructions: `${release.instructions}
准备结果已包含游戏识别、发布渠道、项目检查和语言检查，不必再单独 find_my_game、prepare_release 或 check_game_languages；源码或配置改变后只重查相关项。
首发需要 promotion.required 里的分类、主语言标签、主封面、制作信息和至少 3 张真实截图：依据代码和实玩证据用 set_game_details 只补缺失 genre/tags 并填 maker，用 set_game_media 上传核对过的主封面和截图；预览可选，上线后问作者要不要做宣传视频。复用已有素材，保留作者关闭预览；截图和视频可用 record_game_video，MCP 不生成图片，缺少工具时如实说明。平台物料状态未知先恢复读取，上传成功或部署 ready 都不能代替实际查看。截图、主封面、预览、各语言封面、名字简介、分类标签和制作信息以后都能按作者要求修改（set_game_media 的 replaceCover/replacePreview/replaceScreenshots、edit_game_media、set_game_covers、set_game_details）。
发布前不追问可选功能：多语言、云存档、排行榜已开启的照常沿用，作者主动要求时才接入。features 是作者意向，不代表已接入；false 不会关闭已有功能。发布完成后按 optionalFeatures 简短提醒作者还有哪些可选功能没用上，说明可以帮忙接入或补齐，由作者决定。
云存档/排行榜只在作者选择后用配置工具和专属接入说明修改游戏；配置接口失败先解决，不把未知当未启用。textSources 只读展示自动文字同步配置，读取失败表示不可用，不表示关闭；configure_game_text_source 只登记文件并有限扫描，不构建、不发布；待审候选逐项核对后按 source_fingerprint 批准。多语言包括游戏文字、名字、简介和同一底图叠加译名的自动封面，保留作者已有设置。
新游戏必须先发布以获得真实 ID 时，之后接入功能的部署沿用本次 updateId，不编造 ID 或宣称已接通。重查或记住 features 时传同一 update_id；所有渠道发布都带 release.updateId。只改平台语言文件、名称、简介、封面或配置时不重新发布。中间部署合并成一条版本记录；首发不用收尾，首发部署的标题和说明就是第一条版本记录。发布或更新后主动问作者：要不要把这版写进版本记录、要不要再发一篇社区帖（create_game_post），都附上拟好的草稿；作者同意哪项才做哪项。收尾失败只重试收尾，不重发游戏。发布返回 build ID 后用 wait_for_publish 继续；结果不明不重复发布。`,
  };
}
