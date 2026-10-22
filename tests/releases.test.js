import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,mkdir,open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceSnapshot,compareSources,prepareRelease } from '../src/releases.js';
import { updateApprovalGuidance, updateHistoryGuidance } from '../src/update-approval-guidance.js';
test('release comparison detects content changes and removals without exporting source or secrets',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'release-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'game.js'),'old');await writeFile(join(dir,'.env'),'secret');await mkdir(join(dir,'dist'));await writeFile(join(dir,'dist/index.html'),'output');
 const before=await sourceSnapshot(dir);assert.deepEqual(Object.keys(before.sourceFiles),['game.js']);
 await writeFile(join(dir,'game.js'),'new');await writeFile(join(dir,'level.json'),'{}');
 const after=await sourceSnapshot(dir);assert.deepEqual(compareSources(before.sourceFiles,after.sourceFiles),{baselineAvailable:true,added:['level.json'],changed:['game.js'],removed:[]});
 assert.equal(compareSources({},after.sourceFiles).baselineAvailable,false);
 const prepared=await prepareRelease({request:async()=>({previous:{source_manifest:before.sourceFiles},suggested:{patch:'1.0.1'}})},dir);
 assert.equal(prepared.previous.source_manifest,undefined);assert.deepEqual(prepared.comparison.changed,['game.js']);
 assert.ok(prepared.instructions.includes(updateApprovalGuidance.en));
 assert.ok(prepared.instructions.includes(updateHistoryGuidance.en));
 assert.doesNotMatch(prepared.instructions,/exposes them only after success/);
});

test('release comparison excludes the top-level promotion kit before size checks but keeps nested game assets',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'release-kit-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'game.js'),'game');
 await mkdir(join(dir,'levels','1gp-kit'),{recursive:true});
 await writeFile(join(dir,'levels','1gp-kit','level.json'),'old');
 const before=await sourceSnapshot(dir);
 await mkdir(join(dir,'1gp-kit'));
 await writeFile(join(dir,'1gp-kit','game.json'),JSON.stringify({media:{preview:'preview.mp4'}}));
 const preview=await open(join(dir,'1gp-kit','preview.mp4'),'w');
 try { await preview.truncate(65*1024*1024); } finally { await preview.close(); }
 const withKit=await sourceSnapshot(dir);
 assert.deepEqual(withKit.sourceFiles,before.sourceFiles);
 assert.deepEqual(compareSources(before.sourceFiles,withKit.sourceFiles),{baselineAvailable:true,added:[],changed:[],removed:[]});
 await writeFile(join(dir,'1gp-kit','game.json'),JSON.stringify({genre:'action',tags:['Arcade']}));
 await rm(join(dir,'1gp-kit','preview.mp4'));
 await writeFile(join(dir,'levels','1gp-kit','level.json'),'new');
 const after=await sourceSnapshot(dir);
 assert.deepEqual(Object.keys(after.sourceFiles).sort(),['game.js','levels/1gp-kit/level.json']);
 assert.deepEqual(compareSources(withKit.sourceFiles,after.sourceFiles),{baselineAvailable:true,added:[],changed:['levels/1gp-kit/level.json'],removed:[]});
});

test('legacy source manifests containing promotion kits do not create false code releases',()=>{
 const previous={'game.js':'same','1gp-kit/old.png':'old','1gp-kit/game.json':'before','1GP-KIT\\clip.mp4':'large','levels/1gp-kit/data.json':'before'};
 const current={'game.js':'same','1gp-kit/new.png':'new','1gp-kit/game.json':'after','levels/1gp-kit/data.json':'after'};
 assert.deepEqual(compareSources(previous,current),{baselineAvailable:true,added:[],changed:['levels/1gp-kit/data.json'],removed:[]});
 assert.deepEqual(compareSources(previous,{'game.js':'same','levels/1gp-kit/data.json':'before'}),{baselineAvailable:true,added:[],changed:[],removed:[]});
 assert.equal(previous['1gp-kit/old.png'],'old','Historical manifests remain untouched');
 assert.equal(compareSources({'1gp-kit/old.png':'old'},{'game.js':'new'}).baselineAvailable,false);
});
