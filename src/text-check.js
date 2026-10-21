import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename, join, sep } from 'node:path';
import { fontCoverage, letters, fontAdvice } from './fonts.js';
import { walk, supportedGameLanguages } from './languages.js';

// Checks translations against the game's own file before they are uploaded: the same keys, the same
// placeholders ({0}, {name}, %s), line breaks and separators the creator names, and lengths that fit
// (per key, from <original>.limits.json next to the original file: {"start": 12, "*": 40}, in display
// width: Chinese, Japanese and Korean characters count 2, others 1). Also whether the fonts the game
// ships can draw each language's letters.
async function projectFile(directory, path, max = 400000) {
  if (typeof path !== 'string' || !path) throw new Error('请提供项目内的语言文件路径。');
  const full = resolve(directory, path), inside = relative(directory, full);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`文件必须在项目目录里：${path}`);
  const stat = await lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error(`无法读取 ${path}`);
  const canonical = await realpath(full), resolved = relative(directory, canonical);
  if (resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) throw new Error(`文件必须在项目目录里：${path}`);
  const buffer = await readFile(canonical);
  if (buffer.length > max) throw new Error(`无法读取 ${path}（超过 ${Math.round(max / 1000)} KB）`);
  return { full: canonical, buffer };
}
function entries(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 要是 {"键名": "文字"} 的 JSON 对象。`);
  const items = Object.entries(value);
  if (items.length > 2000) throw new Error(`${name} 一个语言文件最多 2000 条。`);
  for (const [key, text] of items) {
    if (!/^[\w.:-]{1,120}$/.test(key)) throw new Error(`${name} 的键名「${key.slice(0, 40)}」不合规。`);
    if (typeof text !== 'string' || text.length > 2000) throw new Error(`${name} 的「${key}」要是不超过 2000 字的字符串。`);
  }
  return Object.fromEntries(items);
}
async function readJson(directory, path) {
  const data = JSON.parse((await projectFile(directory, path)).buffer.toString('utf8'));
  return entries(data, path);
}
async function readLimits(directory, path) {
  if (!path) return { limits: {} };
  const limitsPath = join(dirname(path), `${basename(path, '.json')}.limits.json`);
  let data;
  try { data = JSON.parse((await projectFile(directory, limitsPath, 100000)).buffer.toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { limits: {} }; throw error; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > 2001 || Object.entries(data).some(([key, limit]) => (key !== '*' && !/^[\w.:-]{1,120}$/.test(key)) || !Number.isSafeInteger(limit) || limit < 0)) throw new Error(`${limitsPath} 要是 {"键名": 非负整数上限} 的 JSON 对象。`);
  return { limits: data, limitsPath };
}
export const displayWidth = text => [...text].reduce((sum, char) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1), 0);
const placeholders = text => (text.match(/\{[\w.]*\}|%(?:\d+\$)?[sd]/g) ?? []).sort().join(' ');
const count = (text, part) => part ? text.split(part).length - 1 : 0;

export function checkTexts(original, translations, { separators = [], limits = {} } = {}) {
  const errors = [], warnings = [];
  for (const [locale, entries] of Object.entries(translations)) {
    for (const key of Object.keys(original)) if (!Object.hasOwn(entries, key)) errors.push({ locale, key, issue: 'missing', detail: '缺这个键' });
    for (const key of Object.keys(entries)) if (!Object.hasOwn(original, key)) warnings.push({ locale, key, issue: 'extra', detail: '原文里没有这个键（会被忽略）' });
    for (const [key, text] of Object.entries(entries)) {
      if (!Object.hasOwn(original, key)) continue;
      const source = original[key];
      if (placeholders(source) !== placeholders(text)) errors.push({ locale, key, issue: 'placeholders', detail: `占位符不一致：原文「${placeholders(source) || '无'}」，译文「${placeholders(text) || '无'}」` });
      if (count(source, '\n') !== count(text, '\n')) errors.push({ locale, key, issue: 'line-breaks', detail: `换行数不一致：原文 ${count(source, '\n')}，译文 ${count(text, '\n')}` });
      for (const part of separators) if (count(source, part) !== count(text, part)) errors.push({ locale, key, issue: 'separator', detail: `分隔符「${part}」数量不一致：原文 ${count(source, part)}，译文 ${count(text, part)}` });
      const limit = Object.hasOwn(limits, key) ? limits[key] : Object.hasOwn(limits, '*') ? limits['*'] : undefined;
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

// Shared preflight: read every file once and retain exactly the entries that passed validation.
// A platform original is passed as { locale, entries }; remote fields are never interpreted as paths.
export async function prepareGameText(projectDirectory, original, translations = [], options = {}) {
  if (!isAbsolute(projectDirectory)) return { error: '请提供当前游戏项目的绝对路径。' };
  let directory;
  try { directory = await realpath(resolve(projectDirectory)); } catch { return { error: '无法读取项目目录。' }; }
  let failed = original?.locale ?? 'original';
  try {
    if (!original || !supportedGameLanguages.includes(original.locale)) throw new Error('原始语言代码不受支持。');
    if (!Array.isArray(translations) || translations.length > supportedGameLanguages.length) throw new Error('译文列表格式不对。');
    const seen = new Set();
    for (const item of translations) {
      failed = item?.locale ?? 'translation';
      if (!item || !supportedGameLanguages.includes(item.locale)) throw new Error('译文语言代码不受支持。');
      if (item.locale === original.locale) return { error: '译文语言不能和原始语言相同。', code: 'ORIGINAL_CONFLICT', failed };
      if (seen.has(item.locale)) return { error: `译文语言重复：${item.locale}`, code: 'DUPLICATE_LOCALE', failed };
      seen.add(item.locale);
    }
    failed = original.locale;
    const fromMemory = Object.hasOwn(original, 'entries');
    const source = fromMemory ? entries(original.entries, '平台原文') : await readJson(directory, original.path);
    const sourceLimits = fromMemory ? { limits: {} } : await readLimits(directory, original.path);
    const loaded = [], errors = [], warnings = [], limitsFiles = [];
    if (sourceLimits.limitsPath) limitsFiles.push(sourceLimits.limitsPath);
    // An original-only upload still has to fit its own declared display-width limits.
    if (!fromMemory) errors.push(...checkTexts(source, { [original.locale]: source }, { limits: sourceLimits.limits }).errors);
    for (const item of translations) {
      failed = item.locale;
      const text = await readJson(directory, item.path), localLimits = await readLimits(directory, item.path);
      // Per-translation sidecars also work when the original lives only on the platform.
      const limits = { ...sourceLimits.limits, ...localLimits.limits };
      if (localLimits.limitsPath) limitsFiles.push(localLimits.limitsPath);
      const check = checkTexts(source, { [item.locale]: text }, { separators: options.separators ?? [], limits });
      errors.push(...check.errors); warnings.push(...check.warnings);
      loaded.push({ locale: item.locale, entries: text });
    }
    // Check the serialized request, not only the on-disk size (metadata and escaping add bytes).
    for (const item of [...(!fromMemory ? [{ locale: original.locale, kind: 'original', entries: source }] : []), ...loaded.map(item => ({ ...item, kind: 'translation', by: 'ai_creator' }))]) {
      failed = item.locale;
      if (Buffer.byteLength(JSON.stringify(item)) > 400000) throw new Error(`${item.locale} 的上传内容不能超过 400 KB。`);
    }
    const files = Object.fromEntries(loaded.map(item => [item.locale, item.entries]));
    const fonts = await fontGaps(directory, loaded.length ? files : { [original.locale]: source });
    const check = { ok: !errors.length, errors: errors.slice(0, 200), warnings: warnings.slice(0, 200), fonts,
      ...(sourceLimits.limitsPath ? { limitsFile: sourceLimits.limitsPath } : {}), ...(limitsFiles.length ? { limitsFiles } : {}),
      next: errors.length ? '先修好 errors 里的问题再上传。' : '可以上传。每种语言都打开游戏截图看一遍，确认按钮和文字没有撑破、没有方块字。' };
    return { original: { locale: original.locale, entries: source }, translations: loaded, check };
  } catch (error) { return { error: error.message, code: 'INVALID_LANGUAGE_FILE', failed }; }
}

export async function validateGameText(projectDirectory, original, translations = [], options = {}) {
  const prepared = await prepareGameText(projectDirectory, original, translations, options);
  return prepared.error ? prepared : prepared.check;
}
