import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDockerImage, dockerProject, requiredIgnores, uploadDockerImage, validateUploadTarget, dockerUploadStatus } from '../src/docker.js';
const id='11111111-1111-4111-8111-111111111111';
const signed={id,url:'https://1gp-game-uploads-612153676415-dev.s3.us-east-1.amazonaws.com/',fields:{key:`uploads/${id}.tar`,Policy:'signed', 'X-Amz-Signature':'signature'}};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'1gp-mcp-docker-test-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'Dockerfile'),'FROM scratch\nUSER 1000');await writeFile(join(root,'.dockerignore'),requiredIgnores.join('\n'));return root;}
test('Docker build requires reviewed context exclusions and rejects override/re-inclusion',async t=>{
 const root=await fixture(t);assert.equal(await dockerProject(root),await (await import('node:fs/promises')).realpath(root));
 await writeFile(join(root,'.dockerignore'),requiredIgnores.join('\n')+'\n!.env');await assert.rejects(dockerProject(root),/re-inclusions/);
 await writeFile(join(root,'.dockerignore'),requiredIgnores.join('\n'));await writeFile(join(root,'Dockerfile.dockerignore'),'');await assert.rejects(dockerProject(root),/consolidate/);
});
test('build uses fixed linux architecture and argument arrays, cleans image tag and failed archives',async t=>{
 const root=await fixture(t),calls=[];
 const result=await buildDockerImage(root,{run:async args=>{calls.push(args);if(args[0]==='save')await writeFile(args[2],Buffer.alloc(2048));}});
 t.after(()=>rm(join(result.archive_path,'..'),{recursive:true,force:true}));
 assert.deepEqual(calls[0].slice(0,8),['buildx','build','--platform','linux/amd64','--provenance=false','--load','--tag',calls[0][7]]);
 assert.equal(calls[0].at(-1),'.');assert.equal(calls[1][0],'save');assert.deepEqual(calls[2],['image','rm',calls[0][7]]);assert.equal(result.size,2048);
 const failed=[];await assert.rejects(buildDockerImage(root,{run:async args=>{failed.push(args);if(args[0]==='save')throw Error('save failed');}}),/save failed/);
 await assert.rejects(stat(failed[1][2]));assert.equal(failed.at(-1)[0],'image');
});
test('upload streams only the archive, never bearer credentials, and returns a resumable ID',async t=>{
 const root=await fixture(t),path=join(root,'game.tar');await writeFile(path,Buffer.alloc(2048));const calls=[];
 const platform={request:async(p,options)=>{calls.push([p,options]);return p.endsWith('/uploads')?signed:{state:'importing',project:'game'};}};
 const result=await uploadDockerImage(platform,path,'game',{send:async(url,options)=>{
   assert.equal(url,signed.url);assert.equal(options.headers,undefined);assert.equal(options.redirect,'error');
   assert.equal(options.body.get('file').size,2048);assert.equal(options.body.get('key'),signed.fields.key);return {ok:true};
 }});
 assert.equal(result.upload_id,id);assert.equal(result.state,'importing');assert.equal(calls.length,2);assert.equal(calls[0][1].body.size,2048);
 const interrupted=await uploadDockerImage(platform,path,'game',{send:async()=>{throw Error('token-secret-must-not-leak');}});
 assert.equal(interrupted.upload_id,id);assert.equal(interrupted.code,'UPLOAD_UNCERTAIN');assert.ok(!JSON.stringify(interrupted).includes('token-secret'));
 await symlink(path,join(root,'link.tar'));await assert.rejects(uploadDockerImage(platform,join(root,'link.tar'),'game'),/non-symlink/);
});
test('signed uploads cannot redirect to arbitrary hosts or object keys',()=>{
 for(const url of ['https://evil.example/','http://1gp-game-uploads-612153676415-dev.s3.us-east-1.amazonaws.com/','https://x@1gp-game-uploads-612153676415-dev.s3.us-east-1.amazonaws.com/','https://1gp-game-uploads-612153676415-dev.s3.us-east-1.amazonaws.com/other'])assert.throws(()=>validateUploadTarget({...signed,url}));
 assert.throws(()=>validateUploadTarget({...signed,fields:{key:'other.tar'}}));
 assert.throws(()=>validateUploadTarget({...signed,fields:{...signed.fields,Authorization:'secret'}}));
});
test('status recovers a completed transfer without creating or re-uploading anything',async()=>{
 const calls=[];const result=await dockerUploadStatus({request:async(path,options)=>{calls.push([path,options]);return options?{state:'importing'}:{state:'uploading'};}},id);
 assert.equal(result.upload_id,id);assert.equal(result.state,'importing');assert.equal(calls.length,2);assert.deepEqual(calls[1][1],{body:{}});
 const ready=await dockerUploadStatus({request:async()=>({state:'ready',project:'game'})},id);assert.equal(ready.state,'ready');
});
test('interrupted uploads record a private reference for a restarted MCP',async t=>{
 const root=await fixture(t),path=join(root,'game.tar');await writeFile(path,Buffer.alloc(2048));
 const platform={file:join(root,'credential.json'),request:async()=>signed};
 await uploadDockerImage(platform,path,'game',{send:async()=>{throw Error('interrupted');}});
 // Windows has no POSIX modes (files report 0o666); the owner-only mode is checked elsewhere.
 if(process.platform!=='win32'){const mode=(await stat(platform.file+'.docker-upload.json')).mode&0o777;assert.equal(mode,0o600);}
 const urls=[];platform.request=async url=>{urls.push(url);return {state:'ready',project:'game'};};
 const result=await dockerUploadStatus(platform);assert.equal(result.upload_id,id);assert.deepEqual(urls,[`/api/publish/docker/uploads/${id}`]);
});
