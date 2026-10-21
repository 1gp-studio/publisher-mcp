import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateRoute, updateGithubGame } from '../src/github-update.js';
test('the update route follows how the game is published',()=>{
 assert.equal(updateRoute({source:'github',repo:'a/b'}).channel,'github');
 assert.match(updateRoute({source:'github',repo:'a/b'}).nextSteps.join(' '),/update_github_game/);
 assert.match(updateRoute({source:'external',playUrl:'https://x.example/'}).nextSteps.join(' '),/publish_link/);
 assert.match(updateRoute({source:'docker',dockerProject:'p'}).nextSteps.join(' '),/publish_docker_game/);
 assert.match(updateRoute({source:'local'}).nextSteps.join(' '),/publish_game/);
 assert.equal(updateRoute({}).channel,'new');
});
test('a GitHub update refuses other channels and folders that are not the game repository, and never builds then',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'gh-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const posts=[];
 const platform=source=>({request:async(path,options={})=>{if(options.body){posts.push(path);return {};}return path.includes('/context')?{source,repo:'owner/game'}:{branch:'main'};}});
 assert.equal((await updateGithubGame(platform('local'),dir,'my-game')).code,'NOT_GITHUB');
 assert.equal((await updateGithubGame(platform('github'),dir,'my-game')).code,'NOT_A_REPOSITORY');
 assert.deepEqual(posts,[]);
});
