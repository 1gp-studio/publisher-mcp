import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { isPlatformOrigin } from './platform-origins.js';
import { uploadPostImage } from './post-images.js';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const slug = value => typeof value === 'string' && value.length <= 200 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const currentToken = platform => (platform.currentToken ?? platform.token).call(platform);
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (code, error, extra = {}) => ({ code, error, ...extra });
const changed = () => failure('ACCOUNT_CHANGED', '连接账号已变更；请回到原账号恢复同一 update_id，不要重复发布。');
const storageError = () => failure('UPDATE_STORAGE_ERROR', '无法安全保存更新工作流；没有提交发布。请修复本地记录后继续，不要另建更新碰运气。');
const pending = update => failure('UPDATE_IN_PROGRESS', '本项目有尚未收尾的更新。继续同一任务请给 prepare_game 传 update_id；确认这是独立的新任务才传 new_update=true。不要忘记原更新的 complete_game_update。', { update });
const locks = new Map();
async function locked(key, action) {
  const promise = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
  locks.set(key, promise);
  try { return await promise; } finally { if (locks.get(key) === promise) locks.delete(key); }
}

async function safeDirectory(path, create = false) {
  const full = resolve(path), root = parse(full).root;
  let current = root;
  for (const part of full.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create) try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe update directory');
  }
}
async function scope(platform, token, projectDirectory) {
  if (!token || !isAbsolute(projectDirectory) || !isAbsolute(platform.directory ?? '')) throw new Error('Invalid update storage');
  const origin = new URL(platform.origin);
  if (origin.origin !== platform.origin || origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new Error('Invalid platform origin');
  const project = await realpath(projectDirectory), accountHash = hash(token), projectHash = hash(project);
  const directory = join(platform.directory, 'game-updates', hash(origin.origin));
  return { origin: origin.origin, accountHash, projectHash, directory, file: join(directory, `${hash(JSON.stringify([accountHash, projectHash]))}.json`) };
}
async function read(store) {
  let handle;
  try {
    await safeDirectory(store.directory);
    const before = await lstat(store.file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096) throw new Error('Unsafe update record');
    handle = await open(store.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || before.ino !== opened.ino || before.dev !== opened.dev) throw new Error('Update record replaced');
    const bytes = Buffer.alloc(4097), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead > 4096 || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error('Update record changed');
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (value.version !== 1 || value.origin !== store.origin || value.accountHash !== store.accountHash || value.projectHash !== store.projectHash || !uuid(value.id) || typeof value.registered !== 'boolean' || value.gameSlug !== null && !slug(value.gameSlug)) throw new Error('Invalid update record');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
async function write(store, value, fresh = false) {
  await safeDirectory(store.directory, true);
  if (!fresh) await read(store);
  const path = fresh ? store.file : `${store.file}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ version: 1, origin: store.origin, accountHash: store.accountHash, projectHash: store.projectHash, ...value }));
    await handle.sync(); await handle.close(); handle = null;
    await safeDirectory(store.directory);
    if (!fresh) await rename(path, store.file);
  } finally { await handle?.close(); if (!fresh) await unlink(path).catch(() => {}); }
}
const publicUpdate = value => ({ id: value.id, gameSlug: value.gameSlug, registered: value.registered });

/** Local intent only. Registration happens immediately before the first real publication. */
export async function prepareGameUpdate(platform, projectDirectory, { gameSlug, updateId, newUpdate = false, token } = {}) {
  token ??= await platform.token?.();
  if (!token) return failure('AUTH_REQUIRED', '请先连接 AIWANNA 账号。');
  if (updateId !== undefined && !uuid(updateId) || newUpdate && updateId) return failure('INVALID_UPDATE', 'update_id 与 new_update 不能同时传入。');
  try {
    const store = await scope(platform, token, projectDirectory);
    return await locked(store.file, async () => {
      let value = await read(store);
      if (value && !newUpdate) {
        if (updateId && value.id !== updateId || gameSlug && value.gameSlug && value.gameSlug !== gameSlug) return failure('UPDATE_MISMATCH', '更新记录不属于本项目的目标游戏或 update_id。');
        if (value.registered && !updateId) return pending(publicUpdate(value));
        if (gameSlug && !value.gameSlug) { value = { ...value, gameSlug }; await write(store, value); }
        return { ...publicUpdate(value), resumed: true };
      }
      if (updateId) return failure('UPDATE_NOT_FOUND', '本账号和项目没有这个更新记录；不要猜测 ID 或提交新发布。');
      const next = { id: randomUUID(), gameSlug: gameSlug ?? null, registered: false };
      try { await write(store, next, !value); }
      catch (error) { if (error.code !== 'EEXIST') throw error; return pending(publicUpdate(await read(store))); }
      return { ...publicUpdate(next), resumed: false, ...(value ? { previousUpdateId: value.id } : {}) };
    });
  } catch { return storageError(); }
}

/** Register/resume the same logical update before any upload or publish side effect. */
export async function publishGameUpdate(platform, { projectDirectory, gameSlug, updateId }, submit) {
  if (!uuid(updateId)) return failure('UPDATE_REQUIRED', '先 prepare_game，然后在所有发布的 release.updateId 中沿用返回的 update.id。');
  const token = await platform.token?.();
  if (!token) return failure('AUTH_REQUIRED', '请先连接 AIWANNA 账号。');
  let store, value;
  try {
    store = await scope(platform, token, projectDirectory);
    value = await locked(store.file, async () => {
      const saved = await read(store);
      if (!saved || saved.id !== updateId || gameSlug && saved.gameSlug && saved.gameSlug !== gameSlug) return null;
      // Persist before registration: a lost HTTP response must resume this UUID, never start another.
      const next = { ...saved, registered: true, gameSlug: gameSlug ?? saved.gameSlug };
      await write(store, next); return next;
    });
  } catch { return storageError(); }
  if (!value) return failure('UPDATE_MISMATCH', 'release.updateId 必须来自本账号、本项目的 prepare_game；不得跨游戏复用。');
  if (await currentToken(platform) !== token) return changed();
  const client = Object.create(platform);
  client.token = async () => token;
  client.request = async (path, options = {}) => {
    if (await currentToken(platform) !== token) return changed();
    return platform.request(path, { ...options, token });
  };
  let registration;
  try { registration = await client.request('/api/developer/game-updates', { method: 'POST', body: { updateId, ...(value.gameSlug ? { gameSlug: value.gameSlug } : {}) } }); }
  catch { return failure('UPDATE_STATUS_UNKNOWN', '更新组注册结果不明；使用相同 update_id 恢复，不要另建更新或重新发布。', { updateId }); }
  if (registration?.error) return registration;
  const update = registration?.update;
  if (!update || update.id !== updateId || !['open', 'completed'].includes(update.state) || update.gameSlug !== null && !slug(update.gameSlug)
    || value.gameSlug && update.gameSlug !== value.gameSlug || typeof registration.created !== 'boolean') return failure('PLATFORM_ERROR', '更新组返回状态无效；保留同一 update_id，未提交发布。', { updateId });
  if (update.state !== 'open') return failure('UPDATE_COMPLETED', '这个更新已收尾。新任务请 prepare_game(new_update=true)，不要向已完成组追加部署。', { updateId });
  if (await currentToken(platform) !== token) return changed();
  if (update.gameSlug && !value.gameSlug) {
    try { await locked(store.file, async () => { const current = await read(store); if (current?.id === updateId) await write(store, { ...current, gameSlug: update.gameSlug }); }); }
    catch { return storageError(); }
  }
  const result = await submit(client);
  return { ...result, updateId, nextUpdateStep: '完成所有选定功能、必要修复和最终网页检查后，把最终版本标题和说明给作者确认；只有作者明确批准相同内容后才调用 complete_game_update(approved=true)。部署授权不等于更新公告授权；中间部署不发社区日志。' };
}

/** Finalize once; losing the response or deleting the post must never cause another deployment. */
export async function completeGameUpdate(platform, projectDirectory, { updateId, title, notes, approved, image }) {
  if (!uuid(updateId) || typeof title !== 'string' || !title.trim() || title.trim().length > 120 || typeof notes !== 'string' || !notes.trim() || notes.trim().length > 4000) return failure('INVALID_UPDATE', '需要真实 update_id 和最终合并的标题、说明。');
  if (approved !== true) return failure('APPROVAL_REQUIRED', `请先把这份最终版本标题和说明${image === undefined ? '' : '，以及随帖附上的图片'}给作者确认；明确批准相同内容后才发布更新公告。部署授权不等于公告授权。`,
    { draft: { title: title.trim(), notes: notes.trim(), ...(image === undefined ? {} : { image }) } });
  const token = await platform.token?.();
  if (!token) return failure('AUTH_REQUIRED', '请先连接 AIWANNA 账号。');
  let store, value;
  try { store = await scope(platform, token, projectDirectory); value = await read(store); }
  catch { return storageError(); }
  // An explicit completed id can still be retried after its active record was cleared.
  if (value && value.id !== updateId) return failure('UPDATE_MISMATCH', '本项目当前记录属于另一个更新，请核对 update_id。');
  if (await currentToken(platform) !== token) return changed();
  // The picture is uploaded for this update first; the same file always gives the same reference,
  // so a retry with the same image matches the completed post.
  let picture;
  if (image !== undefined) {
    const uploaded = await uploadPostImage(platform, projectDirectory, image, `update:${updateId}`, token);
    if (uploaded.error) return uploaded;
    picture = uploaded.image;
  }
  let data;
  try { data = await platform.request(`/api/developer/game-updates/${updateId}/complete`, { method: 'POST', token, body: { title: title.trim(), notes: notes.trim(), approved: true, ...(picture ? { image: picture } : {}) } }); }
  catch { return failure('UPDATE_STATUS_UNKNOWN', '收尾结果不明；仅用相同 update_id、title、notes 和 image 重试 complete_game_update，不要重发游戏。', { updateId }); }
  if (data?.error) return data;
  const validPost = data?.post && uuid(data.post.id) && typeof data.post.url === 'string' && (() => { try {
    const url = new URL(data.post.url);
    // The MCP transport may use its Vercel origin while public community pages use the canonical site.
    return isPlatformOrigin(url.origin, platform.origin) && !url.username && !url.password;
  } catch { return false; } })();
  if (data?.updateId !== updateId || !slug(data.gameSlug) || typeof data.created !== 'boolean'
    || !['published', 'launch_skipped', 'restricted_skipped'].includes(data.status) || (data.status === 'published' ? !validPost : data.post !== null)
    || value?.gameSlug && data.gameSlug !== value.gameSlug) return failure('PLATFORM_ERROR', '收尾返回状态无效，保留本地记录；只重查同一更新，不要重发游戏。', { updateId });
  if (await currentToken(platform) !== token) return { ...data, warning: changed() };
  try {
    await locked(store.file, async () => { const current = await read(store); if (current?.id === updateId) { await safeDirectory(store.directory); await unlink(store.file); } });
  } catch { return { ...data, warning: '更新已收尾，但本地记录未清除；下次需核对旧组已完成后再开始新任务。' }; }
  return data;
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const referencePattern = /^(update|build|publication|devlog):[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const validReference = value => typeof value === 'string' && referencePattern.test(value);
const timestamp = value => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
function validCursor(value) {
  if (typeof value !== 'string' || value.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return false;
    const cursor = JSON.parse(bytes.toString('utf8'));
    return record(cursor) && Object.keys(cursor).length === 2 && timestamp(cursor.at) && validReference(cursor.reference);
  } catch { return false; }
}
const updateHistoryError = () => failure('PLATFORM_ERROR', '平台返回的更新记录不完整，请重新读取；不要猜测记录编号或重复发布游戏。');
const historyAccountChanged = () => failure('ACCOUNT_CHANGED', '连接账号已变更，请回到原账号重新读取更新记录；不会向新账号重放删除。');

/** Read only the owned game's public release records; build/deployment details stay private. */
export async function getGameUpdates(platform, gameSlug, { cursor } = {}) {
  if (!slug(gameSlug) || cursor !== undefined && !validCursor(cursor)) return failure('INVALID_REQUEST', '请提供有效游戏标识，以及上次查询返回的原始 nextCursor。');
  const token = await platform.token?.();
  if (!token) return failure('AUTH_REQUIRED', '请先连接 AIWANNA 账号。');
  if (await currentToken(platform) !== token) return historyAccountChanged();
  const params = new URLSearchParams({ gameSlug, ...(cursor === undefined ? {} : { cursor }) });
  let data;
  try { data = await platform.request(`/api/developer/game-updates?${params}`, { method: 'GET', token }); }
  catch { return failure('UPDATE_STATUS_UNKNOWN', '无法读取更新记录，请重试同一查询；不要猜测编号或重新发布游戏。'); }
  if (await currentToken(platform) !== token) return historyAccountChanged();
  if (data?.error) return data;
  if (!record(data) || data.gameSlug !== gameSlug || !Array.isArray(data.updates) || data.updates.length > 200
    || data.nextCursor !== null && !validCursor(data.nextCursor)
    || data.updates.some(item => !record(item) || !validReference(item.reference)
      || item.version !== null && (typeof item.version !== 'string' || item.version.length > 40)
      || typeof item.title !== 'string' || typeof item.notes !== 'string' || !timestamp(item.createdAt))
    || new Set(data.updates.map(item => item.reference)).size !== data.updates.length) return updateHistoryError();
  return { gameSlug, updates: data.updates.map(({ reference, version, title, notes, createdAt }) => ({ reference, version, title, notes, createdAt })), nextCursor: data.nextCursor };
}

/** Remove only an author-selected public update. Never deletes a build, game or deployment. */
export async function deleteGameUpdate(platform, gameSlug, { reference, approved } = {}) {
  if (approved !== true) return failure('APPROVAL_REQUIRED', '只删除作者明确指定的更新记录；已有相同删除指令可直接沿用。');
  if (!slug(gameSlug) || !validReference(reference)) return failure('INVALID_REQUEST', '请使用 get_game_updates 返回的游戏和原始 reference，不要猜测编号。');
  const token = await platform.token?.();
  if (!token) return failure('AUTH_REQUIRED', '请先连接 AIWANNA 账号。');
  if (await currentToken(platform) !== token) return historyAccountChanged();
  let data;
  try { data = await platform.request('/api/developer/game-updates', { method: 'DELETE', token, body: { gameSlug, reference, approved: true } }); }
  catch { return failure('UPDATE_STATUS_UNKNOWN', '删除结果不明；先查询同一游戏，必要时仅重试相同 reference，不删除其他记录。', { gameSlug, reference }); }
  if (data?.error) return data;
  if (!record(data) || data.gameSlug !== gameSlug || data.reference !== reference || data.deleted !== true || typeof data.alreadyDeleted !== 'boolean') return updateHistoryError();
  const result = { gameSlug, reference, deleted: true, alreadyDeleted: data.alreadyDeleted };
  return await currentToken(platform) !== token ? { ...result, warning: historyAccountChanged() } : result;
}
