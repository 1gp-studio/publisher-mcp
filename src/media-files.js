import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';

const outside = path => path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
async function plainDirectory(path) {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('文件目录不能经过符号链接或目录联接。');
  }
}

export async function checkedProjectDirectory(projectDirectory) {
  if (typeof projectDirectory !== 'string' || !isAbsolute(projectDirectory)) throw new Error('请提供当前项目的绝对路径。');
  const directory = resolve(projectDirectory);
  await plainDirectory(directory);
  return realpath(directory);
}

async function projectFile(projectDirectory, path, maxBytes, readBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error('文件大小限制无效。');
  if (typeof path !== 'string' || !path || path.length > 1024 || /[:\p{Cc}\p{Cf}]/u.test(path) || isAbsolute(path) || win32.isAbsolute(path)) throw new Error('文件必须使用项目内不含控制字符、冒号或备用数据流的相对路径。');
  const directory = await checkedProjectDirectory(projectDirectory);
  const full = resolve(directory, path), inside = relative(directory, full);
  if (!inside || outside(inside)) throw new Error(`文件必须在项目目录里：${path}`);
  await plainDirectory(dirname(full));
  const regular = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= maxBytes;
  const before = await lstat(full);
  if (!regular(before)) throw new Error(`文件必须是非空、非链接的普通文件，且不超过 ${maxBytes} 字节：${path}`);
  const canonical = await realpath(full);
  if (outside(relative(directory, canonical))) throw new Error(`文件必须在项目目录里：${path}`);
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!regular(opened) || !sameFile(before, opened)) throw new Error(`文件在读取前被替换：${path}`);
    const buffer = readBytes ? Buffer.alloc(Math.min(maxBytes, opened.size) + 1) : null;
    let length = 0;
    while (buffer && length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    await plainDirectory(dirname(full));
    const pathAfter = await lstat(full);
    if (!regular(after) || !regular(pathAfter) || !sameFile(opened, pathAfter)
      || readBytes && length !== after.size || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
      || pathAfter.mtimeMs !== after.mtimeMs || pathAfter.ctimeMs !== after.ctimeMs
      || outside(relative(directory, await realpath(full)))) throw new Error(`文件在读取期间被替换、改变或超过限制：${path}`);
    return { ...(buffer ? { bytes: buffer.subarray(0, length) } : {}), size: after.size, name: basename(full), relativePath: inside.split(sep).join('/') };
  } finally { await handle.close(); }
}

/** Snapshot one bounded regular file; never follow project/ancestor links or read shared hard links. */
export const readProjectFile = (projectDirectory, path, maxBytes) => projectFile(projectDirectory, path, maxBytes, true);
/** Candidate discovery only: checks the handle/path without reading large media bodies. Upload revalidates. */
export const inspectProjectFile = (projectDirectory, path, maxBytes) => projectFile(projectDirectory, path, maxBytes, false);
