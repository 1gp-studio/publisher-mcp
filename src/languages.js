import { readFile,readdir,lstat,realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prepareGameText } from './text-check.js';
import { fontCoverage } from './fonts.js';
import { resolve,isAbsolute,join,relative,sep,basename } from 'node:path';

// In-game text in every site language (platform docs/todo/game-translation.md, layer 1).
// The convention: player-facing text by key (t('start')), one file in the game's own language,
// the platform keeps the translations and serves /i18n/<game>/<lang>.json; the game reads ?lang=
// first (AIWanna.lang() / AIWanna.i18n() in the SDK).
export const siteLanguages=['zh','en','ja','ko','es'];
// Existing game files and explicit language choices remain supported independently of the website menu.
export const supportedGameLanguages=['zh','zh-Hant','en','es','pt-BR','ja','ko','de','fr','ru'];
const skip=new Set(['node_modules','.git','.1gp','.vercel','.next','dist','build','out','coverage','.godot','.import']);
const codeFile=/\.(?:html?|m?js|jsx|ts|tsx|vue|svelte|gd)$/i;
const languageDir=/(?:^|[\\/])(?:i18n|locales?|lang|langs|languages|translations|strings)(?:[\\/]|$)/i;
const fileLocale=name=>{
  const stem=basename(name,'.json').replace(/_/g,'-').toLowerCase();
  if(/^zh-(hant|tw|hk|mo)$/.test(stem))return 'zh-Hant';
  if(/^zh(-hans|-cn|-sg)?$/.test(stem))return 'zh';
  if(/^pt(-br)?$/.test(stem))return 'pt-BR';
  const base=stem.split('-')[0];
  return supportedGameLanguages.includes(base)?base:null;
};
// Inside the project, a regular file, not a symlink: data only.
async function projectFile(directory,path,max=400000){
  const full=resolve(directory,path);
  if(relative(directory,full).startsWith('..')||isAbsolute(relative(directory,full)))throw new Error(`文件必须在项目目录里：${path}`);
  const stat=await lstat(full);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw new Error(`无法读取 ${path}（不是普通文件或超过 ${Math.round(max/1000)} KB）`);
  return readFile(full,'utf8');
}
export async function* walk(directory,base=directory,depth=0){
  if(depth>8)return;
  let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch{return;}
  for(const entry of entries){
    if(entry.isSymbolicLink())continue;
    const full=join(directory,entry.name);
    if(entry.isDirectory()){if(!skip.has(entry.name)&&!entry.name.startsWith('.'))yield* walk(full,base,depth+1);}
    else if(entry.isFile())yield relative(base,full).split(sep).join('/');
  }
}
const flatStrings=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).length>0&&Object.values(value).every(item=>typeof item==='string');

// What the project already does about languages, read without running anything.
export async function checkGameLanguages(projectDirectory){
  if(!isAbsolute(projectDirectory))return {error:'请提供当前游戏项目的绝对路径。'};
  let directory;try{directory=await realpath(resolve(projectDirectory));}catch{return {error:'无法读取项目目录。'};}
  const files=[],signals={readsLangParam:false,readsBrowserLanguage:false,usesSdkLang:false,usesSdkI18n:false,i18nLibrary:false,keyCalls:0,hanTextLines:0};
  let scanned=0;
  for await(const path of walk(directory)){
    if(scanned>3000)break;
    if(path.endsWith('.json')&&(languageDir.test(path)||fileLocale(path))&&fileLocale(path)){
      try{const data=JSON.parse(await projectFile(directory,path));if(flatStrings(data))files.push({path,locale:fileLocale(path),keys:Object.keys(data).length});}catch{}
      continue;
    }
    if(!codeFile.test(path))continue;
    scanned++;
    let text;try{text=await projectFile(directory,path,2000000);}catch{continue;}
    if(/[?&]lang=|searchParams\.get\(\s*['"]lang['"]\)|get\(\s*['"]lang['"]\s*\)/.test(text))signals.readsLangParam=true;
    if(/navigator\.languages?\b|OS\.get_locale\(|TranslationServer/.test(text))signals.readsBrowserLanguage=true;
    if(/AIWanna\.lang\(/.test(text)){signals.usesSdkLang=true;signals.readsLangParam=true;}
    if(/AIWanna\.i18n\(/.test(text)){signals.usesSdkI18n=true;signals.readsLangParam=true;}
    if(/\bi18next\b|vue-i18n|react-intl|@formatjs|\bpolyglot\b/i.test(text))signals.i18nLibrary=true;
    signals.keyCalls+=(text.match(/\bt\(\s*['"][\w.:-]+['"]/g)??[]).length;
    signals.hanTextLines+=text.split('\n').filter(line=>/['"`>][^'"`<]*[一-鿿]/.test(line)).length;
  }
  // Which writing systems the game's own fonts can draw (a missing one falls back to a system font).
  const fonts=[];
  for await(const path of walk(directory)){
    if(!/\.(?:woff2?|ttf|otf)$/i.test(path)||fonts.length>=20)continue;
    try{const stat=await lstat(join(directory,path));if(stat.size>30_000_000)continue;const coverage=fontCoverage(await readFile(join(directory,path)));
      if(coverage)fonts.push({path,covers:Object.entries({latin:'é',han:'中',kana:'あ',hangul:'한',cyrillic:'Ж'}).filter(([,char])=>coverage.has(char.codePointAt(0))).map(([name])=>name)});}catch{}
  }
  const languages=[...new Set(files.map(file=>file.locale))];
  const multilingual=languages.length>1||signals.usesSdkI18n||signals.i18nLibrary;
  const nextSteps=[];
  if(signals.usesSdkI18n)nextSteps.push('已接平台多语言：用 get_game_text_status 核对，再用 upload_game_text 上传改过的原始语言文件和目标语言缺失或过期的翻译。');
  else if(multilingual){
    if(!signals.readsLangParam)nextSteps.push('游戏已有多语言，但打开时没读 ?lang=：改成先读 ?lang=（或 AIWanna.lang()），再看浏览器语言。');
    nextSteps.push(`发布后用 set_game_details 把实际支持的语言（${languages.join(', ')||'检查代码确认'}）告诉平台；要补齐网站目标语言，可以改用平台多语言（键名 + 原始语言文件 + AIWanna.i18n），再 upload_game_text。`);
  }else nextSteps.push('还没做多语言。先问用户「要不要做成多语言」；同意后按 convention 改造：玩家看到的文字换成键名，写一份原始语言 JSON，接 AIWanna.i18n；用你自己的能力补齐目标语言，发布后 upload_game_text 上传。用户不同意就照原样发布。');
  nextSteps.push(`默认目标语言按 ${siteLanguages.join('、')} 的顺序，按需补齐其中除原始语言外缺失或过期的翻译；原始语言不在这五种中时保留原文，并补齐这五种目标。保留已有其他语言，不要求新增它们。`);
  nextSteps.push(`发布后用 set_game_details 按需补齐网站目标语言（${siteLanguages.join('、')}）的游戏名（短、像游戏名，不逐字直译；专有名词可保留）和简介（意思和语气不变、读起来自然），先给用户看；保留已有其他语言名称和简介。`);
  return {multilingual,languages,languageFiles:files.slice(0,40),signals,scannedFiles:scanned,siteLanguages,supportedGameLanguages,nextSteps,convention};
}
export const convention=[
  '玩家看到的文字都用键名显示（t(\'start\')）；游戏只带一份原始语言的 JSON（{"键名": "文字"}，可用 {0}、{name} 占位）。',
  '加载平台 SDK：<script src="https://www.aiwanna.games/sdk/v1.js"></script>，用 AIWanna.i18n({ game: \'<游戏 slug>\', original, originalLang: \'zh\' }).then(t => …) 取文字；请求失败或缺条目时用 original。',
  `默认语言：先读 ?lang=（网站当前提供 ${siteLanguages.join('、')}），没有再看浏览器语言；SDK 的 AIWanna.lang() 已按这个顺序。游戏里可以有语言切换，但打开时必须听 ?lang=；已有其他语言的读取和切换保留。`,
  '字体：中日韩要有能显示这些字的字体，别只用拉丁像素字体；已有其他语言也保留所需字体。按钮和固定宽度的地方给变长的文字留余量。',
  `翻译：默认按 ${siteLanguages.join('、')} 的顺序补齐缺失或过期的目标语言条目，跳过原始语言；原始语言不在这五种中时保留原文并补齐这五种目标。保留已有其他语言，不要求新增它们。按游戏的语气翻，按钮短而清楚，占位符原样保留，专有名词不硬译。每种语言一个 JSON，键名和原始语言文件完全一致。`,
  '游戏名：语言文件里用 meta.title 放这个语言的游戏名，上传时平台用它补上缺的各语言游戏名（和平台已有的不一样时只提醒，不覆盖）。',
  '存档里存键名和参数（比如 {key: "found_item", params: {item: "sword"}}），不存翻译后的文字，这样玩家换语言后，进行中的事件和日志也跟着换。',
  '长度上限：在原始语言文件旁放 <文件名>.limits.json（如 zh.limits.json：{"start": 12, "*": 40}），按显示宽度算（中日韩字算 2，其他算 1）；validate_game_text 会检查。',
].join('\n');

// Upload the game's own file, then each translation (marked as made by the creator's AI).
export async function uploadGameText(platform,projectDirectory,gameSlug,original,translations=[],{force=false,separators=[],use='keys'}={}){
  if(!['keys','phrases'].includes(use))return {error:'文字模式不受支持。',code:'INVALID_USE'};
  const path=`/api/developer/language-files/${encodeURIComponent(gameSlug)}${use==='phrases'?'?use=phrases':''}`,uploaded=[],titles={filled:[],conflicts:[]};
  const fail=(error,failed)=>({...error,uploaded,failed:error.failed??failed});
  const initialPlatform=platform, token=typeof platform.token==='function'?await platform.token():null;
  if(typeof platform.token==='function'&&!token)return fail({error:'请先连接平台。',code:'AUTH_REQUIRED'},'authorization');
  if(token){platform=Object.create(initialPlatform);platform.request=(url,options={})=>initialPlatform.request(url,{...options,token});}
  const changed=async()=>token&&await initialPlatform.token()!==token;
  const accountError={error:'连接账号已变更，请使用当前账号重新检查后继续。',code:'ACCOUNT_CHANGED'};
  if(!isAbsolute(projectDirectory))return fail({error:'请提供当前游戏项目的绝对路径。'},'files');
  let directory;try{directory=await realpath(resolve(projectDirectory));}catch{return fail({error:'无法读取项目目录。'},'files');}
  if(!Array.isArray(translations)||translations.length>supportedGameLanguages.length)return fail({error:'译文列表格式不对。'},'files');
  if(!original&&!translations.length)return fail({error:'请提供原始语言文件或至少一份译文。',code:'NO_FILES'},'files');
  if(original&&!supportedGameLanguages.includes(original.locale))return fail({error:'原始语言代码不受支持。',code:'INVALID_LANGUAGE_FILE'},'original');
  const seen=new Set();
  for(const item of translations){
    if(!item||!supportedGameLanguages.includes(item.locale))return fail({error:'译文语言代码不受支持。',code:'INVALID_LANGUAGE_FILE'},item?.locale??'translation');
    if(seen.has(item.locale))return fail({error:`译文语言重复：${item.locale}`,code:'DUPLICATE_LOCALE'},item.locale);
    if(item.locale===original?.locale)return fail({error:'译文语言不能和原始语言相同。',code:'ORIGINAL_CONFLICT'},item.locale);
    seen.add(item.locale);
  }
  // The remote response is data only: use the registered original's entries, never any remote path.
  let source=original?{locale:original.locale,path:original.path}:null;
  if(!source){
    try{
      const current=await platform.request(path);
      if(!current||typeof current!=='object')return fail({error:'平台原文读取失败。',code:'PLATFORM_ERROR'},'original');
      if(current.error)return fail(current,'original');
      const originals=Object.entries(current.files??{}).filter(([,file])=>file?.source==='original');
      if(!originals.length)return fail({error:'平台还没有登记原文。请把原始语言文件和译文一起上传。',code:'ORIGINAL_REQUIRED'},'original');
      if(originals.length!==1)return fail({error:'平台存在多份原文，请先确认唯一的原始语言。',code:'ORIGINAL_CONFLICT'},'original');
      const [locale,file]=originals[0];
      source={locale,entries:file.entries};
    }catch(error){return fail({error:error.message,code:'ORIGINAL_READ_FAILED'},'original');}
  }
  // Read every local file and validate every upload before writing any of them. Upload the same
  // snapshots we checked, even if a later filesystem edit occurs while requests are in flight.
  const prepared=await prepareGameText(directory,source,translations,{separators});
  if(prepared.error)return fail(prepared,'files');
  if(use==='phrases'&&Object.entries(prepared.original.entries).some(([key,text])=>!text.trim()||text!==text.trim()||key!=='p.'+createHash('sha256').update(text).digest('hex')))
    return fail({error:'原文词表编号必须是原文SHA-256，请重新提取；force不能绕过。',code:'INVALID_PHRASE_ORIGINAL'},'original');
  // Bind every translation to the exact source text that passed local validation. The API
  // checks this fingerprint under the same database lock as the write, including forced uploads.
  const expectedOriginal={locale:prepared.original.locale,hash:createHash('sha256').update(JSON.stringify(Object.keys(prepared.original.entries).sort().map(key=>[key,prepared.original.entries[key]]))).digest('hex')};
  const check=prepared.check;
  if(!check.ok&&!force)return fail({error:'译文检查没通过，先修好再上传（检查结果见 errors）。',code:'TEXT_CHECK_FAILED',...check},check.errors[0]?.locale??'files');
  const queue=[...(original?[{...prepared.original,kind:'original'}]:[]),...prepared.translations.map(item=>({...item,kind:'translation',by:'ai_creator',expectedOriginal}))];
  for(const item of queue)if(Buffer.byteLength(JSON.stringify(item))>400000)return fail({error:`${item.locale} 的上传内容不能超过 400 KB。`,code:'INVALID_LANGUAGE_FILE'},item.locale);
  const note=result=>{if(result.titleSync){titles.filled.push(...(result.titleSync.filled??[]));titles.conflicts.push(...(result.titleSync.conflicts??[]));}};
  let failed=queue[0]?.locale??'files';
  try{
    for(const item of queue){
      failed=item.locale;
      if(await changed())return fail(accountError,failed);
      const result=await platform.request(path,{method:'PUT',body:item});
      if(!result||typeof result!=='object')return fail({error:'平台返回异常响应，请查询状态后继续。',code:'PLATFORM_ERROR'},failed);
      if(result.error)return fail(result,failed);
      if(!Array.isArray(result.status)||!result.files||typeof result.files!=='object'||!result.files[item.locale]||typeof result.files[item.locale].entries!=='object')return fail({error:'平台没有返回有效的上传确认，请查询状态后继续。',code:'PLATFORM_ERROR',unconfirmed:item.locale},failed);
      uploaded.push(item.locale);note(result);
    }
    failed='status';
    if(await changed())return fail(accountError,failed);
    const status=await gameTextStatus(platform,gameSlug,{use});
    if(await changed())return fail(accountError,failed);
    if(status.error)return fail(status,failed);
    return {ok:true,uploaded,
      // meta.title fills a language's game name the platform did not have; a different one is only reported.
      ...(titles.filled.length||titles.conflicts.length?{gameNames:{...titles,next:titles.conflicts.length?'这些语言的 meta.title 和平台上的游戏名不一样，平台没有改。给用户看，确认后用 set_game_details 设置。':'meta.title 已填进这些语言的游戏名。'}}:{}),
      warnings:check.warnings,fonts:check.fonts,...(check.errors.length?{forced:true,errors:check.errors}:{}),...status};
  }catch(error){return fail({error:error.message},failed);}
}
// Per language: up to date, missing keys, or made from an older original (only those need translating).
export async function gameTextStatus(platform,gameSlug,{use='keys'}={}){
  if(!['keys','phrases'].includes(use))return {error:'文字模式不受支持。',code:'INVALID_USE'};
  const data=await platform.request(`/api/developer/language-files/${encodeURIComponent(gameSlug)}${use==='phrases'?'?use=phrases':''}`);
  if(data?.error)return data;
  if(!data||typeof data!=='object'||!Array.isArray(data.status)||data.status.some(item=>!item||typeof item!=='object'||!supportedGameLanguages.includes(item.locale)||typeof item.state!=='string'))return {error:'平台返回异常状态，请稍后查询。',code:'PLATFORM_ERROR'};
  return {platformTranslation:data.engine??null,status:(data.status??[]).map(item=>({locale:item.locale,state:item.state,total:item.total,done:item.done,missing:item.missing,stale:item.stale,editedByCreator:item.edited}))};
}
export async function setGameDetails(platform,gameSlug,{titles,descriptions,languages}){
  return platform.request(`/api/developer/language-files/${encodeURIComponent(gameSlug)}`,{method:'PATCH',body:{...(titles?{titles}:{}),...(descriptions?{descriptions}:{}),...(languages?{languages}:{})}});
}
