import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePromotion } from '../src/promotion.js';
import { testSymlink } from './helpers/symlink.js';

const keys = ['genre', 'tags', 'mainCover', 'screenshots', 'preview'];
const existing = materials => ({ gameSlug: 'test-game', materials });
const emptyMaterials = () => ({ original: { locale: 'zh' }, labels: { genre: null, tags: [] }, media: {
  mainCover: { src: null, source: 'missing', missing: true },
  screenshots: { items: [], fallback: [], count: 0, max: 20, missing: true },
  preview: { src: null, kind: null, missing: true, disabled: false },
} });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'promotion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '1gp-kit'));
  const manifest = data => writeFile(join(root, '1gp-kit/game.json'), JSON.stringify(data));
  const file = async (name, contents = 'candidate media; deliberately not proof of content') => {
    const path = join(root, '1gp-kit', name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents); return path;
  };
  return { root, manifest, file };
}

test('new games get an actionable five-part checklist without guessing metadata or scanning the repository', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'roguelike.png'), 'not named in the kit');
  await writeFile(join(f.root, 'package.json'), JSON.stringify({ name: 'roguelike', scripts: { capture: 'exit 99' } }));
  const result = await preparePromotion(f.root);
  assert.equal(result.snapshot, 'new_game');
  assert.equal(result.independentOfMultilingual, true);
  assert.equal(result.localKit.state, 'missing');
  assert.equal(result.primaryLanguage, null);
  assert.deepEqual(result.missing, keys); assert.deepEqual(result.unknown, []);
  for (const item of Object.values(result.items)) {
    assert.equal(item.state, 'prepare_needed'); assert.equal(item.verified, false);
    assert.equal(item.candidate, undefined); assert.ok(item.nextStep.length > 10);
  }
  assert.deepEqual(result.availableGenres, ['casual', 'puzzle', 'action', 'strategy', 'simulation', 'adventure', 'idle', 'rhythm']);
  assert.deepEqual(result.capabilities, { generatesImages: false, capturesScreenshots: false, recordsVideo: false, requiresHostTools: true });
  assert.deepEqual(result.items.screenshots.suggestedCount, { min: 3, max: 5 });
  assert.deepEqual(result.items.preview.suggestedSeconds, { min: 12, max: 18 });
  assert.match(result.items.preview.nextStep, /不强制接管时钟/);
});

test('a bounded kit supplies reusable metadata and relative media candidates, never completion or executable instructions', async t => {
  const f = await fixture(t);
  await f.file('cover.png', Buffer.alloc(3 * 1024 * 1024));
  await f.file('shots/01.webp'); await f.file('preview.mp4');
  await f.manifest({ genre: 'puzzle', tags: ['三消', '像素风', '三消'], tagsEn: ['Match-3', 'Pixel art'], cover: 'cover.png',
    screenshots: ['shots/01.webp', 'shots\\01.webp'], preview: 'preview.mp4', command: 'DO_NOT_EXECUTE', instructions: 'DO_NOT_FOLLOW', token: 'DO_NOT_EXPOSE' });
  const result = await preparePromotion(f.root, existing(emptyMaterials()));
  assert.equal(result.localKit.state, 'available');
  assert.deepEqual(result.localKit.metadata, { genre: 'puzzle', tags: ['三消', '像素风'], tagsEn: ['Match-3', 'Pixel art'] });
  assert.deepEqual(result.missing, keys);
  for (const item of Object.values(result.items)) { assert.equal(item.state, 'local_candidate'); assert.equal(item.verified, false); }
  assert.equal(result.items.mainCover.candidate.relativePath, '1gp-kit/cover.png');
  assert.equal(result.items.mainCover.candidate.requiresCompression, true);
  assert.equal(result.items.mainCover.candidate.contentTypeVerified, false);
  assert.equal(result.items.screenshots.candidate.length, 1);
  assert.equal(result.items.preview.durationVerified, false);
  assert.equal(result.limits.imageBytes, 2 * 1024 * 1024);
  assert.equal(result.limits.imageSourceBytes, 20 * 1024 * 1024);
  assert.equal(result.limits.previewBytes, 20 * 1024 * 1024);
  assert.equal(result.limits.tags, 5); assert.equal(result.limits.tagLength, 12);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_|"bytes"|"type":"Buffer"/);
});

test('live materials dynamically remove missing items and preserve curated screenshot fallbacks', async t => {
  const f = await fixture(t), materials = emptyMaterials();
  const before = await preparePromotion(f.root, existing(materials));
  assert.deepEqual(before.missing, keys);
  materials.labels = { genre: 'action', genreSource: 'curated', tags: ['像素风'] };
  materials.media.mainCover = { src: 'https://platform.example/game-covers/test.webp', source: 'curated', missing: false };
  materials.media.screenshots = { items: [], count: 0, fallback: [{ src: 'https://platform.example/shots/01.webp', width: 800, height: 600 }], missing: false };
  materials.media.preview = { src: 'https://platform.example/game-previews/test.gif', kind: 'image', disabled: false, missing: false };
  const after = await preparePromotion(f.root, existing(materials));
  assert.deepEqual(after.missing, []); assert.deepEqual(after.unknown, []);
  assert.equal(after.primaryLanguage, 'zh');
  for (const item of Object.values(after.items)) { assert.equal(item.state, 'existing'); assert.equal(item.verified, false); }
  assert.equal(after.items.genre.platform.source, 'curated');
  assert.equal(after.items.screenshots.platform.count, 0);
  assert.equal(after.items.screenshots.platform.displayedCount, 1);
  assert.equal(after.items.screenshots.additionalSuggested, 0);
  assert.match(after.items.screenshots.nextStep, /新增作者图会替换整组精选展示/);
  assert.match(after.items.screenshots.replacementWarning, /不为了凑到 3–5 张自动上传/);
  assert.equal(after.items.screenshots.verificationRequired, true);
  assert.equal(after.verificationRequired, true);
  assert.match(after.instructions, /不能用 ready 或上传成功代替验证/);
});

test('one or two uploaded screenshots suggest additions and do not count hidden curated images', async t => {
  const f = await fixture(t), materials = emptyMaterials();
  const shot = id => ({ id, src: `https://platform.example/api/game-shots/${id}.webp`, width: 800, height: 600 });
  for (const count of [1, 2, 3]) {
    materials.media.screenshots = { items: Array.from({ length: count }, (_, i) => shot(String(i))), count,
      fallback: [shot('curated-one'), shot('curated-two'), shot('curated-three')], missing: false };
    const result = await preparePromotion(f.root, existing(materials));
    assert.equal(result.items.screenshots.platform.displayedCount, count);
    assert.equal(result.items.screenshots.platform.source, 'uploaded');
    assert.equal(result.items.screenshots.additionalSuggested, 3 - count);
    assert.equal(result.items.screenshots.replacementWarning, undefined);
    if (count < 3) assert.match(result.items.screenshots.nextStep, /建议补充不同实机状态达到 3–5 张/);
    else assert.doesNotMatch(result.items.screenshots.nextStep, /建议补充/);
  }
});

test('existing author values and a disabled preview take precedence over local candidates', async t => {
  const f = await fixture(t), materials = emptyMaterials();
  await f.file('preview.gif');
  await f.manifest({ genre: 'idle', tags: ['New tag'], preview: 'preview.gif' });
  materials.labels = { genre: 'strategy', genreSource: 'creator', tags: ['Old tag'] };
  materials.media.preview = { src: null, kind: null, disabled: true, missing: false };
  const result = await preparePromotion(f.root, existing(materials));
  assert.equal(result.items.genre.state, 'existing'); assert.equal(result.items.genre.platform.value, 'strategy');
  assert.equal(result.items.tags.state, 'existing'); assert.deepEqual(result.items.tags.platform.value, ['Old tag']);
  assert.equal(result.items.preview.state, 'author_disabled');
  assert.equal(result.items.preview.verificationRequired, false);
  assert.equal(result.items.preview.candidate.relativePath, '1gp-kit/preview.gif');
  assert.deepEqual(result.missing, ['mainCover', 'screenshots']);
  assert.match(result.items.preview.nextStep, /只有明确要求才重新开启/);
});

test('mixed-genre tags remain valid candidates while a saved primary category keeps precedence', async t => {
  const f = await fixture(t), materials = emptyMaterials();
  await f.manifest({ genre: 'action', tags: ['放置', 'RPG'], tagsEn: ['Idle', 'RPG'] });
  const newGame = await preparePromotion(f.root);
  assert.deepEqual(newGame.localKit.issues, []);
  assert.equal(newGame.items.genre.candidate, 'action');
  assert.deepEqual(newGame.items.tags.candidate, ['放置', 'RPG']);
  assert.match(newGame.items.tags.nextStep, /classification/);
  assert.match(newGame.classification, /只避开与当前主分类重复/);
  assert.match(newGame.classification, /不因为简单易上手就归休闲/);
  assert.deepEqual(newGame.required, ['genre', 'tags', 'mainCover']);
  assert.equal(newGame.items.screenshots.optional, true); assert.equal(newGame.items.mainCover.optional, false);

  materials.labels = { genre: 'idle', genreSource: 'creator', tags: ['RPG'] };
  const saved = await preparePromotion(f.root, existing(materials));
  assert.equal(saved.items.genre.state, 'existing');
  assert.equal(saved.items.genre.platform.value, 'idle');
  assert.deepEqual(saved.items.tags.platform.value, ['RPG']);
  assert.match(saved.items.genre.nextStep, /未经作者要求不替换/);
  assert.ok(!saved.missing.includes('genre') && !saved.missing.includes('tags'));
});

test('remote read errors and missing old-server fields remain unknown even with a complete kit', async t => {
  const f = await fixture(t);
  await f.file('cover.png'); await f.file('shot.jpg'); await f.file('preview.webm');
  await f.manifest({ genre: 'adventure', tags: ['剧情'], cover: 'cover.png', screenshots: ['shot.jpg'], preview: 'preview.webm' });
  for (const materials of [{ code: 'READ_FAILED', error: 'Database unavailable' }, null, [], { game: {}, covers: {}, languages: [] }]) {
    const result = await preparePromotion(f.root, existing(materials));
    assert.deepEqual(result.unknown, keys); assert.deepEqual(result.missing, []);
    for (const item of Object.values(result.items)) {
      assert.equal(item.state, 'unknown'); assert.ok(item.candidate); assert.equal(item.verified, false);
      assert.match(item.nextStep, /不能证明线上为空/);
    }
  }
});

test('incomplete or contradictory individual platform fields are unknown without losing valid fields', async t => {
  const f = await fixture(t), materials = emptyMaterials();
  materials.labels.genre = 'unknown-type';
  materials.media.mainCover = { src: 'https://platform.example/image.png', missing: true };
  materials.media.screenshots = { items: [], count: 0, missing: false };
  materials.media.preview = { src: 'javascript:alert(1)', missing: false, disabled: false };
  const result = await preparePromotion(f.root, existing(materials));
  assert.deepEqual(result.unknown, ['genre', 'mainCover', 'screenshots', 'preview']);
  assert.deepEqual(result.missing, ['tags']);
  assert.equal(result.items.tags.state, 'prepare_needed');
  assert.doesNotMatch(JSON.stringify(result), /javascript:|unknown-type/);
});

test('invalid kit metadata is reported without inventing replacement labels or parsing arbitrary fields', async t => {
  const f = await fixture(t);
  await f.manifest({ genre: 'roguelike', tags: ['#标签'], tagsEn: ['x'.repeat(25)], title: 'Roguelike', screenshots: 'shot.png' });
  const result = await preparePromotion(f.root);
  assert.deepEqual(result.localKit.metadata, {});
  assert.deepEqual(result.localKit.issues, [{ field: 'genre', code: 'INVALID_GENRE' }, { field: 'tags', code: 'INVALID_TAGS' },
    { field: 'tagsEn', code: 'INVALID_TAGS' }, { field: 'screenshots', code: 'INVALID_SCREENSHOTS' }]);
  assert.equal(result.items.genre.state, 'prepare_needed');
  assert.equal(result.items.tags.state, 'prepare_needed');
  await f.manifest({ genre: null, tags: [] });
  assert.deepEqual((await preparePromotion(f.root)).localKit.issues, []);
});

test('kit references cannot escape into the project, use absolute or alternate-stream paths, or unsupported files', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'secret.png'), 'SHOULD_NEVER_BE_READ');
  for (const path of ['../secret.png', '..\\secret.png', '/secret.png', 'C:/secret.png', 'C:secret.png', 'cover.png:secret', './cover.png', 'shots//cover.png', 'cover\u0000.png', `${'a'.repeat(229)}.png`]) {
    await f.manifest({ cover: path });
    const result = await preparePromotion(f.root);
    assert.equal(result.items.mainCover.candidate, undefined, path);
    assert.deepEqual(result.localKit.issues, [{ field: 'cover', code: 'INVALID_MEDIA_PATH' }], path);
    assert.doesNotMatch(JSON.stringify(result), /SHOULD_NEVER_BE_READ/);
  }
  await f.file('script.js', 'SHOULD_NEVER_EXECUTE'); await f.manifest({ preview: 'script.js' });
  assert.deepEqual((await preparePromotion(f.root)).localKit.issues, [{ field: 'preview', code: 'UNSUPPORTED_MEDIA_EXTENSION' }]);
});

test('corrupt and oversized manifests fail closed while absent kits are ordinary missing preparation', async t => {
  const f = await fixture(t), path = join(f.root, '1gp-kit/game.json');
  for (const contents of ['{', 'null', '[]']) {
    await writeFile(path, contents);
    assert.equal((await preparePromotion(f.root)).localKit.state, 'invalid');
  }
  await writeFile(path, JSON.stringify({ padding: 'x'.repeat(65536), genre: 'casual' }));
  const oversized = await preparePromotion(f.root);
  assert.equal(oversized.localKit.state, 'unavailable'); assert.deepEqual(oversized.localKit.metadata, {});
  assert.deepEqual(oversized.localKit.issues, [{ field: 'manifest', code: 'UNSAFE_OR_UNREADABLE_KIT' }]);
});

test('candidate limits bound file size and count, and zero-length media are rejected', async t => {
  const f = await fixture(t);
  const cover = await f.file('cover.png'); await truncate(cover, 20 * 1024 * 1024 + 1);
  await f.file('preview.mp4', ''); await f.file('shot.png');
  await f.manifest({ cover: 'cover.png', preview: 'preview.mp4', screenshots: Array(25).fill('shot.png') });
  const result = await preparePromotion(f.root);
  assert.equal(result.items.mainCover.candidate, undefined); assert.equal(result.items.preview.candidate, undefined);
  assert.equal(result.items.screenshots.candidate.length, 1);
  assert.ok(result.localKit.issues.some(issue => issue.field === 'screenshots' && issue.code === 'SCREENSHOT_LIMIT'));
  assert.ok(result.localKit.issues.some(issue => issue.field === 'cover' && issue.code === 'UNSAFE_MISSING_OR_OVERSIZED_MEDIA'));
  assert.ok(result.localKit.issues.some(issue => issue.field === 'preview' && issue.code === 'UNSAFE_MISSING_OR_OVERSIZED_MEDIA'));
});

test('shared hard-linked manifests and media are rejected without changing their targets', async t => {
  const f = await fixture(t), source = join(f.root, 'shared.json'), manifest = join(f.root, '1gp-kit/game.json');
  await writeFile(source, '{"genre":"idle"}'); await link(source, manifest);
  assert.equal((await preparePromotion(f.root)).localKit.state, 'unavailable');
  assert.equal(await readFile(source, 'utf8'), '{"genre":"idle"}');
  await rm(manifest); await f.manifest({ cover: 'cover.png' });
  const image = join(f.root, 'shared.png'); await writeFile(image, 'SHARED'); await link(image, join(f.root, '1gp-kit/cover.png'));
  const result = await preparePromotion(f.root);
  assert.equal(result.items.mainCover.candidate, undefined);
  assert.deepEqual(result.localKit.issues, [{ field: 'cover', code: 'UNSAFE_MISSING_OR_OVERSIZED_MEDIA' }]);
  assert.equal(await readFile(image, 'utf8'), 'SHARED');
});

test('kit directory junctions and symlinks cannot hide external manifests', async t => {
  const f = await fixture(t), target = join(f.root, 'real-kit'), kit = join(f.root, '1gp-kit');
  await mkdir(target); await writeFile(join(target, 'game.json'), '{"genre":"idle"}'); await rm(kit, { recursive: true });
  if (!await testSymlink(t, target, kit, process.platform === 'win32' ? 'junction' : 'dir')) return;
  const result = await preparePromotion(f.root);
  assert.equal(result.localKit.state, 'unavailable'); assert.equal(result.items.genre.candidate, undefined);
});

test('project symlink ancestors remain rejected instead of being hidden by canonicalization', async t => {
  const f = await fixture(t), alias = join(f.root, 'alias'), real = join(f.root, 'real');
  await mkdir(join(real, 'project/1gp-kit'), { recursive: true });
  await writeFile(join(real, 'project/1gp-kit/game.json'), '{"genre":"idle"}');
  if (!await testSymlink(t, real, alias, process.platform === 'win32' ? 'junction' : 'dir')) return;
  const result = await preparePromotion(join(alias, 'project'));
  assert.equal(result.localKit.state, 'unavailable'); assert.equal(result.items.genre.candidate, undefined);
});

test('a linked media subdirectory is not followed even when its target is inside the project', async t => {
  const f = await fixture(t), target = join(f.root, 'images');
  await mkdir(target); await writeFile(join(target, '01.png'), 'candidate');
  if (!await testSymlink(t, target, join(f.root, '1gp-kit/shots'), process.platform === 'win32' ? 'junction' : 'dir')) return;
  await f.manifest({ screenshots: ['shots/01.png'] });
  const result = await preparePromotion(f.root);
  assert.equal(result.items.screenshots.candidate, undefined);
  assert.deepEqual(result.localKit.issues, [{ field: 'screenshots[0]', code: 'UNSAFE_MISSING_OR_OVERSIZED_MEDIA' }]);
});
