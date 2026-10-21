import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname, basename } from 'node:path';

// Covers per language (the edit page's 其他语言的封面, mock C45), through the same platform API:
// a base picture without text, a language's own cover, and per language main / gen (the base with
// the game's name in that language) / special, plus where the name goes.
const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
async function picture(directory, path) {
  const full = resolve(directory, path), inside = relative(directory, full);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`图片必须在项目目录里：${path}`);
  const stat = await lstat(full), type = types[extname(full).toLowerCase()];
  if (!stat.isFile() || stat.isSymbolicLink() || !type) throw new Error(`${path} 要是 PNG、JPG 或 WebP 图片。`);
  if (stat.size > 2 * 1024 * 1024) throw new Error(`${path} 超过 2 MB，先压缩（16:9，1280×720 就够）。`);
  return new File([await readFile(full)], basename(full), { type });
}

export async function setGameCovers(platform, projectDirectory, gameSlug, { base, special = {}, modes, position } = {}) {
  if (!isAbsolute(projectDirectory)) return { error: '请提供当前游戏项目的绝对路径。' };
  let directory;
  try { directory = await realpath(resolve(projectDirectory)); } catch { return { error: '无法读取项目目录。' }; }
  const path = `/api/games/${encodeURIComponent(gameSlug)}/covers`, uploaded = [];
  try {
    for (const [target, file] of [...(base ? [['base', base]] : []), ...Object.entries(special).map(([locale, file]) => [`special:${locale}`, file])]) {
      const form = new FormData();
      form.set('target', target);
      form.set('file', await picture(directory, file));
      const result = await platform.upload(path, form);
      if (result.error) return { ...result, uploaded, failed: target };
      uploaded.push(target);
    }
    if (modes || position) {
      const result = await platform.request(path, { method: 'PUT', body: { ...(position ? { position } : {}), modes: modes ?? {}, titles: {} } });
      if (result.error) return { ...result, uploaded };
    }
  } catch (error) { return { error: error.message, uploaded }; }
  return { ok: true, uploaded, message: '各语言封面已保存。生成的封面用这个语言的游戏名（set_game_details 可改）；没设置的语言用主封面。' };
}
