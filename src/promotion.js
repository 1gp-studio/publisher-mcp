import { extname } from 'node:path';
import { inspectProjectFile, readProjectFile } from './media-files.js';

const genres = ['casual', 'puzzle', 'action', 'strategy', 'simulation', 'adventure', 'idle', 'rhythm'];
const limits = { manifestBytes: 65536, imageSourceBytes: 20 * 1024 * 1024, imageBytes: 2 * 1024 * 1024,
  imagePixels: 25000000, previewBytes: 20 * 1024 * 1024, mediaPathLength: 240, screenshots: 20, tags: 5, tagLength: 12, englishTagLength: 24 };
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const previewExtensions = new Set(['.gif', '.webp', '.mp4', '.webm']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validTags = (value, length = limits.tagLength) => Array.isArray(value) && value.length <= limits.tags
  && value.every(tag => typeof tag === 'string' && tag.trim().length > 0 && tag.trim().length <= length && !/[\p{Cc}\p{Cf},，#]/u.test(tag));
const webUrl = value => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};

// A manifest is a bounded inventory, never executable instructions. Do not search the repository,
// follow references outside the kit, read secrets, or load media bodies during preparation.
async function readLocalKit(projectDirectory) {
  let file;
  try { file = await readProjectFile(projectDirectory, '1gp-kit/game.json', limits.manifestBytes); }
  catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'unavailable', metadata: {}, media: {}, issues: error.code === 'ENOENT' ? [] : [{ field: 'manifest', code: 'UNSAFE_OR_UNREADABLE_KIT' }] }; }
  let data;
  try { data = JSON.parse(file.bytes.toString('utf8')); if (!record(data)) throw new Error('Invalid manifest'); }
  catch { return { state: 'invalid', metadata: {}, media: {}, issues: [{ field: 'manifest', code: 'INVALID_KIT_JSON' }] }; }
  const metadata = {}, media = {}, issues = [];
  const issue = (field, code) => issues.push({ field, code });
  if (Object.hasOwn(data, 'genre') && data.genre !== null) {
    if (genres.includes(data.genre)) metadata.genre = data.genre;
    else issue('genre', 'INVALID_GENRE');
  }
  for (const [field, length] of [['tags', limits.tagLength], ['tagsEn', limits.englishTagLength]]) {
    if (!Object.hasOwn(data, field)) continue;
    if (validTags(data[field], length)) metadata[field] = [...new Set(data[field].map(tag => tag.trim()))];
    else issue(field, 'INVALID_TAGS');
  }
  async function candidate(value, field, preview = false) {
    // Reject traversal, drive-relative paths and alternate streams on every host, including Linux.
    if (typeof value !== 'string' || !value || value.length > limits.mediaPathLength - '1gp-kit/'.length || /[\p{Cc}\p{Cf}:]/u.test(value)) { issue(field, 'INVALID_MEDIA_PATH'); return null; }
    const path = value.replaceAll('\\', '/');
    if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) { issue(field, 'INVALID_MEDIA_PATH'); return null; }
    if (!(preview ? previewExtensions : imageExtensions).has(extname(path).toLowerCase())) { issue(field, 'UNSUPPORTED_MEDIA_EXTENSION'); return null; }
    try {
      const found = await inspectProjectFile(projectDirectory, `1gp-kit/${path}`, preview ? limits.previewBytes : limits.imageSourceBytes);
      return { ...found, verified: false, contentTypeVerified: false, ...(preview ? {} : { requiresCompression: found.size > limits.imageBytes }) };
    } catch { issue(field, 'UNSAFE_MISSING_OR_OVERSIZED_MEDIA'); return null; }
  }
  if (Object.hasOwn(data, 'cover')) media.mainCover = await candidate(data.cover, 'cover');
  if (Object.hasOwn(data, 'screenshots')) {
    if (!Array.isArray(data.screenshots)) issue('screenshots', 'INVALID_SCREENSHOTS');
    else {
      if (data.screenshots.length > limits.screenshots) issue('screenshots', 'SCREENSHOT_LIMIT');
      const found = await Promise.all(data.screenshots.slice(0, limits.screenshots).map((path, i) => candidate(path, `screenshots[${i}]`)));
      media.screenshots = [...new Map(found.filter(Boolean).map(item => [item.relativePath, item])).values()];
    }
  }
  if (Object.hasOwn(data, 'preview')) media.preview = await candidate(data.preview, 'preview', true);
  return { state: 'available', path: '1gp-kit/game.json', metadata, media, issues };
}

function platformItem(key, materials) {
  const labels = materials.labels, media = materials.media;
  if (key === 'genre') {
    if (!record(labels) || !Object.hasOwn(labels, 'genre') || labels.genre !== null && !genres.includes(labels.genre)) return null;
    return labels.genre === null ? { missing: true } : { missing: false, value: labels.genre, source: labels.genreSource ?? 'platform' };
  }
  if (key === 'tags') {
    if (!record(labels) || !validTags(labels.tags)) return null;
    return { missing: labels.tags.length === 0, value: labels.tags, source: 'creator' };
  }
  if (!record(media) || !record(media[key])) return null;
  const item = media[key];
  if (key === 'preview' && item.disabled === true) return { missing: false, disabled: true };
  if (typeof item.missing !== 'boolean') return null;
  if (key === 'screenshots') {
    if (!Array.isArray(item.items) || !Number.isSafeInteger(item.count) || item.count < 0 || item.count !== item.items.length
      || item.fallback !== undefined && !Array.isArray(item.fallback)) return null;
    // The public gallery replaces its entire curated set as soon as author screenshots exist.
    const screenshots = item.items.length ? item.items : item.fallback ?? [];
    if (screenshots.some(shot => !record(shot) || !webUrl(shot.src)) || item.missing !== (screenshots.length === 0)) return null;
    return { missing: item.missing, count: item.count, displayedCount: screenshots.length,
      source: item.items.length ? 'uploaded' : screenshots.length ? 'curated' : 'missing',
      items: screenshots.map(shot => ({ ...(typeof shot.id === 'string' ? { id: shot.id } : {}), src: shot.src,
        ...(Number.isFinite(shot.width) ? { width: shot.width } : {}), ...(Number.isFinite(shot.height) ? { height: shot.height } : {}) })) };
  }
  if (item.missing ? item.src !== null : !webUrl(item.src)) return null;
  return { missing: item.missing, src: item.src, ...(key === 'mainCover' ? { source: item.source } : { kind: item.kind }) };
}

const nextSteps = {
  genre: '根据代码、规则和实玩证据选择一个最主要的玩法分类；保留已有作者选择。不凭项目名或框架猜分类。',
  tags: '根据主角、画风、核心玩法和操作方式拟定主语言标签；保留作者已有标签，避免重复分类。不确定的术语先核实，不能只凭升级系统就认定 Roguelike。',
  mainCover: '优先复用已有封面或项目授权美术；缺少时由宿主工具制作清楚可读的 16:9 主封面，建议 1600×900。多语言自动叠字另复用一张无字底图，不需要各语言截图。',
  screenshots: '优先复用真实截图；缺少时运行游戏，用宿主浏览器/computer use 截取 3–5 个不同实机状态，保持原比例。不得用生成图冒充游戏截图。',
  preview: '可选：优先复用已有真实玩法预览；否则由宿主录制或沿用已验证的捕获脚本，建议 12–18 秒、MP4/WebM/GIF/动态 WebP。可以剪辑真实片段，不捏造玩法或奖励，不强制接管时钟、改玩法或动玩家存档。',
};

/** Read-only store-material plan. Presence is not visual verification or consent to overwrite. */
export async function preparePromotion(projectDirectory, { gameSlug, materials } = {}) {
  const localKit = await readLocalKit(projectDirectory);
  const snapshot = !gameSlug ? 'new_game' : !record(materials) || materials.error ? 'unknown' : 'available';
  const candidates = { genre: localKit.metadata.genre ?? null, tags: localKit.metadata.tags?.length ? localKit.metadata.tags : null,
    mainCover: localKit.media.mainCover ?? null, screenshots: localKit.media.screenshots?.length ? localKit.media.screenshots : null, preview: localKit.media.preview ?? null };
  const items = {};
  for (const key of Object.keys(nextSteps)) {
    const saved = snapshot === 'available' ? platformItem(key, materials) : null;
    const state = snapshot === 'unknown' || snapshot === 'available' && saved === null ? 'unknown'
      : saved?.disabled ? 'author_disabled' : saved && !saved.missing ? 'existing' : candidates[key] ? 'local_candidate' : 'prepare_needed';
    items[key] = { state, verified: false, verificationRequired: state !== 'author_disabled', optional: key === 'preview',
      ...(saved ? { platform: saved } : {}), ...(candidates[key] ? { candidate: candidates[key] } : {}),
      ...(key === 'screenshots' ? { suggestedCount: { min: 3, max: 5 }, max: limits.screenshots,
        ...(state === 'existing' ? { additionalSuggested: saved.count > 0 ? Math.max(0, 3 - saved.count) : 0,
          ...(saved.source === 'curated' ? { replacementWarning: '现有展示来自精选截图；新增任意作者截图会替换整组精选展示。保留复用，不为了凑到 3–5 张自动上传。' } : {}) } : {}) } : {}),
      ...(key === 'preview' ? { suggestedSeconds: { min: 12, max: 18 }, durationVerified: false } : {}),
      nextStep: state === 'unknown' ? '先恢复或更新平台物料读取，确认已有内容；本地候选不能证明线上为空，不据此覆盖。'
        : state === 'author_disabled' ? '作者已关闭预览，保留此选择；只有明确要求才重新开启。'
          : state === 'existing' ? `复用平台已有物料；核对当前版本、内容和展示效果，未经作者要求不替换。${key === 'screenshots' && saved.count > 0 && saved.count < 3 ? '现有作者截图少于 3 张，建议补充不同实机状态达到 3–5 张；保留已有截图，避免重复上传。' : ''}${key === 'screenshots' && saved.source === 'curated' ? '现有精选截图应直接复用；新增作者图会替换整组精选展示，不为凑数自动上传。' : ''}`
            : nextSteps[key],
    };
  }
  const unknown = Object.keys(items).filter(key => items[key].state === 'unknown');
  return { snapshot, independentOfMultilingual: true, verified: false, verificationRequired: true,
    primaryLanguage: typeof materials?.original?.locale === 'string' ? materials.original.locale : null,
    availableGenres: [...genres], limits: { ...limits }, items, localKit,
    missing: Object.keys(items).filter(key => ['prepare_needed', 'local_candidate'].includes(items[key].state)), unknown,
    capabilities: { generatesImages: false, capturesScreenshots: false, recordsVideo: false, requiresHostTools: true },
    instructions: '这份清单独立于多语言选择；无需逐项询问用户。宿主 AI 根据项目与实玩证据准备缺项，集中展示可审阅的物料和真实阻碍，沿用已有授权。MCP 不自带截图、图像生成或录屏能力；本地文件仅核对路径和大小，不能证明真实玩法、画质、类型或视频时长。未知平台状态先恢复读取；已有素材先复用，作者关闭的预览保持关闭。没有捕获/图像/视频工具时如实列出未完成项，不伪造完成。新游戏先本地准备，取得真实游戏标识后再上传。仅更新平台物料不需要再次部署游戏；上传后实际打开封面、截图和预览检查，不能用 ready 或上传成功代替验证。',
  };
}
