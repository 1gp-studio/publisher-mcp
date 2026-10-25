import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateRoute, updateGithubGame } from '../src/github-update.js';
const exec = promisify(execFile);

async function repository(t) {
 const root=await mkdtemp(join(tmpdir(),'gh-update-'));t.after(()=>rm(root,{recursive:true,force:true}));
 // A local bare repository ending in github.com/owner/game.git exercises the actual Git
 // commands and repository matcher without contacting GitHub, SSH, or any platform service.
 const directory=join(root,'work'),remote=join(root,'github.com','owner','game.git');
 const git=async(...args)=>(await exec('git',['-C',directory,...args],{timeout:20000,maxBuffer:1024*1024})).stdout.trim();
 await mkdir(dirname(remote),{recursive:true});
 await exec('git',['init','--bare',remote]);await exec('git',['init','-b','main',directory]);
 await git('config','user.name','MCP Test');await git('config','user.email','mcp@example.test');
 await writeFile(join(directory,'index.html'),'Version A');await git('add','.');await git('commit','-m','A');
 await git('remote','add','origin',remote.split(sep).join('/'));await git('push','-u','origin','main');
 const sha=await git('rev-parse','HEAD'),posts=[];
 let response={id:'build-id',state:'queued',commit:sha},branch='main';
 const platform={request:async(path,options={})=>{
  if(options.body){posts.push({path,body:options.body});return response;}
  return path.includes('/context')?{source:'github',repo:'owner/game'}:{branch};
 }};
 const put=async(path,content='New source')=>{const file=join(directory,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,content);};
 const publish=()=>updateGithubGame(platform,directory,'my-game',{version:'1.0.1',title:'Checked change',notes:'Checked local source',changeType:'patch'});
 return {directory,git,sha,posts,put,publish,setResponse:value=>{response=value;},setBranch:value=>{branch=value;}};
}
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
test('GitHub updates preserve the checked branch and pin its SHA; server commit is never overwritten',async t=>{
 const f=await repository(t);
 // A different returned commit exposes a server problem; it must never be hidden by the MCP.
 const reported='b'.repeat(40);f.setResponse({id:'build-id',state:'queued',commit:reported});
 const result=await f.publish();
 assert.equal(result.commit,reported);assert.equal(result.expectedCommit,f.sha);assert.equal(result.branch,'main');
 assert.equal(f.posts.length,1);assert.equal(f.posts[0].body.kind,'branch');assert.equal(f.posts[0].body.value,'main');
 assert.equal(f.posts[0].body.expectedCommit,f.sha);
});
test('a nondefault publishing branch uses its fetched tip even without a local remote-tracking ref',async t=>{
 const f=await repository(t),branch='release/v2';
 await f.git('checkout','-b',branch);await f.put('index.html','Reviewed release branch');
 await f.git('add','.');await f.git('commit','-m','Release B');await f.git('push','origin',branch);
 const sha=await f.git('rev-parse','HEAD');f.setBranch(branch);f.setResponse({id:'build-id',state:'queued',commit:sha});
 await f.git('config','remote.origin.fetch','+refs/heads/main:refs/remotes/origin/main');
 await f.git('update-ref','-d',`refs/remotes/origin/${branch}`);
 const result=await f.publish();
 assert.equal(result.commit,sha);assert.equal(result.branch,branch);assert.equal(f.posts.length,1);
 assert.equal(f.posts[0].body.value,branch);assert.equal(f.posts[0].body.expectedCommit,sha);
 await assert.rejects(f.git('rev-parse','--verify',`refs/remotes/origin/${branch}`));
});
test('untracked source and tracked edits prevent publication instead of silently omitting changes',async t=>{
 const f=await repository(t);
 await f.put('levels/new level.js');
 const untracked=await f.publish();assert.equal(untracked.code,'UNCOMMITTED_CHANGES');assert.ok(untracked.files.some(path=>path.includes('levels/new level.js')));
 await rm(join(f.directory,'levels'),{recursive:true});await f.put(' .level.js');
 const spaced=await f.publish();assert.equal(spaced.code,'UNCOMMITTED_CHANGES');assert.ok(spaced.files.includes('??  .level.js'),'NUL-separated paths retain leading spaces rather than becoming excluded dotfiles');
 await rm(join(f.directory,' .level.js'));await f.put('index.html','Changed locally');
 assert.equal((await f.publish()).code,'UNCOMMITTED_CHANGES');assert.deepEqual(f.posts,[]);
});
test('untracked local artifacts and top-level promotion media do not block a clean GitHub update',async t=>{
 const f=await repository(t);
 for(const path of ['.1gp/vercel-output/index.html','.vercel/output/config.json','node_modules/pkg/index.js','dist/index.html','1gp-kit/cover.webp'])await f.put(path);
 assert.equal((await f.publish()).id,'build-id');assert.equal(f.posts.length,1);
 await f.put('src/1gp-kit/level.js');
 assert.equal((await f.publish()).code,'UNCOMMITTED_CHANGES');assert.equal(f.posts.length,1,'only the top-level promotion kit is excluded');
});
test('untracked hidden build configuration blocks GitHub publishing without asking to commit credentials',async t=>{
 const f=await repository(t);
 for(const path of ['.babelrc','.babelrc.json','.babelrc.cjs','.browserslistrc','.swcrc','packages/web/.postcssrc.mjs']) {
  await f.put(path,'{}');
  const result=await f.publish();
  assert.equal(result.code,'UNCOMMITTED_CHANGES',path);
  assert.deepEqual(result.files,[`?? ${path}`]);
  assert.deepEqual(f.posts,[],`${path} must not be omitted from the checked remote build`);
  await rm(join(f.directory,path));
 }
 for(const path of ['.env','.env.production','.npmrc','.yarnrc.yml','.config/.babelrc','node_modules/pkg/.swcrc','dist/.babelrc','1gp-kit/.browserslistrc'])
  await f.put(path,'PRIVATE_TEST_CREDENTIAL');
 await f.put('.swcrc','{"jsc":{"target":"es2022"}}');
 const blocked=await f.publish();
 assert.deepEqual(blocked.files,['?? .swcrc']);
 assert.doesNotMatch(JSON.stringify(blocked),/PRIVATE_TEST_CREDENTIAL|\.env|\.npmrc|\.yarnrc|\.config/);
 await f.git('add','.swcrc');await f.git('commit','-m','Add checked SWC config');await f.git('push','origin','main');
 assert.equal((await f.publish()).id,'build-id','committing the real build input is sufficient; credentials remain untracked');
 assert.equal(f.posts.length,1);
});
test('a remote branch ahead of local review is refused until the developer synchronizes and checks it',async t=>{
 const f=await repository(t);
 await f.put('index.html','Remote version B');await f.git('add','.');await f.git('commit','-m','B');await f.git('push','origin','main');
 const remote=await f.git('rev-parse','HEAD');await f.git('checkout','--detach',f.sha);
 const result=await f.publish();assert.equal(result.code,'REMOTE_AHEAD');assert.equal(result.localCommit,f.sha);assert.equal(result.remoteCommit,remote);assert.deepEqual(f.posts,[]);
});
test('unpublished local commits still require a push and a remote mismatch is not retried',async t=>{
 const f=await repository(t);
 await f.put('index.html','Local B');await f.git('add','.');await f.git('commit','-m','B');
 assert.equal((await f.publish()).code,'NOT_PUSHED');assert.deepEqual(f.posts,[]);
 await f.git('push','origin','main');
 f.setResponse({error:'COMMIT_MISMATCH: branch moved after inspection',code:'COMMIT_MISMATCH'});
 assert.equal((await f.publish()).code,'COMMIT_MISMATCH');assert.equal(f.posts.length,1);
 assert.equal(f.posts[0].body.expectedCommit,await f.git('rev-parse','HEAD'));
});
