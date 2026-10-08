import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineBundle, RESOURCE_URI, PANEL_URI } from './relay-native/server.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '..');
const target = join(directory, 'relay-native', 'dist');
await readFile(join(directory, 'relay-native', 'assets', 'icon.png'));
await readFile(join(root, 'dist', 'index.html'));
await mkdir(target, { recursive: true });
await cp(join(root, 'dist'), target, { recursive: true });
await inlineBundle(target);
for (const name of ['mcp.json', '.mcp.json']) {
  const path = join(directory, 'relay-native', name);
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = await readFile(join(directory, 'relay-native', 'mcp.example.json'), 'utf8');
  }
  const config = JSON.parse(source);
  if (name === 'mcp.json') {
    config.$schema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
    config.mcpServers.relay_native.type = 'stdio';
  }
  config.mcpServers.relay_native.args = [join(directory, 'relay-native', 'server.mjs')];
  config.mcpServers.relay_native.cwd = join(directory, 'relay-native');
  config.mcpServers.relay_native.env.RELAY_PROJECT_ROOT = root;
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
await writeFile(join(directory, 'relay-native', 'build-info.json'), JSON.stringify({
  packagedAt: new Date().toISOString(),
  resourceUri: RESOURCE_URI,
  panelUri: PANEL_URI,
  entrypoints: ['global', 'thread'],
  transport: 'stdio',
  nativeHostRendering: 'requires-installation-and-ui-verification',
}, null, 2) + '\n', 'utf8');
process.stdout.write('原生 MCP 插件包已更新：plugin/relay-native。尚未安装或验证宿主入口。\n');
