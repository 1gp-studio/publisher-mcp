import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, link, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGameCovers } from '../src/covers.js';
import { testSymlink } from './helpers/symlink.js';
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'covers-safety-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const project=join(root,'project'),outside=join(root,'outside');await mkdir(project);await mkdir(outside);
 return {root,project,outside};
}
test('covers per language upload pictures, then the choices, through the edit page API',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'covers-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'base.png'),Buffer.from([137,80,78,71]));await writeFile(join(dir,'ja.webp'),Buffer.from([1,2,3]));
 const calls=[];
 const platform={upload:async(path,form)=>{calls.push(['upload',path,form.get('target'),form.get('file').type]);return {path:'x'};},request:async(path,options)=>{calls.push(['put',path,options.body]);return {ok:true};}};
 const done=await setGameCovers(platform,dir,'my-game',{base:'base.png',special:{ja:'ja.webp'},modes:{ja:'special',en:'gen'},position:'bl'});
 assert.equal(done.ok,true);
 assert.deepEqual(calls,[['upload','/api/games/my-game/covers','base','image/png'],['upload','/api/games/my-game/covers','special:ja','image/webp'],['put','/api/games/my-game/covers',{position:'bl',modes:{ja:'special',en:'gen'},titles:{}}]]);
 assert.match((await setGameCovers(platform,dir,'my-game',{base:'../outside.png'})).error,/项目目录/);
});

test('cover batches reject a later invalid file before uploading any earlier file',async t=>{
 const {project}=await fixture(t);await writeFile(join(project,'base.png'),'base');
 const calls=[];const platform={upload:async()=>{calls.push('upload');return {path:'saved'};},request:async()=>{calls.push('settings');return {ok:true};}};
 const result=await setGameCovers(platform,project,'game',{base:'base.png',special:{ja:'missing.png'},modes:{en:'gen'}});
 assert.ok(result.error);assert.equal(result.failed,'special:ja');assert.deepEqual(result.uploaded,[]);assert.deepEqual(calls,[]);
});

test('cover uploads reject directory junctions that escape the project',async t=>{
 const {project,outside}=await fixture(t);await writeFile(join(outside,'private.png'),'outside-project');
 if(!await testSymlink(t,outside,join(project,'assets'),process.platform==='win32'?'junction':'dir'))return;
 let calls=0;const result=await setGameCovers({upload:async()=>{calls++;return {}; }},project,'game',{base:'assets/private.png'});
 assert.ok(result.error);assert.equal(calls,0);assert.deepEqual(result.uploaded,[]);
});

test('cover uploads reject hard links, empty pictures and pictures over 2 MB',async t=>{
 const {project,outside}=await fixture(t);await writeFile(join(outside,'private.png'),'outside-project');await link(join(outside,'private.png'),join(project,'linked.png'));
 await writeFile(join(project,'empty.png'),'');await writeFile(join(project,'large.webp'),Buffer.alloc(2*1024*1024+1));
 let calls=0;const platform={upload:async()=>{calls++;return {};}};
 for(const name of ['linked.png','empty.png','large.webp'])assert.ok((await setGameCovers(platform,project,'game',{base:name})).error,name);
 assert.equal(calls,0);
});

test('cover uploads use all verified snapshots even if later files change during upload',async t=>{
 const {project}=await fixture(t);await writeFile(join(project,'base.png'),'base');await writeFile(join(project,'ja.png'),'verified-ja');
 const sent=[];const result=await setGameCovers({upload:async(path,form)=>{
  sent.push(await form.get('file').text());await writeFile(join(project,'ja.png'),'unverified-change');return {path:'saved'};
 }},project,'game',{base:'base.png',special:{ja:'ja.png'}});
 assert.equal(result.ok,true);assert.deepEqual(sent,['base','verified-ja']);
});

test('cover reads reject a path replaced after its handle was opened',async t=>{
 const {project}=await fixture(t),path=join(project,'base.png');await writeFile(path,'original');
 const probe=await open(path),prototype=Object.getPrototypeOf(probe),read=prototype.read;await probe.close();
 let changed=false;
 t.mock.method(prototype,'read',async function(...args){
  if(!changed){changed=true;await rename(path,join(project,'old.png'));await writeFile(path,'replacement');}
  return read.apply(this,args);
 });
 let calls=0;const result=await setGameCovers({upload:async()=>{calls++;return {}; }},project,'game',{base:'base.png'});
 assert.equal(changed,true);assert.ok(result.error);assert.equal(calls,0);
});

test('cover reads reject a file growing beyond the limit after it was opened',async t=>{
 const {project}=await fixture(t),path=join(project,'base.png');await writeFile(path,'original');
 const probe=await open(path),prototype=Object.getPrototypeOf(probe),read=prototype.read;await probe.close();
 let changed=false;
 t.mock.method(prototype,'read',async function(...args){
  if(!changed){changed=true;await writeFile(path,Buffer.alloc(2*1024*1024+1));}
  return read.apply(this,args);
 });
 let calls=0;const result=await setGameCovers({upload:async()=>{calls++;return {}; }},project,'game',{base:'base.png'});
 assert.equal(changed,true);assert.ok(result.error);assert.equal(calls,0);
});

test('cover batch pins the account and stops after a change without hiding completed uploads',async t=>{
 const {project}=await fixture(t);await writeFile(join(project,'base.png'),'base');await writeFile(join(project,'ja.png'),'ja');
 let token='a'.repeat(64);const calls=[];const platform={token:async()=>token,upload:async(path,form,options)=>{
  calls.push(options.token);token='b'.repeat(64);return {path:'saved'};
 },request:async()=>{throw new Error('settings must not be saved under another account');}};
 const result=await setGameCovers(platform,project,'game',{base:'base.png',special:{ja:'ja.png'},modes:{en:'gen'}});
 assert.equal(result.code,'ACCOUNT_CHANGED');assert.deepEqual(result.uploaded,['base']);assert.equal(result.failed,'special:ja');assert.deepEqual(calls,['a'.repeat(64)]);
});

test('cover settings support fillMissing and report a partial upload failure',async t=>{
 const {project}=await fixture(t);await writeFile(join(project,'base.png'),'base');await writeFile(join(project,'ja.png'),'ja');
 const token='a'.repeat(64);let options;
 const done=await setGameCovers({token:async()=>token,request:async(path,value)=>{options=value;return {ok:true};}},project,'game',{modes:{en:'gen'},fillMissing:true});
 assert.equal(done.ok,true);assert.equal(options.token,token);assert.equal(options.body.fillMissing,true);
 let count=0;const partial=await setGameCovers({upload:async()=>++count===1?{path:'saved'}:{error:'cannot upload',code:'NETWORK_ERROR'}},project,'game',{base:'base.png',special:{ja:'ja.png'}});
 assert.equal(partial.code,'NETWORK_ERROR');assert.deepEqual(partial.uploaded,['base']);assert.equal(partial.failed,'special:ja');assert.equal(partial.ok,undefined);
});

test('cover settings retain fillMissing partial results instead of claiming all covers completed',async t=>{
 const {project}=await fixture(t);const skipped=[{locale:'ja',reason:'LOCALIZED_TITLE_REQUIRED'}];
 const result=await setGameCovers({request:async()=>({ok:true,filled:['en'],skipped,partial:true})},project,'game',{modes:{en:'gen',ja:'gen'},fillMissing:true});
 assert.equal(result.partial,true);assert.deepEqual(result.filled,['en']);assert.deepEqual(result.skipped,skipped);assert.match(result.message,/仍缺少必要物料/);
});
