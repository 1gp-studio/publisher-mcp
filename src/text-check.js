import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path';
import { fontCoverage, letters, fontAdvice } from './fonts.js';
import { walk } from './languages.js';

// Checks translations against the game's own file before they are uploaded: the same keys, the same
// placeholders ({0}, {name}, %s), line breaks and separators the creator names, and lengths that fit
// (per key, from <original>.limits.json next to the original file: {"start": 12, "*": 40}, in display
// width: Chinese, Japanese and Korean characters count 2, others 1). Also whether the fonts the game
// ships can draw each language's letters.
async function projectFile(directory, path, max = 400000) {
  const full = resolve(directory, path), inside = relative(directory, full);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`文件必须在项目目录里：${path}`);
  const stat = await lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error(`无法读取 ${path}`);
  return { full, buffer: await readFile(full) };
}
async function readJson(directory, path) {
  const data = JSON.parse((await projectFile(directory, path)).buffer.toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.values(data).every(value => typeof value === 'string')) throw new Error(`${path} 要是 {"键名": "文字"} 的 JSON 对象。`);
  return data;
}
export const displayWidth = text => [...text].reduce((sum, char) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1), 0);
const placeholders = text => (text.match(/\{[\w.]*\}|%(?:\d+\$)?[sd]/g) ?? []).sort().join(' ');
const count = (text, part) => part ? text.split(part).length - 1 : 0;

export function checkTexts(original, translations, { separators = [], limits = {} } = {}) {
  const errors = [], warnings = [];
  for (const [locale, entries] of Object.entries(translations)) {
    for (const key of Object.keys(original)) if (!(key in entries)) errors.push({ locale, key, issue: 'missing', detail: '缺这个键' });
    for (const key of Object.keys(entries)) if (!(key in original)) warnings.push({ locale, key, issue: 'extra', detail: '原文里没有这个键（会被忽略）' });
    for (const [key, text] of Object.entries(entries)) {
      const source = original[key];
      if (source === undefined) continue;
      if (placeholders(source) !== placeholders(text)) errors.push({ locale, key, issue: 'placeholders', detail: `占位符不一致：原文「${placeholders(source) || '无'}」，译文「${placeholders(text) || '无'}」` });
      if (count(source, '\n') !== count(text, '\n')) errors.push({ locale, key, issue: 'line-breaks', detail: `换行数不一致：原文 ${count(source, '\n')}，译文 ${count(text, '\n')}` });
      for (const part of separators) if (count(source, part) !== count(text, part)) errors.push({ locale, key, issue: 'separator', detail: `分隔符「${part}」数量不一致：原文 ${count(source, part)}，译文 ${count(text, part)}` });
      const limit = limits[key] ?? limits['*'];
      const width = displayWidth(text);
      if (typeof limit === 'number' && width > limit) errors.push({ locale, key, issue: 'too-long', detail: `显示宽度 ${width}，上限 ${limit}` });
      else if (limit === undefined && displayWidth(source) >= 4 && width > displayWidth(source) * 2.5) warnings.push({ locale, key, issue: 'long', detail: `显示宽度 ${width}，原文 ${displayWidth(source)}：按钮等固定宽度的地方可能放不下` });
    }
  }
  return { errors, warnings };
}

// The fonts the game ships, and which letters of each translation none of them has.
export async function fontGaps(directory, translations) {
  const fonts = [];
  for await (const path of walk(directory)) {
    if (!/\.(?:woff2?|ttf|otf)$/i.test(path) || fonts.length >= 30) continue;
    try { const coverage = fontCoverage((await projectFile(directory, path, 30_000_000)).buffer); if (coverage) fonts.push({ path, coverage }); } catch { /* Not a font we can read. */ }
  }
  if (!fonts.length) return { fonts: [], gaps: [], note: '游戏没有打包字体，用的是系统字体：各语言一般都能显示，但不同设备上样子会不一样。' };
  const gaps = [];
  for (const [locale, entries] of Object.entries(translations)) {
    const missing = letters(Object.values(entries).join('')).filter(char => !fonts.some(font => font.coverage.has(char.codePointAt(0))));
    if (missing.length) gaps.push({ locale, missing: missing.slice(0, 30).join(''), count: missing.length, advice: fontAdvice[locale] ?? '换一个包含这种语言文字的字体（如 Noto Sans 对应语言版本）。' });
  }
  return { fonts: fonts.map(font => font.path), gaps };
}

export async function validateGameText(projectDirectory, original, translations = [], options = {}) {
  if (!isAbsolute(projectDirectory)) return { error: '请提供当前游戏项目的绝对路径。' };
  let directory;
  try { directory = await realpath(resolve(projectDirectory)); } catch { return { error: '无法读取项目目录。' }; }
  try {
    const source = await readJson(directory, original.path);
    const files = Object.fromEntries(await Promise.all(translations.map(async item => [item.locale, await readJson(directory, item.path)])));
    let limits = {};
    const limitsPath = join(dirname(original.path), `${basename(original.path, '.json')}.limits.json`);
    try { limits = JSON.parse((await projectFile(directory, limitsPath, 100000)).buffer.toString('utf8')); } catch { /* No length limits. */ }
    const { errors, warnings } = checkTexts(source, files, { separators: options.separators ?? [], limits });
    const fonts = await fontGaps(directory, files);
    return { ok: !errors.length, errors: errors.slice(0, 200), warnings: warnings.slice(0, 200), fonts, ...(Object.keys(limits).length ? { limitsFile: limitsPath } : {}),
      next: errors.length ? '先修好 errors 里的问题再上传。' : '可以上传。每种语言都打开游戏截图看一遍，确认按钮和文字没有撑破、没有方块字。' };
  } catch (error) { return { error: error.message }; }
}
