// npm run build: bundles the server into dist/, so an install needs no dependency tree and connects quickly.
// mp4-muxer and webm-muxer stay real (small) dependencies because the recorder hands their files to the browser;
// sharp and esbuild are fetched on first use (src/lazy-deps.js). tests/bundle.test.js fails when dist/ is stale.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function bundle() {
  const { outputFiles, metafile } = await build({
    absWorkingDir: root, entryPoints: ['src/main.js'], bundle: true, write: false, outfile: 'dist/server.js', metafile: true,
    platform: 'node', format: 'esm', target: 'node24', legalComments: 'none', logLevel: 'silent', charset: 'utf8',
    // debug only tries this one for colours; a copy further up the folder tree must not get bundled.
    external: ['supports-color'],
    banner: { js: "import { createRequire as __bundleRequire } from 'node:module';\nconst require = __bundleRequire(import.meta.url);" },
  });
  // Anything from outside this package would differ per machine and write its local path into dist/.
  const outside = Object.keys(metafile.inputs).filter(path => path.startsWith('..') || isAbsolute(path));
  if (outside.length) throw new Error(`The bundle reached outside the package: ${outside.join(', ')}`);
  return outputFiles[0].text;
}
export const pageSource = () => readFile(join(root, 'src', 'recorder-page.js'), 'utf8');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { writeFile } = await import('node:fs/promises');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'server.js'), await bundle());
  await copyFile(join(root, 'src', 'recorder-page.js'), join(root, 'dist', 'recorder-page.js'));
}
