import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser, recordGameVideo, recordingPage } from '../src/recorder.js';

// A tiny canvas game: one loop, update/render apart, sound from one AudioContext variable.
const game = hooked => `<!doctype html><html><head><meta charset="utf-8"></head><body><canvas id="cv" width="180" height="320"></canvas><script>
${hooked ? '(function () {' : ''}
var cv = document.getElementById('cv'), ctx = cv.getContext('2d'), AC = null, x = 0, last = performance.now();
function update(dt) { x = (x + dt * 120) % 180; }
function render() { ctx.fillStyle = '#123'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#fd0'; ctx.fillRect(x * cv.width / 180, cv.height / 2, 30, 30); }
function beep() { if (!AC) return; var o = AC.createOscillator(), g = AC.createGain(); o.frequency.value = 440; g.gain.value = .3; o.connect(g).connect(AC.destination); o.start(AC.currentTime); o.stop(AC.currentTime + .2); }
function loop(now) { update((now - last) / 1000); last = now; render(); requestAnimationFrame(loop); }
${hooked ? '/*TRAILER_HOOK*/ ' : ''}requestAnimationFrame(loop);
${hooked ? '})();' : ''}
</script></body></html>`;

test('the page gets the director in the game scope with the marker, or holds the page loop without it', () => {
  const scoped = recordingPage('<body><script>(function(){ /*TRAILER_HOOK*/ requestAnimationFrame(loop); })();</script></body>');
  assert.equal(scoped.mode, 'scope');
  assert.match(scoped.html, /if \(location\.hash === '#rec'\) fetch\('\/__director\.js'\).*else\s+requestAnimationFrame\(loop\)/);
  const page = recordingPage('<html><head><title>x</title></head><body><p>a</p></body></html>');
  assert.equal(page.mode, 'page');
  assert.match(page.html, /<head><script>window\.__recVirtual = true;<\/script><script src="\/__runtime\.js"><\/script><title>/, 'the clock is held before any game script runs');
  assert.match(page.html, /\(0, eval\)\(t\).*<\/script><\/body>/);
});

test('bad requests are refused before starting a browser', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rec-bad-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), game(true)); await writeFile(join(root, 'd.js'), '');
  const launch = () => { throw new Error('must not launch'); };
  for (const input of [{ director: '../d.js' }, { director: 'missing.js' }, { director: 'd.js', size: '10x10' }, { director: 'd.js', root: '..' }])
    assert.equal((await recordGameVideo({ projectDirectory: root, browser: 'x', launch, ...input })).code, 'INVALID_REQUEST', JSON.stringify(input));
  assert.equal((await recordGameVideo({ projectDirectory: root, director: 'd.js', browser: null, launch })).code, 'BROWSER_REQUIRED');
});

const browser = findBrowser();
test('a real browser records an MP4 with sound and screenshots, in the game scope and without touching the game', { skip: !browser && 'no Chrome or Edge here', timeout: 240000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rec-real-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scoped')); await mkdir(join(root, 'plain'));
  await writeFile(join(root, 'scoped', 'index.html'), game(true));
  await writeFile(join(root, 'plain', 'index.html'), game(false));
  await writeFile(join(root, 'scoped.js'), `REC.run({ fps: 30, seconds: 1, canvas: cv, audio: true,
    setup(ac) { AC = ac; cv.width = REC.width; cv.height = REC.height; REC.log('scoped ' + cv.width); },
    async step(i) { if (i === 3) beep(); update(1 / 30); render(); if (i === 15) await REC.shot('middle', cv); } });`);
  await writeFile(join(root, 'plain.js'), `REC.run({ fps: 30, seconds: 1, canvas: cv, audio: false,
    setup() { cv.width = REC.width; cv.height = REC.height; },
    step() { REC.advance(1000 / 30); } });`);
  const scoped = await recordGameVideo({ projectDirectory: root, root: 'scoped', director: 'scoped.js', size: '180x320', out: 'out/scoped.mp4', timeoutSeconds: 120 });
  assert.equal(scoped.ok, true, JSON.stringify(scoped));
  assert.equal(scoped.mode, 'scope'); assert.equal(scoped.frames, 30); assert.equal(scoped.size, '180x320');
  assert.ok(scoped.audio, 'the beep is in the video'); assert.ok(scoped.bytes < 5 * 1024 * 1024);
  const bytes = await readFile(join(root, 'out', 'scoped.' + (scoped.container === 'webm' ? 'webm' : 'mp4')));
  assert.equal(bytes.length, scoped.bytes);
  if (scoped.container === 'mp4') assert.equal(bytes.subarray(4, 8).toString('latin1'), 'ftyp');
  assert.deepEqual(scoped.screenshots, ['1gp-kit/screenshots/middle.png']);
  assert.equal((await readFile(join(root, '1gp-kit', 'screenshots', 'middle.png'))).subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(scoped.log.some(line => line === 'scoped 180'));

  const plain = await recordGameVideo({ projectDirectory: root, root: 'plain', director: 'plain.js', size: '180x320', timeoutSeconds: 120 });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.equal(plain.mode, 'page'); assert.equal(plain.audio, null); assert.match(plain.path, /^1gp-kit\/preview\.(mp4|webm)$/);
});
