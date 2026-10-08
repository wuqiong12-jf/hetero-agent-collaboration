import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';

// Change only this installed MCP server's UI cache version. Other settings,
// credentials and the user's model configuration remain byte-for-byte intact.
const manifest=JSON.parse(await readFile(new URL('../plugin/relay-native/.codex-plugin/plugin.json',import.meta.url),'utf8'));
if(!/^\d+\.\d+\.\d+$/.test(manifest.version))throw new Error('Invalid local UI version');
const path=join(homedir(),'.codex','config.toml');
const source=await readFile(path,'utf8');
const section=source.match(/^\[mcp_servers\.relay_native\.env\][^\r\n]*\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/m);
if(!section)throw new Error('未找到已安装 relay_native 的环境配置，未改写其他设置。');
const line=/^RELAY_UI_VERSION\s*=\s*"[^"]*"[^\r\n]*/m;
const ending=section[0].includes('\r\n')?'\r\n':'\n';
const block=line.test(section[0])?section[0].replace(line,()=>`RELAY_UI_VERSION = "${manifest.version}"`):section[0]+`RELAY_UI_VERSION = "${manifest.version}"${ending}`;
const next=source.slice(0,section.index)+block+source.slice(section.index+section[0].length);
if(next!==source){
  const temporary=join(homedir(),'.codex',`relay-ui-${randomUUID()}.tmp`);
  try{
    await writeFile(temporary,next,'utf8');
    for(let attempt=0;;attempt++){
      try{await rename(temporary,path);break;}
      catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=3)throw error;await new Promise(resolve=>setTimeout(resolve,[80,200,500][attempt]));}
    }
  }finally{await unlink(temporary).catch(()=>{});}
}
process.stdout.write(`原生 UI 缓存版本：${manifest.version}\n`);
