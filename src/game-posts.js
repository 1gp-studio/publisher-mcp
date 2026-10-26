// The author's own community posts about a game: read them, then change one the author picked.
const failure = (code, error, extra = {}) => ({ code, error, ...extra });
const slug = value => typeof value === 'string' && value.length <= 200 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function getGamePosts(platform, gameSlug) {
  if (!slug(gameSlug)) return failure('INVALID_REQUEST', '请提供有效的游戏标识。');
  let data;
  try { data = await platform.request(`/api/developer/game-posts?gameSlug=${encodeURIComponent(gameSlug)}`, { method: 'GET' }); }
  catch { return failure('POSTS_STATUS_UNKNOWN', '帖子暂时读取不了，请重试。'); }
  if (data?.error) return data;
  if (!record(data) || data.gameSlug !== gameSlug || !Array.isArray(data.posts)
    || data.posts.some(post => !record(post) || !uuid(post.postId) || typeof post.title !== 'string' || typeof post.body !== 'string')) {
    return failure('PLATFORM_ERROR', '平台返回的帖子不完整，请重新读取；不要猜测帖子编号。');
  }
  return data;
}

export async function editGamePost(platform, gameSlug, { postId, title, body, approved } = {}) {
  if (approved !== true) return failure('APPROVAL_REQUIRED', '先把改好的完整标题和正文给作者看，作者认可后再保存。');
  if (!slug(gameSlug) || !uuid(postId)) return failure('INVALID_REQUEST', '请使用 get_game_posts 返回的 postId，不要猜测编号。');
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || typeof body !== 'string' || body.trim().length > 5000) {
    return failure('INVALID_REQUEST', '标题必填、最多 120 字（作者在网站上发的帖子最多 30 字），正文最多 5000 字。');
  }
  let data;
  try { data = await platform.request('/api/developer/game-posts', { method: 'PATCH', body: { gameSlug, postId, title: title.trim(), body: body.trim(), approved: true } }); }
  catch { return failure('POST_STATUS_UNKNOWN', '保存结果不明；用 get_game_posts 查看后，只对同一 postId 重试相同内容。', { gameSlug, postId }); }
  if (data?.error) return data;
  if (!record(data) || data.postId !== postId || data.saved !== true) return failure('PLATFORM_ERROR', '平台返回的保存结果不完整，请用 get_game_posts 核对。');
  return data;
}
