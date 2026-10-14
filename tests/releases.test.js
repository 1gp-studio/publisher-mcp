import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceSnapshot,compareSources,prepareRelease } from '../src/releases.js';
test('release comparison detects content changes and removals without exporting source or secrets',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'release-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'game.js'),'old');await writeFile(join(dir,'.env'),'secret');await mkdir(join(dir,'dist'));await writeFile(join(dir,'dist/index.html'),'output');
 const before=await sourceSnapshot(dir);assert.deepEqual(Object.keys(before.sourceFiles),['game.js']);
 await writeFile(join(dir,'game.js'),'new');await writeFile(join(dir,'level.json'),'{}');
 const after=await sourceSnapshot(dir);assert.deepEqual(compareSources(before.sourceFiles,after.sourceFiles),{baselineAvailable:true,added:['level.json'],changed:['game.js'],removed:[]});
 assert.equal(compareSources({},after.sourceFiles).baselineAvailable,false);
 const prepared=await prepareRelease({request:async()=>({previous:{source_manifest:before.sourceFiles},suggested:{patch:'1.0.1'}})},dir);
 assert.equal(prepared.previous.source_manifest,undefined);assert.deepEqual(prepared.comparison.changed,['game.js']);
});
