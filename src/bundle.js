import { readdir,lstat,readFile,realpath,mkdtemp,rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join,dirname,posix } from 'node:path';
import { createHash } from 'node:crypto';
import { planWeb,outputPath } from './web-plan.js';
import { spawn } from 'node:child_process';
const allowed=/\.(?:[cm]?js|json|html|css|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf|ogg|mp3|wav|mp4|webm|wasm|glb|gltf|txt|data|bin|atlas|webmanifest|xml)$/i;
const limit=3*1024*1024;
// Only read a fresh build output, never the project tree.
// 1gp-kit/ at the top is the store-page kit (cover, screenshots, preview video) imported on the website, not part of the game.
export async function bundleOutput(root,output) {
  const outputStat=await lstat(output);
  if(!outputStat.isDirectory()||outputStat.isSymbolicLink())throw new Error('UNSUPPORTED_BUILD: 构建输出必须是普通目录，不能是符号链接。');
  const files=[],excluded=[];let size=0,visited=0;
  async function walk(relative='') {
    for(const entry of (await readdir(join(output,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(++visited>3000)throw new Error('UNSUPPORTED_BUILD: 构建产物文件过多。');
      const file=relative?`${relative}/${entry.name}`:entry.name;
      if(file.length>240||file.includes('\\'))throw new Error('UNSUPPORTED_BUILD: 文件路径过长或不支持。');
      const path=join(output,file),stat=await lstat(path);
      if(stat.isSymbolicLink())throw new Error('UNSUPPORTED_BUILD: 构建产物中不支持符号链接。');
      if(entry.name.startsWith('.')||['node_modules','api','server'].includes(entry.name)||(!relative&&entry.name==='1gp-kit')||/^(?:credentials|secrets)/i.test(entry.name)||/^(?:package(?:-lock)?\.json|(?:tsconfig.*|vercel|now)\.json|.*\.config\.[cm]?[jt]s|.*\.map)$/i.test(entry.name)){excluded.push(file);continue;}
      if(stat.isDirectory()){await walk(file);continue;}
      if(!stat.isFile()||!allowed.test(file)){excluded.push(file);continue;}
      if(size+stat.size>limit||files.length>=300)throw new Error('UNSUPPORTED_BUILD: 网页产物最多 300 个文件、3 MB；更大游戏请自行托管后使用 publish_link。');
      const bytes=await readFile(path);size+=bytes.length;
      if(size>limit)throw new Error('UNSUPPORTED_BUILD: 网页产物超过 3 MB。');
      const text=bytes.toString('utf8');
      if(/sourceMappingURL\s*=\s*data:/i.test(text))throw new Error('UNSUPPORTED_BUILD: 构建产物包含内联 source map，请关闭 sourcemap 后重试。');
      if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sb_secret_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}/.test(text))throw new Error('POTENTIAL_SECRET: 构建产物疑似包含凭证，请移除后再发布。');
      files.push({file,data:bytes.toString('base64'),encoding:'base64'});
    }
  }
  await walk();
  if(!files.some(f=>f.file==='index.html'))throw new Error('UNSUPPORTED_BUILD: 本地构建必须在指定输出目录生成 index.html。');
  const names=new Set(files.map(f=>f.file));
  for(const page of files.filter(f=>/\.html$/i.test(f.file))) {
    const html=Buffer.from(page.data,'base64').toString('utf8');
    for(const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      const url=match[1];
      if(/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url))continue;
      let path;try{path=decodeURIComponent(url.split(/[?#]/)[0]);}catch{throw new Error('UNSUPPORTED_BUILD: 网页脚本路径编码无效。');}
      const target=path.startsWith('/')?posix.normalize(path).slice(1):posix.join(posix.dirname(page.file),path);
      if(!names.has(target))throw new Error('UNSUPPORTED_BUILD: HTML 引用了未打包的本地脚本，请先构建或检查网页目录与资源路径。');
    }
  }
  return {projectId:createHash('sha256').update(root).digest('hex').slice(0,32),files,size,excluded};
}
function runBuild(root,script,extraArgs=[]) {
  return new Promise((resolve,reject)=>{
    // npm runs the project's build script locally. No platform token is passed.
    const env={...process.env};
    for(const key of Object.keys(env))if(/^(?:ONEGP_|GAME_VERCEL_|SUPABASE_)/.test(key))delete env[key];
    const windows=process.platform==='win32';
    const npmCli=windows?[process.env.npm_execpath,join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js')].find(p=>p?.endsWith('npm-cli.js')&&existsSync(p)):undefined;
    if(windows&&!npmCli){reject(new Error('LOCAL_BUILD_FAILED: 无法定位 npm-cli.js，请使用包含 npm 的 Node.js 安装。'));return;}
    const args=['run',script,...(extraArgs.length?['--',...extraArgs]:[])];
    const child=spawn(windows?process.execPath:'npm',npmCli?[npmCli,...args]:args,{cwd:root,env,stdio:['ignore','pipe','pipe'],shell:false,detached:!windows});
    // Drain output without sending build logs (which may contain secrets) to MCP.
    child.stdout?.resume();child.stderr?.resume();
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;if(windows)spawn('taskkill',['/pid',String(child.pid),'/T','/F']);else {try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}},300000);
    child.on('error',()=>{clearTimeout(timer);reject(new Error('LOCAL_BUILD_FAILED: 无法运行 npm，请安装 Node.js / npm 并在本地安装项目依赖。'));});
    child.on('close',code=>{clearTimeout(timer);if(code!==0||timedOut)reject(new Error('LOCAL_BUILD_FAILED: 本地构建失败或超过 5 分钟；请安装项目依赖并在本地修复所选构建脚本后重试。没有上传任何文件。'));else resolve();});
  });
}
export async function bundleGame(projectDirectory,options={}) {
  const root=await realpath(projectDirectory),plan=await planWeb(root,options);
  if(plan.kind==='choose-output')throw new Error('UNSUPPORTED_BUILD: 请指定 output_directory，按需提供 build_script。');
  if(plan.kind==='prebuilt')return bundleOutput(root,plan.output);
  if(plan.kind==='custom') {
    // Never delete a caller's existing output. Require a newly written entry point
    // so a successful no-op build cannot silently publish an older export.
    const before=await lstat(join(plan.output,'index.html')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    await runBuild(root,plan.buildScript);
    const output=await outputPath(root,plan.outputDirectory,{building:true});
    const after=await lstat(join(output,'index.html')).catch(()=>null);
    if(!after||before&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs)throw new Error('LOCAL_BUILD_FAILED: 构建未生成新的 index.html。请检查输出目录；若要发布现有产物，请仅提供 output_directory。没有上传任何文件。');
    return bundleOutput(root,output);
  }
  const output=await mkdtemp(join(root,'.1gp-build-'));
  try{await runBuild(root,'build',['--outDir',output,'--emptyOutDir']);return await bundleOutput(root,output);}
  finally{await rm(output,{recursive:true,force:true});}
}
