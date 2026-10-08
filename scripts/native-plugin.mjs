import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { JsonLines } from '../server/providers.mjs';
import { desktopCodexBinary } from '../server/native-codex.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] || 'list';
const cli = desktopCodexBinary();
if (!cli || !existsSync(cli)) throw new Error('未找到本机原生 Codex CLI。');
const child = spawn(cli, ['app-server'], { cwd: root, stdio: ['pipe','pipe','pipe'], windowsHide: true });
let serial = 0;
const pending = new Map();
let diagnostic = '';
const write = frame => child.stdin.write(JSON.stringify(frame)+'\n');
const parser = new JsonLines(frame => {
  if (frame.id !== undefined && frame.method) { write({id:frame.id,error:{code:-32601,message:'Unsupported host request'}}); return; }
  const item = pending.get(frame.id);
  if (!item) return;
  pending.delete(frame.id); clearTimeout(item.timer);
  if (frame.error) item.reject(new Error(String(frame.error.message).replace(/\bsk-[\w-]+/g,'[credential hidden]')));
  else item.resolve(frame.result);
}, error => { for(const item of pending.values()) item.reject(error); pending.clear(); });
child.stdout.on('data', chunk => parser.push(chunk));
child.stderr.on('data', chunk => { diagnostic=(diagnostic+chunk.toString()).slice(-1500); });
child.on('exit', () => { for(const item of pending.values()) { clearTimeout(item.timer);item.reject(new Error('Codex 控制进程已关闭：'+diagnostic.replace(/\bsk-[\w-]+/g,'[credential hidden]').replace(/eyJ[\w.-]+/g,'[token hidden]'))); } pending.clear(); });
const request = (method, params) => new Promise((resolvePromise,reject) => {
  const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Codex 控制请求超时'));},30_000);
  pending.set(id,{resolve:resolvePromise,reject,timer});write({id,method,params});
});
function findMarketplace(value) {
  if (!value || typeof value!=='object') return;
  if (value.name==='relay-local' && typeof value.path==='string') return value;
  for(const item of Object.values(value)){if(Array.isArray(item)){for(const row of item){const found=findMarketplace(row);if(found)return found;}}else{const found=findMarketplace(item);if(found)return found;}}
}
try {
  await request('initialize',{clientInfo:{name:'relay_plugin_setup',title:'异智能体本地安装',version:'0.2.0'},capabilities:{experimentalApi:true}});
  write({method:'initialized'});
  const catalog=await request('plugin/list',{cwds:[join(root,'plugin')],marketplaceKinds:['local']});
  const marketplace=findMarketplace(catalog);
  if (!marketplace) { console.log(JSON.stringify({found:false,catalogKeys:Object.keys(catalog)})); throw new Error('Codex 未发现本地异智能体市场。'); }
  if(command==='install'){
    const result=await request('plugin/install',{marketplacePath:marketplace.path,pluginName:'relay-native'});
    console.log(JSON.stringify({installed:true,authPolicy:result.authPolicy,authenticationRequired:(result.appsNeedingAuth||[]).some(app=>app.needsAuth)}));
  } else if(command==='list') console.log(JSON.stringify(marketplace));
  else if(command==='mcp'){
    const thread=await request('thread/start',{cwd:root,ephemeral:true,approvalPolicy:'never',sandbox:'read-only'});
    const result=await request('mcpServerStatus/list',{threadId:thread.thread.id,limit:100});
    const entries=result.data||result.servers||[];
    console.log(JSON.stringify({servers:entries.filter(entry=>entry.name?.includes('relay')).map(entry=>({name:entry.name,status:entry.runtimeStatus,hasIcon:Boolean(entry.serverInfo?.icons?.length),tools:Object.keys(entry.tools||{}),entrypoints:entry.tools?.open_relay_workspace?._meta?.['openai/ui']?.entrypoints,resources:(entry.resources||[]).map(row=>row.uri)}))}));
  }
  else if(command==='verify'){
    const result=await request('plugin/read',{marketplacePath:marketplace.path,pluginName:'relay-native'});
    console.log(JSON.stringify(result));
  } else throw new Error('只支持 list、install、verify。');
} finally { for(const item of pending.values())clearTimeout(item.timer); child.stdin.end();child.kill();child.stdout.destroy();child.stderr.destroy(); }
