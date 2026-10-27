import { createHash } from 'node:crypto';
import { uploadPostImage } from './post-images.js';

// The author's community posts: read the ones about a game, change one the author picked (words and
// pictures), or send a new one the author asked for. The author approves the exact content first;
// there are no other limits than the site's own 发帖.
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

const storedPicture = value => typeof value === 'string' && /^[a-f0-9-]{36}\/[a-f0-9-]{36}\.webp$/.test(value);

// Pictures in order: stored ones (get_game_posts images[].path) stay, project files are uploaded.
async function pictures(platform, projectDirectory, list, post) {
  if (!Array.isArray(list) || list.length > 9 || list.some(item => typeof item !== 'string' || !item.trim())) return { error: failure('INVALID_REQUEST', '图片最多 9 张，每项是 get_game_posts 返回的图片 path 或项目里的图片路径。') };
  let token;
  const images = [];
  for (const item of list) {
    if (storedPicture(item)) { images.push({ path: item }); continue; }
    token ??= await platform.token?.();
    if (!token) return { error: failure('AUTH_REQUIRED', '请先运行 connect_platform，并由用户在浏览器确认授权。') };
    const uploaded = await uploadPostImage(platform, projectDirectory, item, post, token);
    if (uploaded.error) return { error: uploaded };
    images.push(uploaded.image);
  }
  return { images, token };
}

export async function editGamePost(platform, gameSlug, { postId, title, body, images, projectDirectory, approved } = {}) {
  if (approved !== true) return failure('APPROVAL_REQUIRED', '先把改好的完整标题、正文和图片给作者看，作者认可后再保存。');
  if (!slug(gameSlug) || !uuid(postId)) return failure('INVALID_REQUEST', '请使用 get_game_posts 返回的 postId，不要猜测编号。');
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120 || typeof body !== 'string' || body.trim().length > 5000) {
    return failure('INVALID_REQUEST', '标题必填、最多 120 字（作者在网站上发的帖子最多 30 字），正文最多 5000 字。');
  }
  let list;
  if (images !== undefined) { const result = await pictures(platform, projectDirectory, images, `post:${postId}`); if (result.error) return result.error; list = result.images; }
  let data;
  try { data = await platform.request('/api/developer/game-posts', { method: 'PATCH', body: { gameSlug, postId, title: title.trim(), body: body.trim(), ...(list ? { images: list } : {}), approved: true } }); }
  catch { return failure('POST_STATUS_UNKNOWN', '保存结果不明；用 get_game_posts 查看后，只对同一 postId 重试相同内容。', { gameSlug, postId }); }
  if (data?.error) return data;
  if (!record(data) || data.postId !== postId || data.saved !== true) return failure('PLATFORM_ERROR', '平台返回的保存结果不完整，请用 get_game_posts 核对。');
  return data;
}

// A new post, the same as 发帖 on the site. Pictures of one post land on the same stored files when
// the same content is sent again, so a retry does not store copies.
export async function createGamePost(platform, { gameSlug, kind, title, body = '', score, images = [], projectDirectory, approved } = {}) {
  if (approved !== true) return failure('APPROVAL_REQUIRED', '先把完整的标题、正文和图片给作者看，作者认可后再发。');
  if (gameSlug !== undefined && !slug(gameSlug)) return failure('INVALID_REQUEST', '请提供有效的游戏标识，或者不挂游戏。');
  if (!['guide', 'score', 'devlog', 'chat'].includes(kind)) return failure('INVALID_REQUEST', '类型是 guide（攻略）、score（晒战绩）、devlog（开发日志）或 chat（闲聊）。');
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 30 || typeof body !== 'string' || body.trim().length > 5000
    || score !== undefined && (typeof score !== 'string' || score.trim().length > 40)) return failure('INVALID_REQUEST', '标题必填、最多 30 字，正文最多 5000 字，成绩最多 40 字。');
  const nonce = createHash('sha256').update(JSON.stringify([gameSlug ?? '', kind, title.trim(), body.trim()])).digest('hex').slice(0, 32);
  const result = await pictures(platform, projectDirectory, images, `new:${nonce}`);
  if (result.error) return result.error;
  let data;
  try {
    data = await platform.request('/api/developer/game-posts', { method: 'POST', ...(result.token ? { token: result.token } : {}), body: {
      ...(gameSlug ? { gameSlug } : {}), kind, title: title.trim(), body: body.trim(), ...(kind === 'score' && score ? { score: score.trim() } : {}), images: result.images, approved: true } });
  } catch { return failure('POST_STATUS_UNKNOWN', '发帖结果不明；先到社区「最新」或 get_game_posts 查看，确认没发出去再重试。'); }
  if (data?.error) return data;
  if (!record(data) || !uuid(data.postId) || data.created !== true) return failure('PLATFORM_ERROR', '平台返回的发帖结果不完整，请到社区查看是否已发出。');
  return data;
}
