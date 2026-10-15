import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { isVercelConfig } from './vercel-output.js';

const requestLimit=4*1024*1024;
// Upload immutable files in bounded batches. A failed/uncertain request is never
// automatically retried, and no final deployment is submitted without receipts.
export async function uploadVercelFiles(platform,files,publication={}) {
  const preview=files.map(file=>({file:file.file,sha:'0'.repeat(40),size:Buffer.from(file.data,'base64').length,receipt:'0'.repeat(100),...(isVercelConfig(file.file)?{data:file.data}:{})}));
  if(Buffer.byteLength(JSON.stringify({...publication,files:preview}))>4300*1024)throw new Error('UNSUPPORTED_BUILD: 完整部署的文件清单或配置超过 4300 KiB 发布请求限制，请减少文件数量、路径长度或配置体积。没有上传任何文件。');
  const batches=[];let current=[];
  for(const original of files) {
    const bytes=Buffer.from(original.data,'base64');
    const encoded=bytes.length>2*1024*1024?{...original,data:gzipSync(bytes).toString('base64'),encoding:'base64-gzip'}:original;
    if(Buffer.byteLength(JSON.stringify({files:[encoded]}))>requestLimit)throw new Error('UNSUPPORTED_BUILD: Vercel 单文件压缩后仍超过上传请求限制，请减小资源或拆分构建产物。没有上传任何文件。');
    if(current.length&&(current.length>=200||Buffer.byteLength(JSON.stringify({files:[...current,encoded]}))>requestLimit)){batches.push(current);current=[];}
    current.push(encoded);
  }
  if(current.length)batches.push(current);
  const originals=new Map(files.map(file=>[file.file,file])),references=[];
  for(const batch of batches) {
    const response=await platform.request('/api/publish/vercel/files',{body:{files:batch}});
    if(response.error)throw new Error(`${response.code||'PLATFORM_ERROR'}: ${response.error}`);
    if(!Array.isArray(response.files)||response.files.length!==batch.length)throw new Error('PLATFORM_ERROR: 完整产物上传响应不完整；未提交部署，请先检查平台状态，不要自动重试。');
    const returned=new Set();
    for(const reference of response.files) {
      const original=originals.get(reference.file),bytes=original?Buffer.from(original.data,'base64'):null;
      if(!original||!batch.some(file=>file.file===reference.file)||returned.has(reference.file)||reference.sha!==createHash('sha1').update(bytes).digest('hex')||reference.size!==bytes.length||typeof reference.receipt!=='string'||!reference.receipt||reference.receipt.length>100)throw new Error('PLATFORM_ERROR: 完整产物上传回执无效；未提交部署，请先检查平台状态。');
      returned.add(reference.file);
      references.push({file:reference.file,sha:reference.sha,size:reference.size,receipt:reference.receipt,...(isVercelConfig(reference.file)?{data:original.data}:{})});
    }
  }
  return references;
}
