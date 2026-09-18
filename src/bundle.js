import { readdir,lstat,readFile,realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const allowed=/\.(?:[cm]?[jt]sx?|json|html|css|scss|sass|less|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|ogg|mp3|wav|wasm|glb|gltf|txt)$/i;
export async function bundleGame(projectDirectory) {
  const root=await realpath(projectDirectory),files=[],excluded=[];let size=0,visited=0;
  async function walk(relative='') {
    for(const entry of (await readdir(join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(++visited>3000)throw new Error('UNSUPPORTED_BUILD: 项目文件过多，请使用 GitHub 方式发布。');
      const file=relative?`${relative}/${entry.name}`:entry.name;
      if(entry.name.startsWith('.')||['node_modules','dist','coverage'].includes(entry.name)||/^(credentials|secrets)/i.test(entry.name)){excluded.push(file);continue;}
      if(file.length>240||file.includes('\\'))throw new Error('UNSUPPORTED_BUILD: 文件路径过长或不支持。');
      if(['vercel.json','now.json','project.godot'].includes(entry.name)||entry.name==='api')throw new Error('UNSUPPORTED_BUILD: 暂不支持 Godot、后端 API 或自定义 Vercel 配置。');
      const path=join(root,file),stat=await lstat(path);
      if(stat.isSymbolicLink())throw new Error('UNSUPPORTED_BUILD: 暂不支持符号链接。');
      if(stat.isDirectory()){await walk(file);continue;}
      if(!stat.isFile()||!allowed.test(file)){excluded.push(file);continue;}
      if(size+stat.size>2*1024*1024||files.length>=300)throw new Error('UNSUPPORTED_BUILD: MCP 暂支持最多 300 个文件、2 MB 源码；更大游戏请使用 GitHub 方式。');
      const bytes=await readFile(path);size+=bytes.length;
      if(size>2*1024*1024)throw new Error('UNSUPPORTED_BUILD: 源码超过 2 MB。');
      if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sb_secret_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}/.test(bytes.toString('utf8')))throw new Error('POTENTIAL_SECRET: 源码疑似包含凭证，请移除后再发布。');
      files.push({file,data:bytes.toString('base64'),encoding:'base64'});
    }
  }
  await walk();
  return {projectId:createHash('sha256').update(root).digest('hex').slice(0,32),files,size,excluded};
}
