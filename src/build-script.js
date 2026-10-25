const unsupported=()=>{throw new Error('UNSUPPORTED_BUILD: 无法可靠检查此构建脚本的 shell 或包管理器调用。请使用明确的本地命令和已有 npm 脚本；复杂脚本请先在本地审阅并构建，再上传已有产物。');};
const scriptName=/^[A-Za-z0-9:_-]{1,80}$/;
const executable=word=>word.replaceAll('\\','/').split('/').at(-1).toLowerCase().replace(/\.(?:cmd|exe|bat)$/,'');

// A deliberately limited static shell grammar, not a shell interpreter or security sandbox.
// Preserve quoted arguments/concatenation and command boundaries. Reject expansion, redirection,
// grouping and platform-specific escaping rather than guessing which script they will execute.
function commands(source) {
  const result=[];let words=[],word='',started=false,quote=null;
  const push=()=>{if(started){words.push(word);word='';started=false;}};
  const finish=()=>{push();if(words.length){result.push(words);words=[];}};
  for(let i=0;i<source.length;i++) {
    const char=source[i],next=source[i+1];
    if(char==='`'||char==='$'&&quote!=="'"&&/[\w{(]/.test(next||'')||char==='%'&&/^%[^%\s]+%/.test(source.slice(i))||char==='!'&&/^![^!\s]+!/.test(source.slice(i)))unsupported();
    if(quote) {
      if(char===quote){quote=null;continue;}
      if(quote==='"'&&char==='\\'&&['"','\\','$'].includes(next)){word+=next;i++;continue;}
      word+=char;continue;
    }
    if(char==='"'||char==="'"){quote=char;started=true;continue;}
    if(char==='\\'&&next&&/[\s"'\\$]/.test(next)){started=true;if(next!=='\n'&&next!=='\r')word+=next;i++;continue;}
    if(/[()<>^]/.test(char)||char==='#'&&!started)unsupported();
    if(char==='\n'||char==='\r'||/[;&|]/.test(char)){finish();continue;}
    if(/\s/.test(char)){push();continue;}
    word+=char;started=true;
  }
  if(quote)unsupported();finish();return result;
}

const booleanFlags=new Set(['s','silent','if-present','ignore-scripts','color','no-color','colors','no-colors','verbose','quiet','q','offline','prefer-offline','prefer-online','progress','no-progress','timing','no-timing']);
const valueFlags=new Set(['loglevel','log-level','reporter','color','cache']);
const otherProjectFlags=new Set(['prefix','workspace','workspaces','w','c','cwd','dir','directory','filter','f','global','g']);
function packageArguments(words) {
  const args=[];
  // -- forwards the remaining words to the selected script; those are not npm invocations.
  for(let i=0;i<words.length&&words[i]!=='--';i++) {
    const word=words[i];
    if(!word.startsWith('-')){args.push(word);continue;}
    const match=/^--?([\w-]+)(?:=(.*))?$/.exec(word);if(!match)unsupported();
    const flag=match[1].toLowerCase();
    if(otherProjectFlags.has(flag))unsupported(); // Its scripts cannot be resolved from this package.json.
    if(booleanFlags.has(flag))continue;
    if(valueFlags.has(flag)){if(match[2]===undefined&&(!words[++i]||words[i].startsWith('-')))unsupported();continue;}
    unsupported();
  }
  return args;
}

function nestedScripts(words,pkg) {
  const index=words.findIndex(word=>['npm','pnpm','yarn'].includes(executable(word)));
  if(index<0)return [];
  const tool=executable(words[index]),args=packageArguments(words.slice(index+1)),command=args[0];
  let name;
  if(['run','run-script','rum','urn'].includes(command))name=args[1];
  else if(tool==='npm')name=({test:'test',t:'test',tst:'test',start:'start',stop:'stop',restart:'restart'})[command];
  else if(!['exec','dlx','install','add','create','update','remove','rebuild','publish','pack'].includes(command))name=command;
  if(!name||!scriptName.test(name)||typeof pkg.scripts[name]!=='string')unsupported();
  return [`pre${name}`,name,`post${name}`];
}

export function validateBuildScript(pkg,script) {
  if(script===undefined)return;
  if(!scriptName.test(script)||typeof pkg?.scripts?.[script]!=='string'||!pkg.scripts[script].trim())throw new Error('UNSUPPORTED_BUILD: build_script 必须是 package.json 中已有的 npm 脚本名称。');
  const seen=new Set();
  function inspect(name) {
    if(seen.has(name))return;seen.add(name);
    const command=pkg.scripts[name];if(typeof command!=='string')return;
    for(const words of commands(command)) {
      if(words.some(word=>/^(?:vercel|vc)(?:@[^\s]+)?$/.test(executable(word))))throw new Error('UNSUPPORTED_BUILD: 构建脚本不能调用 Vercel CLI。请使用无需 Vercel 登录或云项目的本地框架适配器生成 Build Output API v3 产物，由 AIWANNA 统一部署。');
      if(words.some(word=>['sh','bash','zsh','dash','cmd','powershell','pwsh','eval'].includes(executable(word)))||['if','for','while','case','function'].includes(words[0]))unsupported();
      if(words.some(word=>executable(word)==='npx')&&words.some(word=>/^(-c|--call|--shell)(=|$)/.test(word)))unsupported();
      for(const nested of nestedScripts(words,pkg))inspect(nested);
    }
  }
  for(const name of [`pre${script}`,script,`post${script}`])inspect(name);
}
