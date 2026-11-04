import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Runs the npm that came with this Node, wherever that is, without touching the MCP connection on stdout.
export function npm(args, cwd) {
  const cli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(path => path && /npm-cli\.js$/.test(path) && existsSync(path));
  const shell = !cli && process.platform === 'win32';
  const [command, rest] = cli ? [process.execPath, [cli, ...args]] : [shell ? 'npm.cmd' : 'npm', shell ? args.map(arg => `"${arg}"`) : args];
  return new Promise((resolve, reject) => {
    const child = spawn(command, rest, { cwd, shell, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`npm 安装失败（${code}）：${errors.trim().split('\n').at(-1) ?? ''}`)));
  });
}
