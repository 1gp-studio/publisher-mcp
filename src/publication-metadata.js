import { getGameMaterials } from './materials.js';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const invalid = () => ({ code: 'PLATFORM_ERROR', error: '无法确认游戏现有标题和简介，未提交发布。请重新读取平台状态，不要用项目默认文案覆盖。' });

// Resolve the exact local-upload identity, including updates that omit gameSlug. Do not
// use a failed read or a missing named game as evidence that this is a first publication.
// Call with publishGameUpdate's account-bound client, before uploading any artifacts.
export async function localPublicationMetadata(platform, { projectId, gameSlug, title, description }, defaults) {
  const query = new URLSearchParams(gameSlug ? { slug: gameSlug } : { projectId });
  const context = await platform.request('/api/publish/releases/context?' + query);
  if (context?.error) return context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return invalid();
  if (!context.gameSlug) {
    if (gameSlug || context.previous !== null || context.source) return invalid();
    return { title: title ?? defaults.title, description: description ?? defaults.description ?? '' };
  }
  if (typeof context.gameSlug !== 'string' || !slugPattern.test(context.gameSlug) || gameSlug && gameSlug !== context.gameSlug) return invalid();
  if (context.source !== 'local') return { code: 'CHANNEL_MISMATCH', error: '这个游戏不是本地上传渠道，请沿用 prepare_game 返回的原发布方式。' };
  const materials = await getGameMaterials(platform, context.gameSlug);
  if (materials.error) return materials;
  const original = materials.original;
  if (materials.game.slug !== context.gameSlug || typeof original.title !== 'string' || !original.title.trim()
    || !Object.hasOwn(original, 'description') || original.description !== null && typeof original.description !== 'string') return invalid();
  return { gameSlug: context.gameSlug, title: title ?? original.title, description: description ?? original.description ?? '' };
}
