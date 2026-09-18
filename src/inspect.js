import { readFile,lstat,realpath } from 'node:fs/promises';
import { resolve,isAbsolute,join } from 'node:path';
import { bundleGame } from './bundle.js';
const unsupported=reason=>({supported:false,code:reason.startsWith('POTENTIAL_SECRET')?'POTENTIAL_SECRET':'UNSUPPORTED_BUILD',reason});
async function file(directory,name) {
  const path=join(directory,name),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>(name==='package.json'?100000:10000000))throw new Error('Invalid metadata file');
  return readFile(path,'utf8');
}
export async function inspectGame(projectDirectory) {
  if(!isAbsolute(projectDirectory))return unsupported('请提供当前游戏项目的绝对路径。');
  let directory;
  try{directory=await realpath(resolve(projectDirectory));}catch{return unsupported('无法读取项目目录。');}
  try{await lstat(join(directory,'project.godot'));return unsupported('Godot 暂不支持。可以先导出为网页并部署，再用已有游戏链接接入。');}catch{}
  let pkg;
  try{pkg=JSON.parse(await file(directory,'package.json'));}catch{return unsupported('缺少可读取的根目录 package.json。第一版支持 Vite / npm 网页游戏。');}
  if(!(pkg.dependencies?.vite||pkg.devDependencies?.vite)||typeof pkg.scripts?.build!=='string'||!pkg.scripts.build.trim())return unsupported('只支持带有 Vite 依赖和 npm run build 脚本的 Web 项目；暂不支持 Next.js、Godot 或其他引擎。');
  try{await file(directory,'index.html');await file(directory,'package-lock.json');}catch{return unsupported('根目录必须包含 index.html 和 package-lock.json，且不能是符号链接。');}
  let bundle;
  try{bundle=await bundleGame(directory);}catch(error){return unsupported(error.message);}
  return {supported:true,ready:true,buildMethod:'web-npm',source:'local',projectId:bundle.projectId,title:typeof pkg.name==='string'?pkg.name.replace(/^@[^/]+\//,'').slice(0,120)||'Untitled game':'Untitled game',description:typeof pkg.description==='string'&&pkg.description.trim()?pkg.description.trim().slice(0,2000):'使用 Codex 创作的独立网页游戏。',build:{install:'npm ci',command:'npm run build',output:'dist'},fileCount:bundle.files.length,sourceBytes:bundle.size,excludedFiles:bundle.excluded.slice(0,30),reason:'支持 Web / npm。直接上传当前项目源码，在隔离的 Vercel 项目构建，无需 GitHub 仓库。不会在本机执行项目脚本。'};
}
