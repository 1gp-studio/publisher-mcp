import { brotliDecompressSync, inflateSync } from 'node:zlib';

// Which characters a font file can draw: the cmap table of a TTF/OTF, WOFF or WOFF2 file, as ranges
// of code points. Used to warn when a game's bundled fonts lack the letters of a language it is
// translated into (they then fall back to a system font, or show as boxes on some devices).
const tag = (buffer, at) => buffer.toString('latin1', at, at + 4);

function sfntTables(buffer) {
  let base = 0;
  if (tag(buffer, 0) === 'ttcf') base = buffer.readUInt32BE(12);
  const count = buffer.readUInt16BE(base + 4), tables = {};
  for (let index = 0; index < count; index++) {
    const at = base + 12 + index * 16;
    tables[tag(buffer, at)] = buffer.subarray(buffer.readUInt32BE(at + 8), buffer.readUInt32BE(at + 8) + buffer.readUInt32BE(at + 12));
  }
  return tables;
}

function woffTables(buffer) {
  const count = buffer.readUInt16BE(12), tables = {};
  for (let index = 0; index < count; index++) {
    const at = 44 + index * 20, offset = buffer.readUInt32BE(at + 4), compressed = buffer.readUInt32BE(at + 8), original = buffer.readUInt32BE(at + 12);
    const data = buffer.subarray(offset, offset + compressed);
    tables[tag(buffer, at)] = compressed < original ? inflateSync(data) : data;
  }
  return tables;
}

// WOFF2: one Brotli stream holding every table in directory order; only glyf/loca are transformed,
// and the cmap is never, so it can be read straight from the stream.
const knownTags = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];
function woff2Tables(buffer) {
  if (tag(buffer, 4) === 'ttcf') return null;
  const count = buffer.readUInt16BE(12), compressedLength = buffer.readUInt32BE(20);
  let at = 48;
  const base128 = () => { let value = 0; for (let index = 0; index < 5; index++) { const byte = buffer[at++]; value = value * 128 + (byte & 0x7f); if (!(byte & 0x80)) return value; } throw new Error('Bad WOFF2'); };
  const entries = [];
  for (let index = 0; index < count; index++) {
    const flags = buffer[at++];
    const name = (flags & 0x3f) === 0x3f ? (at += 4, tag(buffer, at - 4)) : knownTags[flags & 0x3f];
    const original = base128(), version = (flags >> 6) & 3;
    const transformed = name === 'glyf' || name === 'loca' ? version === 0 : version !== 0;
    entries.push({ name, length: transformed ? base128() : original });
  }
  const stream = brotliDecompressSync(buffer.subarray(at, at + compressedLength));
  const tables = {};
  let offset = 0;
  for (const entry of entries) { tables[entry.name] = stream.subarray(offset, offset + entry.length); offset += entry.length; }
  return tables;
}

function cmapRanges(cmap) {
  const count = cmap.readUInt16BE(2), subtables = [];
  for (let index = 0; index < count; index++) {
    const at = 4 + index * 8, platform = cmap.readUInt16BE(at), encoding = cmap.readUInt16BE(at + 2), offset = cmap.readUInt32BE(at + 4);
    subtables.push({ platform, encoding, offset, format: cmap.readUInt16BE(offset) });
  }
  const pick = subtables.find(item => item.format === 12) ?? subtables.find(item => item.format === 4 && (item.platform === 3 || item.platform === 0));
  if (!pick) return [];
  const ranges = [];
  if (pick.format === 12) {
    const groups = cmap.readUInt32BE(pick.offset + 12);
    for (let index = 0; index < groups; index++) { const at = pick.offset + 16 + index * 12; ranges.push([cmap.readUInt32BE(at), cmap.readUInt32BE(at + 4)]); }
  } else {
    const segments = cmap.readUInt16BE(pick.offset + 6) / 2, ends = pick.offset + 14, starts = ends + segments * 2 + 2;
    for (let index = 0; index < segments; index++) {
      const end = cmap.readUInt16BE(ends + index * 2), start = cmap.readUInt16BE(starts + index * 2);
      if (start !== 0xffff) ranges.push([start, end]);
    }
  }
  return ranges;
}

export function fontCoverage(buffer) {
  const kind = tag(buffer, 0);
  const tables = kind === 'wOF2' ? woff2Tables(buffer) : kind === 'wOFF' ? woffTables(buffer) : sfntTables(buffer);
  const cmap = tables?.cmap;
  if (!cmap?.length) return null;
  const ranges = cmapRanges(cmap);
  return { ranges, has: codePoint => ranges.some(([start, end]) => codePoint >= start && codePoint <= end) };
}

// Characters that are drawn as letters (not spaces, digits or punctuation shared by every font).
export const letters = text => [...new Set([...text].filter(char => /\p{L}/u.test(char)))];

// Which font to suggest when a language's letters are missing.
export const fontAdvice = {
  zh: '简体中文：Noto Sans SC（或思源黑体），只打包用到的字（子集）即可。',
  'zh-Hant': '繁体中文：Noto Sans TC；很多手写体、像素中文字体只有简体字。',
  ja: '日文：Noto Sans JP（假名在简体中文字体里通常没有或不全）。',
  ko: '韩文：Noto Sans KR（谚文在中文、日文字体里大多没有）。',
  ru: '俄文：Noto Sans 或带西里尔字母的像素字体。',
  en: '拉丁字母：Noto Sans 或任一拉丁字体。', es: '西班牙文需要带重音字母（á é ñ）的拉丁字体，如 Noto Sans。',
  'pt-BR': '葡萄牙文需要带重音字母（ã ç）的拉丁字体，如 Noto Sans。', de: '德文需要 ä ö ü ß，如 Noto Sans。', fr: '法文需要 é è ç 等，如 Noto Sans。',
};
