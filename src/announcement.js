import { isPlatformOrigin } from './platform-origins.js';
const pathFor = slug => {
  if (typeof slug !== 'string' || slug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Invalid game slug');
  return `/api/developer/game-announcement/${encodeURIComponent(slug)}`;
};
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const publicUrl = (value, platform) => {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && isPlatformOrigin(url.origin, platform.origin) && !url.username && !url.password; }
  catch { return false; }
};
const invalid = () => ({ code: 'PLATFORM_ERROR', error: '平台返回的宣传状态不完整，请先查询原任务；不要重新发布游戏或重复发帖。' });

export async function getGameAnnouncement(platform, slug) {
  const result = await platform.request(pathFor(slug));
  if (!record(result)) return invalid();
  if (result.error) return result;
  const post = result.announcement;
  if (!record(result.game) || !uuid(result.game.id) || result.game.slug !== slug || !publicUrl(result.game.url, platform)
    || typeof result.ready !== 'boolean' || typeof result.eligible !== 'boolean' || !record(post)
    || !['missing', 'published', 'removed'].includes(post.status)) return invalid();
  if (post.status !== 'missing' && !uuid(post.id) || post.status === 'published' && !publicUrl(post.url, platform)) return invalid();
  if (result.launchReference !== null && (typeof result.launchReference !== 'string'
    || !/^(build|publication):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.launchReference))) return invalid();
  if (result.eligible && (!result.ready || post.status !== 'missing' || !result.launchReference
    || !record(result.draft) || typeof result.draft.title !== 'string' || typeof result.draft.body !== 'string')) return invalid();
  return result;
}

export async function publishGameAnnouncement(platform, slug, input) {
  if (input?.approved !== true) throw new Error('Only publish the exact announcement content explicitly approved by the author.');
  const result = await platform.request(pathFor(slug), { method: 'POST', body: input });
  if (!record(result)) return invalid();
  if (result.error) return result;
  return uuid(result.id) && publicUrl(result.url, platform) && result.status === 'published' && typeof result.created === 'boolean' ? result : invalid();
}
