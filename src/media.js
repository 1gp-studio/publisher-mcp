import { createHash, randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { readProjectFile } from './media-files.js';
import { isPlatformOrigin } from './platform-origins.js';

const maxSource = 20 * 1024 * 1024, maxImage = 2 * 1024 * 1024, maxPixels = 25000000;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const previewTypes = { 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const currentToken = platform => (platform.currentToken ?? platform.token).call(platform);
const failure = (code, error) => ({ code, error });
const invalidResponse = () => failure('PLATFORM_ERROR', '平台未返回完整媒体保存结果；请检查物料后用相同文件恢复，不要另换文件重复添加。');
const accountChanged = () => failure('ACCOUNT_CHANGED', '连接账号已变更；已完成素材留在原账号下，请回到正确账号继续。');

export async function snapshot(projectDirectory, target, path) {
  const file = await readProjectFile(projectDirectory, path, maxSource);
  const type = await fileTypeFromBuffer(file.bytes).catch(() => undefined);
  if (!type || !(target === 'preview' ? Object.hasOwn(previewTypes, type.mime) : imageTypes.has(type.mime))) throw new Error(`${path} 的实际文件类型不支持；封面/截图需 JPG、PNG、WebP，预览需 GIF、WebP、MP4、WebM。`);
  let bytes = file.bytes, contentType = type.mime;
  if (type.mime.startsWith('image/')) {
    const input = sharp(bytes, { limitInputPixels: maxPixels, animated: false, failOn: 'error' });
    const metadata = await input.metadata();
    const height = metadata.pageHeight || metadata.height;
    if (!metadata.width || !height || metadata.width * height > maxPixels) throw new Error(`${path} 图片不能超过 2500 万像素。`);
    if (target === 'preview') {
      // Decode the first displayed frame without rewriting animation or losing timing/audio.
      await input.resize(1, 1).raw().toBuffer();
    } else {
      // Same shape limits as the platform, so large source captures need no manual compression.
      for (const quality of [85, 75, 65]) {
        bytes = await input.clone().rotate().resize(1600, target === 'cover' ? 1000 : 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality }).toBuffer();
        if (bytes.length <= maxImage) break;
      }
      if (!bytes.length || bytes.length > maxImage) throw new Error(`${path} 压缩后仍超过 2 MiB，请缩小图片后重试。`);
      contentType = 'image/webp';
    }
  }
  return { target, path: file.relativePath, bytes, contentType, sha256: fingerprint(bytes) };
}

function mediaSource(src, platform, target) {
  if (src === null) return true;
  if (typeof src !== 'string' || src.length > 2048) return false;
  try {
    const url = new URL(src, platform.origin);
    if (url.username || url.password || url.search || url.hash || !isPlatformOrigin(url.origin, platform.origin)) return false;
    const prefix = target === 'screenshot' ? '/api/game-shots/' : target === 'preview' ? '/api/game-previews/' : '/api/game-covers/';
    return url.pathname.startsWith(prefix) || target !== 'screenshot' && url.pathname.startsWith(target === 'preview' ? '/game-previews/' : '/game-covers/');
  } catch { return false; }
}

function savedResult(data, platform, target, signing = false) {
  if (record(data) && data.error) return data;
  if (!record(data) || data.ok !== true || typeof data.skipped !== 'boolean' || !mediaSource(data.src, platform, target)) return invalidResponse();
  if (signing && data.skipped === true) {
    if (!['EXISTING_MEDIA_PRESERVED', 'AUTHOR_DISABLED', 'IDEMPOTENT_REPLAY', 'CURRENT_MEDIA_CHANGED'].includes(data.reason)) return invalidResponse();
    return data;
  }
  if (typeof data.created !== 'boolean' || data.created && data.skipped || !data.skipped && data.src === null) return invalidResponse();
  if (target === 'screenshot' && (!uuid(data.id) || !Number.isSafeInteger(data.width) || data.width <= 0 || !Number.isSafeInteger(data.height) || data.height <= 0)) return invalidResponse();
  return data;
}

function uploadUrl(data, extension) {
  if (!record(data) || typeof data.path !== 'string' || !new RegExp(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.${extension}$`).test(data.path)
    || typeof data.signedUrl !== 'string' || data.signedUrl.length > 8192) return null;
  try {
    const url = new URL(data.signedUrl);
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.port || url.username || url.password || url.hash
      || url.pathname !== `/storage/v1/object/upload/sign/game-preview-uploads/${data.path}` || !url.searchParams.get('token') || [...url.searchParams.keys()].some(key => key !== 'token')) return null;
    return url.href;
  } catch { return null; }
}

async function uploadPreview(platform, slug, file, token, unchanged, fillMissing = true) {
  const path = `/api/games/${encodeURIComponent(slug)}/preview`, options = { token, idempotencyKey: file.sha256 };
  const signed = await platform.request(path, { ...options, body: { action: 'sign', type: file.contentType, size: file.bytes.length, fillMissing } });
  if (signed?.error) return signed;
  if (signed?.ok === true) return savedResult(signed, platform, 'preview', signed.skipped === true);
  if (!await unchanged()) return accountChanged();
  const target = uploadUrl(signed, previewTypes[file.contentType]);
  if (!target) return failure('UNSAFE_UPLOAD_URL', '平台返回的预览上传地址不符合可信存储合同，未发送媒体文件。');
  let response;
  try {
    // Never send the author bearer token to object storage, log its signed URL, or follow redirects.
    response = await fetch(target, { method: 'PUT', headers: { 'Content-Type': file.contentType, 'x-upsert': 'false' }, body: file.bytes, redirect: 'error', signal: AbortSignal.timeout(180000) });
  } catch { return failure('MEDIA_UPLOAD_UNKNOWN', '预览传输结果不明；保留相同文件恢复，不能重新生成素材或改用新标识。'); }
  if (!response.ok && response.status !== 409) return failure('MEDIA_UPLOAD_FAILED', `预览传输失败 (${response.status})；保留相同文件和内容指纹恢复。`);
  // A previous PUT may have completed before the client lost its response. Only the platform's
  // verified complete step may accept the existing staging object; a 409 is never success by itself.
  if (!await unchanged()) return accountChanged();
  const completed = await platform.request(path, { ...options, body: { action: 'complete', path: signed.path, fillMissing } });
  return savedResult(completed, platform, 'preview');
}

/** Upload reviewed, real local materials. Creates no screenshots, artwork or fictitious footage.
 *  replaceCover / replacePreview: the author explicitly asked for this cover or preview to replace the current one (the
 *  edit page's own replace); without them the main cover and the preview are only filled when missing. */
/** replaceScreenshots: the author asked for exactly these screenshots, in this order, instead of the current ones. */
export async function setGameMedia(platform, projectDirectory, gameSlug, { replaceScreenshots, replacementId, ...input } = {}) {
  if (replaceScreenshots === undefined && replacementId === undefined) return addGameMedia(platform, projectDirectory, gameSlug, input);
  if (replaceScreenshots !== true || !input.screenshots?.length || replacementId !== undefined && !uuid(replacementId)) return failure('INVALID_MEDIA', 'replaceScreenshots 只能为 true，并且要给出作者确认过的新截图 screenshots；重试保留返回的 replacementId。');
  const invalid = validateMediaInput(gameSlug, input);
  if (invalid) return invalid;
  const token = await platform.token?.();
  if (!token) return failure('AUTH_REQUIRED', '请先连接 AIWANNA 账号。');
  const unchanged = async () => await currentToken(platform) === token;
  const captured = new Map(), files = [], skipped = [], seen = new Set();
  let added = { uploaded: [], skipped: [] }, began = false, completed = false;
  const id = replacementId?.toLowerCase() ?? randomUUID();
  const stop = data => ({ code: data.code, error: data.error, ...(Number.isInteger(data.status) ? { status: data.status } : {}), ok: false,
    partial: completed || added.uploaded.length > 0, uploaded: added.uploaded, skipped: [...added.skipped, ...skipped], replacementId: id,
    verificationRequired: true, screenshotReplacementPending: began && !completed,
    message: '新截图只有全部准备好后才会整组生效，不会先清空旧截图。若结果不明，请读取 get_game_materials，并用相同 replacementId、文件和顺序重试；不要自动换批次覆盖其他编辑。' });
  try {
    // Capture EVERY selected file before beginning a server batch or changing any
    // cover/preview. The captured bytes are reused, not read again during upload.
    const selected = [...(input.cover ? [{ target: 'cover', path: input.cover }] : []), ...input.screenshots.map(path => ({ target: 'screenshot', path })), ...(input.preview ? [{ target: 'preview', path: input.preview }] : [])];
    for (const item of selected) {
      const file = await snapshot(projectDirectory, item.target, item.path);
      captured.set(`${item.target}:${item.path}`, file);
      if (item.target !== 'screenshot') continue;
      if (seen.has(file.sha256)) { skipped.push({ target: file.target, path: file.path, reason: 'DUPLICATE_SELECTION' }); continue; }
      seen.add(file.sha256); files.push(file);
    }
    if (!await unchanged()) return stop(accountChanged());
    if (input.cover || input.preview) {
      added = await addGameMedia(platform, projectDirectory, gameSlug, { ...input, screenshots: [] }, { token, captured });
      if (added.error) return stop(added);
    }
    const path = `/api/games/${encodeURIComponent(gameSlug)}/screenshots/replace`;
    const validItem = (item, file) => record(item) && item.key === file.sha256 && uuid(item.id) && typeof item.ready === 'boolean' && typeof item.reused === 'boolean'
      && mediaSource(item.src, platform, 'screenshot') && item.src !== null
      && (!item.ready || Number.isSafeInteger(item.width) && item.width > 0 && Number.isSafeInteger(item.height) && item.height > 0);
    const validBatch = data => record(data) && data.ok === true && data.replacementId === id && typeof data.complete === 'boolean'
      && Array.isArray(data.items) && data.items.length === files.length && data.items.every((item, index) => validItem(item, files[index]))
      && new Set(data.items.map(item => item.id)).size === files.length;
    if (!await unchanged()) return stop(accountChanged());
    began = true; // Also expose the ID when the begin response itself is lost.
    let batch = await platform.request(path, { token, body: { action: 'begin', replacementId: id, keys: files.map(file => file.sha256) } });
    if (batch?.error) return stop(batch);
    if (!validBatch(batch)) return stop(invalidResponse());
    if (!batch.complete) {
      for (const [index, file] of files.entries()) {
        if (!await unchanged()) return stop(accountChanged());
        if (batch.items[index].ready) continue;
        const data = await platform.uploadBytes(`${path}?replacementId=${id}`, file.bytes, { token, type: file.contentType, idempotencyKey: file.sha256 });
        if (data?.error) return stop(data);
        if (data?.ok !== true || data.replacementId !== id || !validItem(data.item, file) || !data.item.ready) return stop(invalidResponse());
      }
      if (!await unchanged()) return stop(accountChanged());
      batch = await platform.request(path, { token, body: { action: 'complete', replacementId: id } });
      if (batch?.error) return stop(batch);
    }
    if (!validBatch(batch) || !batch.complete || batch.items.some(item => !item.ready) || !Array.isArray(batch.removedScreenshots) || !batch.removedScreenshots.every(uuid)
      || !Array.isArray(batch.screenshotOrder) || JSON.stringify(batch.screenshotOrder) !== JSON.stringify(batch.items.map(item => item.id))) return stop(invalidResponse());
    completed = true;
    for (const [index, item] of batch.items.entries()) {
      const value = { target: 'screenshot', path: files[index].path, id: item.id, src: item.src };
      if (item.reused || batch.replayed) skipped.push({ ...value, reason: 'IDEMPOTENT_REPLAY' });
      else added.uploaded.push({ ...value, created: true });
    }
    if (!await unchanged()) return stop(accountChanged());
    return { ok: true, partial: false, uploaded: added.uploaded, skipped: [...added.skipped, ...skipped], replacementId: id,
      removedScreenshots: batch.removedScreenshots, screenshotOrder: batch.screenshotOrder, verificationRequired: true,
      message: '已整组替换截图；同内容保留原截图 ID。请读取 get_game_materials 并实际查看截图。重试保留 replacementId 和原文件。' };
  } catch (error) { return stop(failure(began ? 'MEDIA_REPLACEMENT_UNKNOWN' : 'INVALID_MEDIA', error instanceof Error ? error.message : '无法安全读取或验证素材。')); }
}

function validateMediaInput(gameSlug, { cover, screenshots = [], preview, fillMissing = true, replaceCover, replacePreview } = {}) {
  if (typeof gameSlug !== 'string' || gameSlug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameSlug)
    || fillMissing !== true || !Array.isArray(screenshots) || screenshots.length > 20 || !cover && !preview && !screenshots.length) return failure('INVALID_MEDIA', '请提供真实游戏标识及至少一份素材；截图最多 20 张，主封面和预览只补缺失。');
  if (replaceCover !== undefined && (replaceCover !== true || !cover)) return failure('INVALID_MEDIA', 'replaceCover 只能为 true，并且要同时给出作者确认过的新主封面 cover。');
  if (replacePreview !== undefined && (replacePreview !== true || !preview)) return failure('INVALID_MEDIA', 'replacePreview 只能为 true，并且要同时给出作者确认过的新预览 preview。');
  return null;
}

async function addGameMedia(platform, projectDirectory, gameSlug, { cover, screenshots = [], preview, fillMissing = true, replaceCover, replacePreview } = {}, prepared) {
  const invalid = validateMediaInput(gameSlug, { cover, screenshots, preview, fillMissing, replaceCover, replacePreview });
  if (invalid) return invalid;
  const token = prepared?.token ?? await platform.token?.();
  if (!token) return failure('AUTH_REQUIRED', '请先连接 AIWANNA 账号。');
  const unchanged = async () => await currentToken(platform) === token;
  const selected = [...(cover ? [{ target: 'cover', path: cover }] : []), ...screenshots.map(path => ({ target: 'screenshot', path })), ...(preview ? [{ target: 'preview', path: preview }] : [])].map((item, index) => ({ ...item, index }));
  const uploaded = [], skipped = [], files = [], seen = new Set(), completed = new Set();
  let active;
  const stop = data => ({ code: data.code, error: data.error, ...(Number.isInteger(data.status) ? { status: data.status } : {}), ok: false, partial: uploaded.length > 0 || skipped.some(item => item.reason !== 'DUPLICATE_SELECTION'), uploaded, skipped,
    failed: active ? { target: active.target, path: active.path } : null,
    pending: selected.filter(item => !completed.has(item.index)).map(({ target, path }) => ({ target, path })),
    verificationRequired: true });
  try {
    // Every selected file is safely captured, MIME checked and decoded/normalized before any write.
    for (const item of selected) {
      active = item;
      const file = { ...(prepared?.captured.get(`${item.target}:${item.path}`) ?? await snapshot(projectDirectory, item.target, item.path)), index: item.index }, key = `${file.target}:${file.sha256}`;
      item.path = file.path;
      if (seen.has(key)) { skipped.push({ target: file.target, path: file.path, reason: 'DUPLICATE_SELECTION' }); completed.add(file.index); continue; }
      seen.add(key); files.push(file);
    }
    for (const file of files) {
      active = file;
      if (!await unchanged()) return stop(accountChanged());
      const path = `/api/games/${encodeURIComponent(gameSlug)}/${file.target === 'cover' ? replaceCover ? 'cover' : 'cover?fillMissing=true' : 'screenshots'}`;
      const raw = file.target === 'preview' ? await uploadPreview(platform, gameSlug, file, token, unchanged, !replacePreview)
        : await platform.uploadBytes(path, file.bytes, { token, type: file.contentType, idempotencyKey: file.sha256 });
      const data = file.target === 'preview' ? raw : savedResult(raw, platform, file.target);
      if (data?.error) return stop(data);
      const item = { target: file.target, path: file.path, src: data.src, ...(data.id ? { id: data.id } : {}), ...(data.reason ? { reason: data.reason } : {}) };
      if (data.skipped) skipped.push(item); else uploaded.push({ ...item, created: data.created });
      completed.add(file.index);
      if (!await unchanged()) return stop(accountChanged());
    }
  } catch (error) { return stop(failure('INVALID_MEDIA', error instanceof Error ? error.message : '无法安全读取或验证素材。')); }
  return { ok: true, partial: false, uploaded, skipped, verificationRequired: true,
    message: [replaceCover ? '已按作者要求替换主封面' : '主封面只补缺失', replacePreview ? '已按作者要求替换预览' : '预览只补缺失'].join('，')
      + '；截图只追加且相同内容不重复，删除或排序用 edit_game_media。请读取 get_game_materials，并实际查看主封面、截图和预览；上传成功不代表画面或玩法已验证。' };
}

/** The edit page's other media changes, only on the author's explicit request: delete screenshots (by the ids
 *  get_game_materials returns), put screenshots in a new order (the given ids first, the rest keep their order), and
 *  take the preview down. To replace the complete screenshot set atomically, use set_game_media with replaceScreenshots. */
export async function editGameMedia(platform, gameSlug, { removeScreenshots = [], screenshotOrder, removePreview } = {}) {
  if (typeof gameSlug !== 'string' || gameSlug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameSlug)) return failure('INVALID_GAME_SLUG', '请提供有效的游戏标识。');
  const ids = list => Array.isArray(list) && list.length <= 20 && list.every(uuid) && new Set(list).size === list.length;
  if (!ids(removeScreenshots) || screenshotOrder !== undefined && (!ids(screenshotOrder) || !screenshotOrder.length) || removePreview !== undefined && removePreview !== true
    || !removeScreenshots.length && !screenshotOrder && !removePreview) return failure('INVALID_MEDIA', '请给出要删除的截图 id、新的截图顺序或 removePreview:true；截图 id 来自 get_game_materials。');
  if (screenshotOrder?.some(id => removeScreenshots.includes(id))) return failure('INVALID_MEDIA', '同一张截图不能既删除又排序。');
  const token = await platform.token?.();
  if (!token) return failure('AUTH_REQUIRED', '请先连接 AIWANNA 账号。');
  const base = `/api/games/${encodeURIComponent(gameSlug)}`, removed = [], missing = [];
  const done = extra => ({ removedScreenshots: removed, ...(missing.length ? { notFound: missing } : {}), ...extra });
  for (const id of removeScreenshots) {
    if (await currentToken(platform) !== token) return { ...accountChanged(), ...done({ ok: false }) };
    const result = await platform.request(`${base}/screenshots?id=${id}`, { method: 'DELETE', token });
    if (result?.ok === true) removed.push(id);
    else if (result?.status === 404 || result?.error === '找不到这张截图。') missing.push(id);
    else return { ...(result?.error ? result : invalidResponse()), ...done({ ok: false }) };
  }
  let order;
  if (screenshotOrder) {
    const materials = await platform.request(`/api/developer/game-materials/${encodeURIComponent(gameSlug)}`);
    const current = materials?.media?.screenshots?.items;
    if (!Array.isArray(current)) return { ...(materials?.error ? materials : invalidResponse()), ...done({ ok: false }) };
    const known = current.map(item => item.id);
    const unknown = screenshotOrder.filter(id => !known.includes(id));
    if (unknown.length) return { ...failure('UNKNOWN_SCREENSHOT', '排序里有不属于这个游戏的截图 id，请重新读取 get_game_materials。'), unknown, ...done({ ok: false }) };
    order = [...screenshotOrder, ...known.filter(id => !screenshotOrder.includes(id))];
    const result = await platform.request(`${base}/screenshots`, { method: 'PATCH', body: { order }, token });
    if (result?.ok !== true) return { ...(result?.error ? result : invalidResponse()), ...done({ ok: false }) };
  }
  if (removePreview) {
    const result = await platform.request(`${base}/preview`, { body: { action: 'remove' }, token });
    if (result?.ok !== true) return { ...(result?.error ? result : invalidResponse()), ...done({ ok: false, ...(order ? { screenshotOrder: order } : {}) }) };
  }
  return { ok: true, ...done({ ...(order ? { screenshotOrder: order } : {}), ...(removePreview ? { previewRemoved: true } : {}) }),
    message: '已按作者要求修改。请读取 get_game_materials 并实际查看游戏页的截图和预览。' };
}
