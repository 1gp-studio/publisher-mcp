import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Platform } from '../src/platform.js';

async function fixture(t,handler) {
 const http=createServer(handler);await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>http.close(resolve)));
 const platform=new Platform({origin:`http://127.0.0.1:${http.address().port}`});platform.token=async()=>'a'.repeat(64);
 return platform;
}
async function both(platform,path) {return [await platform.request(path),await platform.upload(path,new FormData())];}

test('HTTP 401 consistently requests reconnection, including HTML and legacy JSON errors',async t=>{
 const platform=await fixture(t,(req,res)=>{res.statusCode=401;res.end(req.url==='/html'?'<html>Unauthorized</html>':JSON.stringify({error:'请先登录。'}));});
 for(const path of ['/html','/json'])for(const result of await both(platform,path)){assert.equal(result.code,'AUTH_REQUIRED');assert.equal(result.status,401);assert.ok(result.error);}
});

test('HTTP 403 stays a permission error and other non-2xx bodies cannot claim success',async t=>{
 const platform=await fixture(t,(req,res)=>{res.statusCode=req.url==='/forbidden'?403:503;res.end(JSON.stringify({ok:true,connected:true,ready:true}));});
 for(const result of await both(platform,'/forbidden')){assert.equal(result.code,'FORBIDDEN');assert.equal(result.status,403);assert.ok(result.error);}
 for(const result of await both(platform,'/unavailable')){assert.equal(result.code,'PLATFORM_ERROR');assert.equal(result.status,503);assert.equal(result.ok,false);assert.equal(result.connected,false);assert.equal(result.ready,false);assert.ok(result.error);}
});

test('successful HTTP responses still require a JSON object',async t=>{
 const responses=['<html>error</html>','null','[]','true','"ok"'];
 const platform=await fixture(t,(req,res)=>res.end(responses[Number(req.url.slice(1))]));
 for(let i=0;i<responses.length;i++)for(const result of await both(platform,`/${i}`)){assert.equal(result.code,'PLATFORM_ERROR');assert.ok(result.error);}
});

test('JSON and multipart requests use an explicitly pinned token without rereading credentials',async t=>{
 const seen=[];const platform=await fixture(t,(req,res)=>{seen.push(req.headers.authorization);req.resume();res.end(JSON.stringify({ok:true}));});
 platform.token=async()=>{throw new Error('must not reread current account');};const token='b'.repeat(64);
 assert.equal((await platform.request('/request',{token})).ok,true);
 assert.equal((await platform.upload('/upload',new FormData(),{token})).ok,true);
 assert.deepEqual(seen,[`Bearer ${token}`,`Bearer ${token}`]);
});

test('media raw uploads and signed-request JSON pin authentication and forward only validated fingerprints', async t => {
 const seen=[],key='c'.repeat(64),token='b'.repeat(64),bytes=Buffer.from('reviewed-image');
 const platform=await fixture(t,async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);seen.push({headers:req.headers,bytes:Buffer.concat(chunks)});res.end(JSON.stringify({ok:true}));});
 platform.token=async()=>{throw new Error('must use pinned account');};
 assert.equal((await platform.uploadBytes('/cover',bytes,{token,type:'image/webp',idempotencyKey:key})).ok,true);
 assert.equal((await platform.request('/preview',{token,idempotencyKey:key,body:{action:'sign'}})).ok,true);
 assert.equal(seen.length,2);assert.deepEqual(seen[0].bytes,bytes);
 for(const request of seen){assert.equal(request.headers.authorization,`Bearer ${token}`);assert.equal(request.headers['idempotency-key'],key);}
 assert.equal(seen[0].headers['content-type'],'image/webp');
 assert.equal((await platform.uploadBytes('/cover',bytes,{token,type:'image/webp',idempotencyKey:'bad\r\nHeader: injected'})).code,'INVALID_REQUEST');
 assert.equal((await platform.request('/preview',{token,idempotencyKey:'bad'})).code,'INVALID_REQUEST');
 assert.equal(seen.length,2);
});
