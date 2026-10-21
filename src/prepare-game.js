import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { prepareRelease } from './releases.js';
import { inspectGame } from './inspect.js';
import { checkGameLanguages } from './languages.js';
import { getGameIntegrations } from './integrations.js';

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
  const [inspection, languageCheck, integrations] = await Promise.all([
    inspectGame(root, options.buildOptions), checkGameLanguages(root),
    release.gameSlug ? getGameIntegrations(client, release.gameSlug) : Promise.resolve(null),
  ]);
  if (await changed()) return accountChanged();
  let choices = {}, preferenceWarning;
  try { choices = await preferences(client, root, options.features, token); }
  catch { preferenceWarning = '本机未能保存功能选择；本次明确选择仍有效，下次可能需要重新确认。'; choices = cleanChoices(options.features); }
  if (await changed()) return accountChanged();
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
  return { project_directory: root, ...release, inspection, languageCheck, integrations, features: requested,
    ...(preferenceWarning ? { preferenceWarning } : {}),
    decisions: featureNames.filter(name => requested[name] === null),
    instructions: `${release.instructions}\n准备已包含游戏识别、发布渠道、项目检查和语言检查，不必再单独 find_my_game、prepare_release 或 check_game_languages；仅源码/配置变化后重查相关项。只集中询问尚未决定且本次相关的功能，已有会话授权和已保存选择直接沿用。features 是作者意向，不代表已接入；false 不会关闭已有功能。云存档/排行榜默认不改，只有作者选择时才用配置工具和专属接入说明修改游戏。配置接口失败时先解决，不把未知状态当作未启用。新游戏先完成正常发布以获得真实 ID，再接入所选功能；不得编造 ID 或宣称已接通。修改游戏后重新准备版本并按原渠道发布。发布成功返回 build ID 后用 wait_for_publish 继续原任务；结果不明不得重复发布。`,
  };
}
