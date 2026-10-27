import { lstat, realpath } from 'node:fs/promises';
import { resolve, extname, basename, join, parse, isAbsolute, sep } from 'node:path';
import { snapshot } from './media.js';

// Covers per language (the edit page's 其他语言的封面, mock C45), through the same platform API:
// a base picture without text, a language's own cover, and per language main / gen (the base with
// the game's name in that language) / special, plus where the name goes.
async function plainDirectory(path) {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('图片目录不能经过符号链接或目录联接。');
  }
}
// Read safely and compress like the main cover (media.js): large captures fit the 2 MB upload.
async function picture(directory, path) {
  const { bytes } = await snapshot(directory, 'cover', path);
  return new File([bytes], `${basename(path, extname(path))}.webp`, { type: 'image/webp' });
}

export async function setGameCovers(platform, projectDirectory, gameSlug, { base, special = {}, modes, position, fillMissing } = {}) {
  if (!isAbsolute(projectDirectory)) return { error: '请提供当前游戏项目的绝对路径。' };
  let directory;
  try { await plainDirectory(resolve(projectDirectory)); directory = await realpath(resolve(projectDirectory)); } catch { return { error: '无法安全读取项目目录（不能经过符号链接或目录联接）。' }; }
  // preserved: pictures the platform kept instead (fillMissing never replaces the author's own).
  const path = `/api/games/${encodeURIComponent(gameSlug)}/covers`, uploaded = [], preserved = [];
  const token = typeof platform.token === 'function' ? await platform.token() : undefined;
  if (token === null || token === '') return { code: 'AUTH_REQUIRED', error: '请先运行 connect_platform，并由用户在浏览器确认授权。', uploaded };
  const changed = async () => token !== undefined && await platform.token() !== token;
  const changedError = () => ({ code: 'ACCOUNT_CHANGED', error: '连接账号已变更；已完成的封面保留在原账号下，请在正确账号中查询后继续。', uploaded });
  let failed = 'files', settingsResult;
  try {
    // Validate and snapshot the whole selection before uploading even the first picture.
    const pictures = [];
    for (const [target, file] of [...(base ? [['base', base]] : []), ...Object.entries(special).map(([locale, file]) => [`special:${locale}`, file])]) {
      failed = target;
      pictures.push({ target, file: await picture(directory, file) });
    }
    for (const { target, file } of pictures) {
      failed = target;
      if (await changed()) return { ...changedError(), failed };
      const form = new FormData();
      form.set('target', target);
      form.set('file', file);
      if (fillMissing) form.set('fillMissing', 'true');
      const result = await platform.upload(path, form, { token });
      if (!result || typeof result !== 'object' || Array.isArray(result)) return { code: 'PLATFORM_ERROR', error: '平台返回异常上传响应，请先查询封面状态。', uploaded, failed };
      if (result.error) return { ...result, uploaded, failed };
      if (typeof result.path !== 'string' || !result.path) return { code: 'PLATFORM_ERROR', error: '平台没有返回图片保存位置，请先查询封面状态。', uploaded, failed };
      if (result.skipped === true) preserved.push({ target, reason: typeof result.reason === 'string' ? result.reason : 'AUTHOR_COVER_PRESERVED' });
      else uploaded.push(target);
    }
    if (await changed()) return { ...changedError(), failed: modes || position ? 'settings' : 'account' };
    if (modes || position) {
      failed = 'settings';
      const result = await platform.request(path, { method: 'PUT', token, body: { ...(position ? { position } : {}), modes: modes ?? {}, titles: {}, ...(fillMissing !== undefined ? { fillMissing } : {}) } });
      if (!result || typeof result !== 'object' || Array.isArray(result)) return { code: 'PLATFORM_ERROR', error: '平台返回异常保存响应，请先查询封面状态。', uploaded, failed };
      if (result.error) return { ...result, uploaded, failed };
      if (result.ok !== true) return { code: 'PLATFORM_ERROR', error: '平台未确认封面设置已保存，请先查询封面状态。', uploaded, failed };
      settingsResult = result;
      if (await changed()) return { ...changedError(), failed: 'account', settingsSaved: true };
    }
  } catch (error) { return { error: error.message, uploaded, failed }; }
  return { ...settingsResult, ok: true, uploaded, ...(preserved.length ? { preserved } : {}), verificationRequired: true, message: preserved.length
    ? `作者已有的图片保留未换：${preserved.map(item => item.target).join('、')}（fillMissing 只补缺）。不要告诉作者已换图。`
    : settingsResult?.partial
    ? '已保存可以完成的封面设置；部分语言仍缺少必要物料，请查看 skipped 并补齐，尚未完成的预览可能仍回退主封面。'
    : '已处理提交的封面设置。请用 get_game_materials 查看实际模式并检查预览；保存成功不代表生成图片已验证。' };
}
