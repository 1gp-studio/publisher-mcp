import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGameCovers } from '../src/covers.js';
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
