import { snapshot } from './media.js';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const size = value => Number.isSafeInteger(value) && value >= 1 && value <= 4000;

// One picture for a community post (launch:<slug> or update:<id>), read from the project and sent
// as WebP. The same account, post and file always map to the same stored picture, so a retry
// neither stores a copy nor changes what the post compares against.
export async function uploadPostImage(platform, projectDirectory, path, post, token) {
  if (typeof path !== 'string' || !path.trim()) return { code: 'INVALID_IMAGE', error: 'image 需要项目内图片的相对路径。' };
  if (typeof projectDirectory !== 'string' || !projectDirectory) return { code: 'INVALID_IMAGE', error: '带图发帖需要 project_directory，图片路径相对于它。' };
  let file;
  try { file = await snapshot(projectDirectory, 'screenshot', path); }
  catch (error) { return { code: 'INVALID_IMAGE', error: error instanceof Error ? error.message : `无法读取 ${path}。` }; }
  const data = await platform.uploadBytes(`/api/developer/post-images?for=${encodeURIComponent(post)}`, file.bytes, { token, type: file.contentType, idempotencyKey: file.sha256 });
  if (record(data) && data.error) return data;
  if (!record(data) || typeof data.path !== 'string' || !/^[a-f0-9-]{36}\/[a-f0-9-]{36}\.webp$/.test(data.path)
    || !size(data.width) || !size(data.height) || typeof data.sig !== 'string' || !/^[a-f0-9]{64}$/.test(data.sig)) {
    return { code: 'PLATFORM_ERROR', error: '平台未返回完整的图片上传结果；请用同一文件重试，不要先发不带图的帖子。' };
  }
  return { image: { path: data.path, width: data.width, height: data.height, sig: data.sig }, file: file.path };
}
