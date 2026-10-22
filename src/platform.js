import { randomBytes,createHash } from 'node:crypto';
import { mkdir,readFile,writeFile,chmod,lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const authorizationRequired = () => ({ code:'AUTH_REQUIRED',error:'请先运行 connect_platform，并由用户在浏览器确认授权。' });
async function responseData(response) {
  let data;
  try { data=await response.json(); } catch { /* Error pages are not successful API responses. */ }
  if(response.status===401)return {...authorizationRequired(),status:401};
  if(!data||typeof data!=='object'||Array.isArray(data))return {code:'PLATFORM_ERROR',error:`平台返回异常响应 (${response.status})。`,status:response.status};
  if(!response.ok)return {...data,
    ...Object.fromEntries(['ok','connected','ready'].filter(key=>Object.hasOwn(data,key)).map(key=>[key,false])),
    code:typeof data.code==='string'&&data.code?data.code:response.status===403?'FORBIDDEN':'PLATFORM_ERROR',
    error:typeof data.error==='string'&&data.error?data.error:`平台请求失败 (${response.status})。`,status:response.status};
  return data;
}
export class Platform {
  constructor({origin=process.env.ONEGP_PLATFORM_URL||'https://1gp-game-platform.vercel.app',configDirectory=join(homedir(),'.config','1gp-studio')}={}) {
    const url=new URL(origin);
    if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))) throw new Error('Platform URL must be an HTTPS origin');
    this.origin=url.origin;
    this.directory=configDirectory;
    this.file=join(configDirectory,createHash('sha256').update(this.origin).digest('hex').slice(0,16)+'.json');
  }
  async token() {
    try{if((await lstat(this.file)).isSymbolicLink())throw new Error('Invalid credential file');const data=JSON.parse(await readFile(this.file,'utf8'));return /^[a-f0-9]{64}$/.test(data.token)?data.token:null;}catch{return null;}
  }
  async request(path,{body,token,method=body?'POST':'GET',timeoutMs=175000,signal,idempotencyKey}={}) {
    const secret=token===undefined?await this.token():token;
    if(!secret)return authorizationRequired();
    if(idempotencyKey!==undefined&&!/^[a-f0-9]{64}$/.test(idempotencyKey))return {code:'INVALID_REQUEST',error:'媒体上传需要有效的内容指纹。'};
    let response;
    try{const timeout=AbortSignal.timeout(Math.max(1,Math.min(175000,Math.trunc(timeoutMs)||175000)));response=await fetch(this.origin+path,{method,headers:{Authorization:`Bearer ${secret}`,...(body?{'Content-Type':'application/json'}:{}),...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});}catch{return {code:'NETWORK_ERROR',error:'无法连接平台，请稍后查询状态；不要自动重复提交发布。'};}
    return responseData(response);
  }
  // Raw verified image bytes for the existing owner cover/screenshot endpoints.
  async uploadBytes(path,bytes,{token,type,idempotencyKey}={}) {
    const secret=token===undefined?await this.token():token;
    if(!secret)return authorizationRequired();
    if(!/^[a-f0-9]{64}$/.test(idempotencyKey??'')||!['image/jpeg','image/png','image/webp'].includes(type))return {code:'INVALID_REQUEST',error:'媒体上传需要实际图片类型和有效的内容指纹。'};
    let response;
    try{response=await fetch(this.origin+path,{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':type,'Idempotency-Key':idempotencyKey},body:bytes,redirect:'error',signal:AbortSignal.timeout(120000)});}catch{return {code:'NETWORK_ERROR',error:'上传结果不明；查询物料后用同一文件恢复，不能另换标识重复添加。'};}
    return responseData(response);
  }
  // A multipart upload (a cover picture): same credential, the browser-style form as the body.
  async upload(path,form,{token}={}) {
    const secret=token===undefined?await this.token():token;
    if(!secret)return authorizationRequired();
    let response;
    try{response=await fetch(this.origin+path,{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:form,redirect:'error',signal:AbortSignal.timeout(120000)});}catch{return {code:'NETWORK_ERROR',error:'无法连接平台，请稍后重试。'};}
    return responseData(response);
  }
  async connect() {
    let token=await this.token();
    if(token){const state=await this.request('/api/connections',{token});if(state.connected)return {connected:true,message:'已连接，可以调用 inspect_game / publish_game。'};if(state.code&&state.code!=='AUTH_REQUIRED')return state;}
    token=randomBytes(32).toString('hex');
    await mkdir(this.directory,{recursive:true,mode:0o700});
    if((await lstat(this.directory)).isSymbolicLink())throw new Error('Credential directory must not be a symlink');
    await chmod(this.directory,0o700);
    // Never send the bearer secret to the model or the browser URL.
    const temporary=this.file+'.'+randomBytes(8).toString('hex');
    await writeFile(temporary,JSON.stringify({token}),{mode:0o600,flag:'wx'});
    const {rename}=await import('node:fs/promises');await rename(temporary,this.file);
    const challenge=createHash('sha256').update(token).digest('hex');
    return {connected:false,authorizationUrl:`${this.origin}/connect?challenge=${challenge}`,fingerprint:challenge.slice(0,12),message:'请用户本人打开链接，登录并确认授权。完成后调用 publish_game。不要自动替用户批准。'};
  }
}
