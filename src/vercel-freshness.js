import { lstat,readdir,readFile } from 'node:fs/promises';
import { join,relative,sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isReleaseSourcePath } from './source-files.js';

export const managedVercelDirectory='.1gp/vercel-output';
// Public hidden build config is covered by isReleaseSourcePath. These private
// local inputs affect builds too, but must never become a prompt to commit secrets.
const hiddenBuildInput=/^(?:\.env(?:\..+)?|\.npmrc|\.yarnrc(?:\.yml)?)$/i;
const fail=()=>{throw new Error('VERCEL_OUTPUT_REQUIRED: MCP 托管的完整产物早于当前构建输入、管理标记缺失或无效，或来自没有源码指纹的旧版工具。请重新调用 build_vercel_game，再使用它返回的完整产物发布；没有上传任何文件。');};

export async function managedVercelMetadata(root) {
  const path=join(root,'.1gp/vercel-output.owner.json'),stat=await lstat(path).catch(()=>null);
  if(!stat?.isFile()||stat.isSymbolicLink()||stat.size>2000)return null;
  try {
    const metadata=JSON.parse(await readFile(path,'utf8'));
    return metadata.projectId===createHash('sha256').update(root).digest('hex')?metadata:null;
  }catch{return null;}
}

// This fingerprint stays in the local owner marker, never in uploaded game files.
// Include common hidden build configuration without reading dependency/cache trees.
// A generated frontend is excluded; an explicitly supplied prebuilt frontend is an input.
export async function vercelSourceFingerprint(root,{frontendDirectory,generatedFrontend=false}={}) {
  const frontend=frontendDirectory?relative(root,join(root,frontendDirectory)).split(sep).join('/'):undefined;
  if(frontend!==undefined&&(!frontend||frontend==='..'||frontend.startsWith('../')))throw new Error('UNSUPPORTED_BUILD: 前端目录必须位于项目内，且不能是项目根目录。');
  const files=new Map();let total=0,visited=0;
  const insideFrontend=name=>frontend&&(name===frontend||name.startsWith(frontend+'/'));
  async function walk(directory,prefix='',explicitFrontend=false) {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      if(++visited>10000)throw new Error('UNSUPPORTED_BUILD: 构建输入过多，无法验证托管产物的新鲜度；请缩小项目目录。');
      const name=prefix+entry.name;
      if(!explicitFrontend) {
        if(insideFrontend(name))continue;
        const hidden=hiddenBuildInput.test(entry.name)&&(!prefix||isReleaseSourcePath(prefix.slice(0,-1)));
        if(!isReleaseSourcePath(name)&&!hidden)continue;
      }
      const path=join(directory,entry.name),stat=await lstat(path);
      if(stat.isSymbolicLink())throw new Error('UNSUPPORTED_BUILD: 构建输入中的符号链接无法用于验证托管产物，请使用普通源文件或项目专用完整构建产物。');
      if(stat.isDirectory()){await walk(path,name+'/',explicitFrontend);continue;}
      if(!stat.isFile())continue;
      total+=stat.size;
      if(files.size>=1000||total>64*1024*1024)throw new Error('UNSUPPORTED_BUILD: 构建输入超过 1000 文件或 64 MiB，无法验证托管产物的新鲜度；请缩小项目目录。');
      const bytes=await readFile(path);total+=bytes.length-stat.size;
      if(total>64*1024*1024)throw new Error('UNSUPPORTED_BUILD: 构建输入超过 64 MiB。');
      files.set(name,createHash('sha256').update(bytes).digest('hex'));
    }
  }
  await walk(root);
  if(frontend&&!generatedFrontend) {
    const path=join(root,frontend),stat=await lstat(path);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('UNSUPPORTED_BUILD: 前端输入必须是普通目录。');
    await walk(path,frontend+'/',true);
  }
  return createHash('sha256').update(JSON.stringify([...files].sort(([a],[b])=>a<b?-1:a>b?1:0))).digest('hex');
}

export async function assertManagedVercelFreshness(root,metadata) {
  if(metadata?.version!==2||!/^[a-f0-9]{64}$/.test(metadata.sourceFingerprint))fail();
  if(metadata.sourceFingerprint!==await vercelSourceFingerprint(root,metadata.sourceInputs))fail();
}
