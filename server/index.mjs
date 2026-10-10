import { createServer } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, ActionError } from './engine.mjs';
import { loadLocalConfig } from '../scripts/local-config.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isMain = Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) await loadLocalConfig(projectRoot);
const providers = await import('./providers.mjs');
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256_000) throw new ActionError('请求内容过大', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ActionError('请求必须是有效 JSON'); }
}

export function createAppServer({ engine, workspace = process.env.RELAY_WORKSPACE || projectRoot, host = '127.0.0.1', port = 4318, assetsRoot = join(projectRoot, 'dist'), modelCatalogProvider = providers } = {}) {
  const orchestrator = engine ?? new Orchestrator({ providers, workspace, persistencePath: join(projectRoot, '.relay', 'state.json') });
  const clients = new Set();
  const trustedOrigins = new Set([
    `http://127.0.0.1:${port}`, `http://localhost:${port}`,
    'http://127.0.0.1:5173', 'http://localhost:5173',
    ...(process.env.RELAY_UI_ORIGIN ? [process.env.RELAY_UI_ORIGIN] : []),
  ]);
  const server = createServer(async (request, response) => {
    try {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      const url = new URL(request.url || '/', `http://${host}:${port}`);
      if (url.pathname.startsWith('/api/') && request.headers.origin && !trustedOrigins.has(request.headers.origin)) {
        sendJson(response, { error: '这个来源不能访问本地协作服务' }, 403); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') { sendJson(response, orchestrator.getState()); return; }
      if (request.method === 'GET' && url.pathname === '/api/capabilities') { sendJson(response, await orchestrator.getCapabilities()); return; }
      if (request.method === 'GET' && url.pathname === '/api/models') {
        const provider = url.searchParams.get('provider') || 'codex';
        if (!['codex', 'deepseek'].includes(provider)) throw new ActionError('模型提供商无效');
        sendJson(response, await modelCatalogProvider.getModels({ provider })); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/context') { sendJson(response, { workspace: orchestrator.workspace, version: '0.5.2' }); return; }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
        });
        response.write(`event: snapshot\ndata: ${JSON.stringify(orchestrator.getState())}\n\n`);
        const unsubscribe = orchestrator.subscribe((state) => {
          if (!response.destroyed) response.write(`event: snapshot\ndata: ${JSON.stringify(state)}\n\n`);
        });
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': heartbeat\n\n'); }, 20_000);
        clients.add(response);
        const cleanup = () => { clearInterval(heartbeat); unsubscribe(); clients.delete(response); };
        response.on('close', cleanup); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/actions') {
        const state = await orchestrator.action(await readJson(request)); sendJson(response, state); return;
      }
      if (url.pathname.startsWith('/api/')) { sendJson(response, { error: '接口不存在' }, 404); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { sendJson(response, { error: '方法不支持' }, 405); return; }

      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new ActionError('无效 URL'); }
      const assetBase = resolve(assetsRoot);
      let file = resolve(assetBase, `.${pathname}`);
      if (file !== assetBase && !file.startsWith(`${assetBase}${sep}`)) { sendJson(response, { error: '无效文件路径' }, 403); return; }
      if (!existsSync(file) || !statSync(file).isFile()) file = join(assetBase, 'index.html');
      if (!existsSync(file)) { sendJson(response, { error: '前端尚未构建。开发请运行 npm run dev；发布请先运行 npm run build。' }, 404); return; }
      response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
      if (request.method === 'HEAD') { response.end(); return; }
      createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (!response.headersSent) sendJson(response, { error: error.message || '服务出错' }, error.status || 500);
      else response.end();
    }
  });
  const close = () => {
    orchestrator.close();
    for (const client of clients) client.end();
    server.close();
  };
  return { server, engine: orchestrator, close };
}

if (isMain) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4318);
  const app = createAppServer({ host, port });
  app.server.listen(port, host, () => {
    process.stdout.write(`Relay 协作服务：http://${host}:${port}\n默认演示模式；状态保存在 .relay/state.json\n`);
  });
  app.server.on('error', (error) => { process.stderr.write(`服务启动失败：${error.message}\n`); process.exitCode = 1; });
  let stopping = false;
  const shutdown = () => { if (stopping) return; stopping = true; app.close(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
