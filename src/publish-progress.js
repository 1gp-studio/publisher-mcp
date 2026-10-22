import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const slug = value => typeof value === 'string' && value.length <= 200 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const nextStep = '继续查询此 buildId 的发布状态；可省略 buildId 恢复本账号最后一次任务。不要重新提交发布。';
const failure = (code, error) => ({ code, error });
const storageFailure = () => failure('PUBLISH_JOB_STORAGE_ERROR', '无法安全读写本地发布记录；请保留 buildId，稍后明确指定它继续查询。');
const authFailure = () => failure('AUTH_REQUIRED', '请先运行 connect_platform，并由用户在浏览器确认授权。');
const validJob = value => value && typeof value === 'object' && uuid(value.buildId)
  && (value.gameSlug === undefined || slug(value.gameSlug))
  && (value.channel === undefined || typeof value.channel === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value.channel));

/** A ready deployment is a handoff to material verification, never proof that the whole task is done. */
export function withMaterialNextSteps(data, fallbackSlug) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.state !== 'ready') return data;
  const pathSlug = typeof data.path === 'string' ? /^\/games\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(data.path)?.[1] : undefined;
  const gameSlug = [data.games?.slug, data.slug, data.gameSlug, pathSlug, fallbackSlug].find(slug);
  return { ...data, ...(gameSlug ? { gameSlug } : {}), workflowComplete: false, materialStatus: 'needs_verification', nextSteps: [
    'ready 只确认部署完成。继续完成本次发布物料；核对仍使用本次发布的作者账号，账号变化时先回到原账号。',
    gameSlug ? `调用 get_game_materials({gameSlug:${JSON.stringify(gameSlug)}})，复用 prepare_game.promotion 和本地 1gp-kit/game.json 中已准备的物料；需要重查 prepare_game 时沿用同一 update_id，不另建更新组。`
      : '先通过发布状态或 find_my_game 核实真实 gameSlug，不编造标识；取得后读取 get_game_materials，复用 prepare_game.promotion 和本地 1gp-kit/game.json，重查时沿用同一 update_id。',
    '根据实际玩法用 set_game_details(fillMissing=true) 补缺的分类和作者主语言标签；沿用已有授权与选择，保留已有作者文案、分类和标签。',
    '用 set_game_media 上传已检查的主封面、实机截图和可选预览；从本地 kit 复用真实文件，缺少时由宿主 AI 截图、录制或准备合适素材，不编造游戏画面。保留已有封面、截图和作者关闭预览的选择。',
    '若作者已选择多语言，继续补缺的文案和同一无字底图上的本地化游戏名封面；保留作者选择，未选择的可选功能不自动开启。',
    '重新读取 get_game_materials，并实际查看公开封面和截图、播放预览、检查网页和必要接口；部分失败或缺项要明确报告，不能把部署 ready 当作全部完成。',
    '纯元数据或媒体补充无需再次部署。最终网页、功能和物料核对后，用同一 update_id 调用 complete_game_update 收尾一次；首发宣传仅按作者已批准的相同内容发布。',
  ] };
}

// Every path component is checked, including ancestors of the configured credential directory.
// Never follow a pre-existing symlink/junction or read another file through a hard link.
async function directory(path, create = false) {
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const part of full.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe publish record directory');
  }
}

function scope(platform, token) {
  if (typeof platform.directory !== 'string' || !isAbsolute(platform.directory)) throw new Error('Invalid config directory');
  const url = new URL(platform.origin);
  if (url.origin !== platform.origin || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Invalid platform origin');
  const accountHash = hash(token), path = join(platform.directory, 'publish-jobs', hash(url.origin));
  return { path, file: join(path, `${accountHash}.json`), accountHash, origin: url.origin };
}

async function readJob(store) {
  let handle;
  try {
    await directory(store.path);
    const before = await lstat(store.file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 8192) throw new Error('Invalid publish record');
    handle = await open(store.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino) throw new Error('Publish record changed');
    const buffer = Buffer.alloc(8193), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error('Oversized publish record');
    const job = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!validJob(job) || job.version !== 1 || job.origin !== store.origin || job.accountHash !== store.accountHash) throw new Error('Invalid publish record');
    return job;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

async function writeAtomicJob(store, job) {
  let temporary, handle;
  try {
    await directory(store.path, true);
    const before = await lstat(store.file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) throw new Error('Unsafe publish record');
    temporary = join(store.path, `.${store.accountHash}.${randomBytes(12).toString('hex')}.tmp`);
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ version: 1, origin: store.origin, accountHash: store.accountHash,
      buildId: job.buildId, ...(job.gameSlug ? { gameSlug: job.gameSlug } : {}), ...(job.channel ? { channel: job.channel } : {}) }));
    await handle.sync();
    await handle.close(); handle = null;
    await directory(store.path);
    await rename(temporary, store.file);
    temporary = null;
  } finally {
    await handle?.close();
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

// Concurrent tools in one MCP process keep submission order and do not contend for the Windows
// destination rename. Other processes still see either the complete old or complete new record.
const writes = new Map();
async function writeJob(store, job) {
  const pending = (writes.get(store.file) ?? Promise.resolve()).catch(() => {}).then(() => writeAtomicJob(store, job));
  writes.set(store.file, pending);
  try { await pending; } finally { if (writes.get(store.file) === pending) writes.delete(store.file); }
}

/** Record only a known submitted build; a storage failure must never imply that publication failed. */
export async function recordPublishJob(platform, job = {}, submittedToken) {
  if (!validJob(job)) return { recorded: false, ...failure('INVALID_PUBLISH_JOB', '需要有效的 buildId 和可选的游戏标识。') };
  const token = await platform.token();
  if (submittedToken !== undefined && token !== submittedToken) return { recorded: false, buildId: job.buildId,
    ...failure('ACCOUNT_CHANGED', '发布已提交，但连接账号已变更；未写入新账号的恢复记录。请保留 buildId，在原账号中继续查询。') };
  if (!token) return { recorded: false, buildId: job.buildId, ...authFailure() };
  try {
    await writeJob(scope(platform, token), job);
    return { recorded: true, buildId: job.buildId };
  } catch { return { recorded: false, buildId: job.buildId, ...storageFailure() }; }
}

// Keep author reads, artifact uploads and the final submit on one credential. A callback response
// cannot move the known build into another account's recovery slot if credentials change in flight.
export async function publishWithTracking(platform, { channel, gameSlug }, submit) {
  const token = await platform.token();
  if (!token) return authFailure();
  const client = Object.create(platform);
  client.token = async () => token;
  client.currentToken = () => platform.token();
  client.request = (path, options = {}) => platform.request(path, { ...options, token });
  const data = await submit(client);
  if (!data?.error && typeof data?.id === 'string' && ['queued', 'building', 'ready', 'failed'].includes(data.state)) {
    const tracking = await recordPublishJob(platform, { buildId: data.id, channel, gameSlug }, token)
      .catch(() => ({ recorded: false, buildId: data.id, message: '发布已提交；本机未能保存恢复记录，请保留此 build ID。' }));
    // Preserve the submission API's allocated game-page address. The accompanying state is
    // still authoritative; waitForPublish deliberately exposes a URL only once it is ready.
    return withMaterialNextSteps({ ...data, tracking, ...(data.path ? { gameUrl: platform.origin + data.path } : {}) }, gameSlug);
  }
  return withMaterialNextSteps(data, gameSlug);
}

const runtime = {
  now: () => performance.now(),
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: timer => clearTimeout(timer),
};

// Both the fetch and its response body have the same remaining deadline. The outer timer also
// bounds an older/custom Platform implementation which does not yet consume timeoutMs/signal.
async function statusRequest(platform, token, buildId, timeoutMs, clock) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise(resolve => {
    timer = clock.setTimeout(() => { controller.abort(); resolve({ deadline: true }); }, timeoutMs);
  });
  const request = Promise.resolve().then(() => platform.request(`/api/publish/${buildId}`, {
    method: 'GET', token, timeoutMs, signal: controller.signal,
  })).then(data => ({ data }), () => ({ data: failure('NETWORK_ERROR', '无法连接平台，请继续查询状态；不要重复提交发布。') }));
  try { return await Promise.race([request, timeout]); } finally { clock.clearTimeout(timer); }
}

/** Query only; never upload, rebuild or submit a publication. The third argument is a test clock. */
export async function waitForPublish(platform, { buildId, waitSeconds = 45, pollIntervalSeconds = 10 } = {}, clock = runtime) {
  const started = clock.now();
  if (buildId !== undefined && !uuid(buildId)) return failure('INVALID_PUBLISH_JOB', 'buildId 必须是有效的构建任务 UUID。');
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 45 || !Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds < 10 || pollIntervalSeconds > 45) return failure('INVALID_WAIT_OPTIONS', 'waitSeconds 应在 0–45 秒内，轮询间隔应在 10–45 秒内。');
  const token = await platform.token();
  if (!token) return { ...authFailure(), ...(buildId ? { buildId } : {}) };
  let store, job, storageWarning;
  try {
    store = scope(platform, token);
    job = await readJob(store);
  } catch {
    if (!buildId) return storageFailure();
    storageWarning = storageFailure();
  }
  const resumed = buildId === undefined;
  if (!buildId && !job) return failure('NO_PUBLISH_JOB', '本平台当前账号没有可恢复的发布任务。请提供之前返回的 buildId，不要重新发布。');
  if (buildId && job?.buildId !== buildId) {
    job = { buildId };
    try { if (!store) throw new Error('Invalid storage'); await writeJob(store, job); storageWarning = undefined; } catch { storageWarning = storageFailure(); }
  }
  buildId = job.buildId;
  const deadline = started + (waitSeconds === 0 ? 10000 : waitSeconds * 1000);
  const base = { buildId, resumed, ...(storageWarning ? { storageWarning } : {}) };
  let latest = {};
  const pending = extra => ({ ...latest, ...extra, ...base, pending: true, terminal: false, nextStep });
  const expired = () => pending({ code: 'WAIT_TIMEOUT', message: latest.message || '本次等待已结束，发布状态尚未确认；请继续查询。' });
  while (true) {
    if (await platform.token() !== token) return pending(failure('ACCOUNT_CHANGED', '连接账号已变更；旧任务仍保留在原账号下。请在正确账号中继续查询。'));
    const remaining = deadline - clock.now();
    if (remaining <= 0) return expired();
    const answer = await statusRequest(platform, token, buildId, Math.max(1, Math.floor(remaining)), clock);
    if (await platform.token() !== token) return pending(failure('ACCOUNT_CHANGED', '连接账号已变更；旧任务仍保留在原账号下。请在正确账号中继续查询。'));
    if (answer.deadline || clock.now() >= deadline) return expired();
    const data = answer.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return pending(failure('PLATFORM_ERROR', '平台返回了无效的发布状态，请继续查询。'));
    // Never pass through a premature URL, even if an upstream response contains one.
    const { gameUrl: ignoredUrl, ...status } = data;
    void ignoredUrl;
    if (status.error) return pending(status);
    if (status.id !== undefined && (typeof status.id !== 'string' || status.id.toLowerCase() !== buildId.toLowerCase()) || !['queued', 'building', 'ready', 'failed'].includes(status.state)) return pending(failure('PLATFORM_ERROR', '平台返回了无法识别的发布状态，请继续查询。'));
    latest = status;
    if (status.state === 'ready' || status.state === 'failed') {
      const gameSlug = slug(status.games?.slug) ? status.games.slug : job.gameSlug;
      return withMaterialNextSteps({ ...status, ...base, pending: false, terminal: true,
        ...(status.state === 'ready' && gameSlug ? { gameUrl: `${platform.origin}/games/${gameSlug}` } : {}) }, gameSlug);
    }
    if (waitSeconds === 0) return pending({});
    const pause = Math.min(pollIntervalSeconds * 1000, deadline - clock.now());
    if (pause <= 0) return expired();
    await clock.sleep(pause);
  }
}
