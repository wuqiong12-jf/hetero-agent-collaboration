import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const icon = {src:'data:image/png;base64,'+readFileSync(join(pluginRoot,'assets','icon.png')).toString('base64'),mimeType:'image/png',sizes:['256x256']};
export const RESOURCE_URI = 'ui://relay/v0.5.2/workspace';
export const PANEL_URI = 'ui://relay/v0.5.2/panel';
export const RESOURCE_MIME = 'text/html;profile=mcp-app';
const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const emptyInput = { type: 'object', properties: {}, additionalProperties: false };
const entryMetadata = {
  ui: { resourceUri: RESOURCE_URI },
  'openai/ui': { entrypoints: [{ type: 'global' }] },
  'openai/outputTemplate': RESOURCE_URI,
};
const waitSchema = { type: 'integer', minimum: 0, maximum: 45 };

export const tools = [
  {
    name: 'open_relay_panel',
    title: '异智能体',
    icons: [icon],
    description: '在当前对话旁打开第二智能体；保留原生 Codex 对话和工作界面。',
    inputSchema: emptyInput,
    annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    _meta:{ui:{resourceUri:PANEL_URI},'openai/ui':{entrypoints:[{type:'thread'}]},'openai/outputTemplate':PANEL_URI},
  },
  {
    name: 'open_relay_workspace',
    icons: [icon],
    title: '异智能体合作',
    description: '打开异智能体合作应用。可作为全局侧栏应用或当前对话的侧面板；打开界面本身不调用推理模型。',
    inputSchema: {
      ...emptyInput,
      properties: { view: { type: 'string', enum: ['split', 'deepseek'], default: 'split' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: entryMetadata,
  },
  {
    name: 'agent_team_status',
    title: '查看智能体团队与工作者结果',
    description: '原生 Codex 监工查看现有团队、工作目录和真实/演示状态。概览即时返回，指定 agentId 与 sessionId/messageId 继续等待时默认等30秒，显式 waitSeconds=0 则即时返回，最长等45秒。返回的是未验收内容，监工须按验收条件自行核查。继续等待委托时传回 sessionId 和 messageId，避免把新会话或其他回复当作原任务。隐藏只影响界面，不停止智能体。本工具不调用推理、派单或修改团队配置。',
    inputSchema: { type: 'object', properties: {
      agentId: { type: 'string', minLength: 1, maxLength: 256 },
      sessionId: { type: 'string', minLength: 1, maxLength: 256 },
      messageId: { type: 'string', minLength: 1, maxLength: 256 },
      waitSeconds: { ...waitSchema, description: '概览默认0；指定工作者与会话/消息引用时默认30。' },
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delegate_agent_task',
    title: '派任务给现有工作智能体',
    description: '原生 Codex 主聊天直接向现有非负责人工作者发送独立任务及验收条件；只调用指定工作者，不创建后台 Codex 规划/审核会话，不切换运行模式、合作模式或预算。自动合作运行、目标工作者忙碌或选择负责人时拒绝。任务按手动聊天计入真实提供方调用量，不使用自动调度预算。默认等30秒，最长等45秒；显式 waitSeconds=0 可先派单后指挥其他工作者。未结束则返回 sessionId/messageId，使用 agent_team_status 继续等待。工作者输出尚未验收：监工必须按criteria检查实际证据，再决定返工或分配下一项。演示模式只产生明确标记的模拟回复；隐藏工作者仍可执行。',
    inputSchema: { type: 'object', properties: {
      agentId: { type: 'string', minLength: 1, maxLength: 256 },
      task: { type: 'string', minLength: 1, maxLength: 12000 },
      criteria: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 4000 } },
      waitSeconds: { ...waitSchema, default: 30 },
    }, required: ['agentId', 'task', 'criteria'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'relay_request',
    title: '异智能体界面请求',
    description: '仅供应用界面访问本地协作服务的指定接口；浏览与刷新不调用模型，发送或运行由用户在界面触发。',
    inputSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', description: '/api/state、/api/capabilities、/api/context、/api/models（可带 provider=codex 或 deepseek）、/api/actions。' },
        method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
        body: { type: 'object', additionalProperties: true },
      },
      required: ['route'], additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' }, status: { type: 'integer' },
        data: {}, error: { type: 'string' },
      },
      required: ['ok', 'status', 'data'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
  },
];

function rpcError(message, code = -32602) { return Object.assign(new Error(message), { code }); }
function text(value, max = 200) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function publicResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function validateTeamArgs(args, delegation = false) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw rpcError('工具参数必须是对象。');
  const allowed = delegation ? ['agentId', 'task', 'criteria', 'waitSeconds'] : ['agentId', 'sessionId', 'messageId', 'waitSeconds'];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw rpcError('工具包含不支持的参数。');
  const waitSeconds = args.waitSeconds ?? (delegation || (args.agentId && (args.sessionId || args.messageId)) ? 30 : 0);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 45) throw rpcError('waitSeconds 必须是0到45的整数。');
  for (const key of delegation ? ['agentId'] : ['agentId', 'sessionId', 'messageId']) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 256)) throw rpcError(`${key} 必须是有效标识。`);
  }
  if (!delegation) {
    if ((args.sessionId || args.messageId || waitSeconds) && !args.agentId) throw rpcError('指定会话、消息或等待时必须同时指定 agentId。');
    if (args.messageId && !args.sessionId) throw rpcError('指定 messageId 时必须同时指定 sessionId。');
    return { ...args, waitSeconds };
  }
  if (!args.agentId || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 12000) throw rpcError('委托需要现有工作者 agentId 和有效任务。');
  if (!Array.isArray(args.criteria) || !args.criteria.length || args.criteria.length > 32 || args.criteria.some(item => typeof item !== 'string' || !item.trim() || item.length > 4000)) throw rpcError('criteria 必须包含1到32条非空验收条件。');
  const task = args.task.trim();
  const criteria = args.criteria.map(item => item.trim());
  const prompt = `来自当前原生 Codex 监工的独立委托。\n任务：\n${task}\n验收条件（由监工核查）：\n${criteria.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n完成实际工作后，报告产物位置、实际检查与结果、尚未解决的问题。没有执行的步骤必须明确说明。不要宣称已经验收通过，也不要自行派发其他任务或更改协作配置。`;
  if (prompt.length > 12000) throw rpcError('任务、验收条件及委托说明合计不能超过12000字符。');
  return { agentId: args.agentId, task, criteria, prompt, waitSeconds };
}

function compactUsage(value = {}) {
  const result = {};
  for (const key of ['supervisorCalls', 'workerCalls', 'autoSupervisorCalls', 'autoWorkerCalls', 'inputTokens', 'outputTokens']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  for (const key of ['providerCalls', 'autoProviderCalls']) {
    const source = value[key];
    if (!source || typeof source !== 'object') continue;
    result[key] = Object.fromEntries(['codex', 'deepseek'].filter(provider => Number.isFinite(source[provider]) && source[provider] >= 0).map(provider => [provider, source[provider]]));
  }
  return result;
}

function teamSnapshot(state, workspace) {
  const executionSummary = Object.fromEntries(['readers', 'writers', 'retiringReaders', 'retiringWriters']
    .filter(key => Number.isSafeInteger(state.executionSummary?.[key]) && state.executionSummary[key] >= 0)
    .map(key => [key, state.executionSummary[key]]));
  const maxParallelReaders = state.settings?.maxParallelReaders;
  return {
    mode: state.mode, collaborationMode: state.collaborationMode, phase: state.phase,
    workspace: text(workspace, 2000), leaderId: text(state.leaderId, 256),
    team: state.agents.map(agent => ({
      id: text(agent.id, 256), name: text(agent.name), provider: text(agent.provider, 40),
      model: text(agent.modelId || agent.model, 256), reasoningEffort: text(agent.reasoningEffort || 'auto', 40),
      accessMode: agent.accessMode === 'read-only' ? 'read-only' : 'workspace-write',
      hidden: agent.hidden === true, status: text(agent.status, 40), leader: agent.id === state.leaderId,
    })),
    usage: compactUsage(state.usage),
    executionSummary,
    limits: Number.isSafeInteger(maxParallelReaders) && maxParallelReaders >= 1 && maxParallelReaders <= 4 ? { maxParallelReaders } : {},
    notice: state.mode === 'demo' ? '演示模式：模拟输出，不代表真实模型或工具执行。' : '真实模式。工作者公开输出尚未验收，监工应独立核查证据。',
  };
}

function chatResult(state, agentId, expectedSessionId, expectedMessageId) {
  const session = state.chatSessions?.[agentId];
  if (!session || (expectedSessionId && session.id !== expectedSessionId)) {
    return { sessionId: expectedSessionId, messageId: expectedMessageId, status: 'changed', error: '工作者会话已更换或移除；未把新会话输出当作原任务结果。' };
  }
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const replies = messages.filter(message => message.agentId === agentId && message.conversationId === session.id && message.role === 'assistant' && message.kind === 'message');
  const reply = expectedMessageId ? replies.find(message => message.id === expectedMessageId) : replies.at(-1);
  if (expectedMessageId && !reply) return { sessionId: session.id, messageId: expectedMessageId, status: 'changed', error: '对应回复已不在当前会话中；未读取其他工作者或其他消息的结果。' };
  const status = reply?.status === 'completed' ? 'completed' : reply?.status === 'error' ? 'error'
    : reply?.status === 'cancelled' ? 'cancelled' : reply?.status === 'streaming' || session.status === 'running' ? 'running' : session.lastError ? 'error' : 'idle';
  const output = text(reply?.text, 24000);
  return {
    sessionId: session.id, ...(reply?.id ? { messageId: reply.id } : {}), status,
    ...(output ? { output, ...(reply.text.length > output.length ? { outputTruncated: true } : {}) } : {}),
    ...(status === 'error' ? { error: text(session.lastError || reply?.text || '工作者执行未完成。', 1200) } : {}),
    ...(status === 'cancelled' ? { error: '这一条工作者回复已取消，不能作为完成交付。' } : {}),
    reviewStatus: 'unreviewed',
  };
}
function loopbackBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('RELAY_API_BASE 必须是没有凭证或路径的本机 HTTP 服务地址。');
  }
  return url;
}

export function validateRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw rpcError('请求参数必须是对象。');
  if (Object.keys(args).some(key => !['route', 'method', 'body'].includes(key))) throw rpcError('请求包含不支持的参数。');
  const method = args.method ?? 'GET';
  if (!['GET', 'POST'].includes(method) || typeof args.route !== 'string') throw rpcError('请求方法或接口无效。');
  const simpleReads = new Set(['/api/state', '/api/capabilities', '/api/context', '/api/models']);
  const modelsQuery = /^\/api\/models\?provider=(codex|deepseek)$/;
  if (method === 'GET' && (simpleReads.has(args.route) || modelsQuery.test(args.route))) {
    if (args.body !== undefined) throw rpcError('读取请求不接受 body。');
  } else if (method === 'POST' && args.route === '/api/actions') {
    if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) throw rpcError('操作请求必须提供对象 body。');
    if (Buffer.byteLength(JSON.stringify(args.body)) > 256_000) throw rpcError('操作内容过大。');
  } else throw rpcError('这个接口或方法不在应用允许范围内。');
  return { route: args.route, method, body: args.body };
}

async function bundleFile(root, asset) {
  if (!asset.startsWith('/assets/') && !asset.startsWith('./assets/') && !asset.startsWith('assets/')) throw rpcError('UI 包包含不支持的外部资源。');
  const base = await realpath(root);
  const target = await realpath(resolve(base, asset.replace(/^\.?\//, '')));
  if (!target.startsWith(base + sep)) throw rpcError('UI 资源必须在插件构建目录内。');
  return readFile(target, 'utf8');
}

export async function inlineBundle(distRoot) {
  let html;
  try { html = await readFile(join(distRoot, 'index.html'), 'utf8'); }
  catch { throw rpcError('原生界面尚未打包。请先 npm run build，再运行 node plugin/package.mjs。', -32001); }
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>\s*<\/script>/gi)];
  const links = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*['"]stylesheet['"][^>]*>/gi)];
  if (!scripts.length) throw rpcError('原生界面包缺少应用脚本。', -32001);
  for (const match of scripts) {
    const javascript = (await bundleFile(distRoot, match[1])).replace(/<\/script/gi, '<\\/script');
    html = html.replace(match[0], () => `<script type="module">${javascript}</script>`);
  }
  for (const match of links) {
    const href = match[0].match(/\bhref\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (!href) throw rpcError('原生界面样式地址无效。');
    const css = (await bundleFile(distRoot, href)).replace(/<\/style/gi, '<\\/style');
    html = html.replace(match[0], () => `<style>${css}</style>`);
  }
  html = html.replace(/<link\b[^>]*\brel\s*=\s*['"]modulepreload['"][^>]*>/gi, '');
  const flag = '<script>window.__RELAY_NATIVE__=true;</script>';
  return html.replace(/<head>/i, `<head>${flag}`);
}

export function createProtocol({ distRoot = join(pluginRoot, 'dist'), apiBase = process.env.RELAY_API_BASE || 'http://127.0.0.1:4318', fetcher = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, pollIntervalMs = 500 } = {}) {
  const base = loopbackBase(apiBase);
  let starting;
  const ensureService = async () => {
    const ready = async () => {
      try { const response = await fetcher(new URL('/api/context',base),{signal:AbortSignal.timeout(1500),redirect:'error'}); return response.ok; }
      catch { return false; }
    };
    if (await ready()) return;
    const root = process.env.RELAY_PROJECT_ROOT;
    if (!root) throw new Error('本地服务尚未启动。');
    if (!starting) starting = (async () => {
      await readFile(join(root,'server','index.mjs'));
      const process = spawn(globalThis.process.execPath,[join(root,'server','index.mjs')],{
        cwd:root,detached:true,windowsHide:true,stdio:'ignore',env:globalThis.process.env,
      });
      process.on('error',()=>{}); process.unref();
      for(let attempt=0;attempt<15;attempt++) {await new Promise(resolve=>setTimeout(resolve,500));if(await ready())return;}
      throw new Error('本地服务未能启动。');
    })().finally(()=>{starting=undefined;});
    await starting;
  };
  const resource = {
    uri: RESOURCE_URI, name: 'relay-workspace', title: '异智能体合作',
    mimeType: RESOURCE_MIME, description: 'Codex 与 DeepSeek 协作应用，支持全局入口与对话侧面板。',
  };
  const proxy = async (args, { ensure = true, timeoutMs = 60000 } = {}) => {
    const request = validateRequest(args);
    try {
      if (ensure) await ensureService();
      const response = await fetcher(new URL(request.route, base), {
        method: request.method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: request.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      const data = await response.json();
      const result = { ok: response.ok, status: response.status, data };
      if (!response.ok) result.error = typeof data?.error === 'string' ? data.error : '本地协作请求未完成。';
      return result;
    } catch {
      return { ok: false, status: 503, data: null, error: '无法连接本地协作服务。请启动项目服务后重试。' };
    }
  };
  const readState = async (timeoutMs = 5000) => {
    const result = await proxy({ route: '/api/state' }, { ensure: false, timeoutMs });
    if (!result.ok || !Array.isArray(result.data?.agents)) throw rpcError(result.error || '本地团队状态无效。', -32001);
    return result.data;
  };
  const readTeam = async () => {
    await ensureService();
    const [state, context] = await Promise.all([readState(), proxy({ route: '/api/context' }, { ensure: false, timeoutMs: 5000 })]);
    if (!context.ok || typeof context.data?.workspace !== 'string') throw rpcError('无法核实工作目录。', -32001);
    return { state, workspace: context.data.workspace };
  };
  const waitForReply = async (state, reference, waitSeconds, maximumDeadline = Infinity) => {
    const deadline = Math.min(now() + waitSeconds * 1000, maximumDeadline);
    let chat = chatResult(state, reference.agentId, reference.sessionId, reference.messageId);
    while (chat.status === 'running' && now() < deadline) {
      await sleep(Math.min(pollIntervalMs, deadline - now()));
      if (now() >= deadline) break;
      try { state = await readState(Math.max(1, Math.min(5000, deadline - now()))); }
      catch (error) { return { state, chat: { ...chat, status: 'unknown', error: text(error.message, 1200) } }; }
      if (reference.mode && state.mode !== reference.mode) return { state, chat: { sessionId: reference.sessionId, messageId: reference.messageId, status: 'changed', error: '等待期间真实/演示模式发生变化；未把新模式的结果当作原委托。' } };
      chat = chatResult(state, reference.agentId, reference.sessionId, reference.messageId);
    }
    return { state, chat };
  };
  const statusTool = async args => {
    const deadline = now() + 80000;
    const request = validateTeamArgs(args ?? {});
    const { state: initial, workspace } = await readTeam();
    if (!request.agentId) return publicResult(teamSnapshot(initial, workspace));
    if (!initial.agents.some(agent => agent.id === request.agentId)) return publicResult({ ...teamSnapshot(initial, workspace), agentId: request.agentId, status: 'rejected', error: '这个智能体不在当前团队中。' }, true);
    const sessionId = request.sessionId || initial.chatSessions?.[request.agentId]?.id;
    const first = chatResult(initial, request.agentId, sessionId, request.messageId);
    const reference = { agentId: request.agentId, sessionId, messageId: request.messageId || first.messageId, mode: initial.mode };
    const { state, chat } = await waitForReply(initial, reference, request.waitSeconds, deadline);
    return publicResult({ ...teamSnapshot(state, workspace), agentId: request.agentId, chat }, ['changed', 'error', 'cancelled', 'unknown'].includes(chat.status));
  };
  const delegateTool = async args => {
    const deadline = now() + 80000;
    const request = validateTeamArgs(args, true);
    const { state: initial, workspace } = await readTeam();
    const rejected = error => publicResult({ ...teamSnapshot(initial, workspace), agentId: request.agentId, status: 'rejected', error }, true);
    const worker = initial.agents.find(agent => agent.id === request.agentId);
    if (!worker) return rejected('这个智能体不在当前团队中。');
    if (worker.id === initial.leaderId) return rejected('只能委托非负责人的现有工作智能体；原生 Codex 监工直接核查结果。');
    const conversationId = initial.chatSessions?.[worker.id]?.id;
    if (typeof initial.leaderId !== 'string' || !initial.agents.some(agent => agent.id === initial.leaderId) || typeof conversationId !== 'string' || !conversationId) return rejected('无法核实当前负责人或工作者会话，未发送任务。');
    if (!['live', 'demo'].includes(initial.mode)) return rejected('无法核实真实/演示运行模式，未发送任务。');
    if (initial.phase === 'running') return rejected('自动合作正在运行；请先暂停，不能与独立委托混用。');
    if (['running', 'reviewing'].includes(worker.status) || initial.chatSessions?.[worker.id]?.status === 'running') return rejected('这个工作者正在处理任务，请等待或停止后再委托。');
    if (now() >= deadline) return rejected('本次工具等待时间已到，未发送任务。请先确认服务状态。');
    const response = await proxy({ route: '/api/actions', method: 'POST', body: {
      action: 'message', agentId: worker.id, text: request.prompt,
      expectedLeaderId: initial.leaderId, expectedConversationId: conversationId,
    } }, { ensure: false, timeoutMs: Math.max(1, Math.min(45000, deadline - now())) });
    if (!response.ok) {
      if ([400, 404, 409].includes(response.status)) return rejected(response.error || '后端拒绝了这次独立委托。');
      return publicResult({ ...teamSnapshot(initial, workspace), agentId: worker.id, sessionId: initial.chatSessions?.[worker.id]?.id,
        status: 'unknown', error: '提交结果未确认；任务可能已送出。请先使用 agent_team_status 核实，不要直接重复派单。', reviewStatus: 'unreviewed' }, true);
    }
    const submitted = response.data;
    if (!Array.isArray(submitted?.agents)) return rejected('后端没有返回有效的委托状态，未确认任务结果。');
    const sessionId = submitted.chatSessions?.[worker.id]?.id;
    const oldIds = new Set((initial.messages || []).map(message => message.id));
    const conversation = Array.isArray(submitted.messages) ? submitted.messages.filter(message => message.agentId === worker.id && message.conversationId === sessionId && message.kind === 'message') : [];
    const userIndex = conversation.findLastIndex(message => message.role === 'user' && message.text === request.prompt && !oldIds.has(message.id));
    const reply = userIndex < 0 ? undefined : conversation.slice(userIndex + 1).find(message => message.role === 'assistant' && !oldIds.has(message.id));
    if (!sessionId || !reply?.id) return publicResult({ ...teamSnapshot(submitted, workspace), agentId: worker.id, sessionId,
      status: 'unknown', error: '后端没有返回可匹配本次任务的新回复；任务可能已送出，未把旧输出当作交付。请先核实状态。', reviewStatus: 'unreviewed' }, true);
    const reference = { agentId: worker.id, sessionId, messageId: reply.id };
    if (submitted.mode !== initial.mode || submitted.leaderId === worker.id || (initial.chatSessions?.[worker.id]?.id && sessionId !== initial.chatSessions[worker.id].id)) {
      return publicResult({ ...teamSnapshot(submitted, workspace), ...reference, status: 'changed', error: '提交时模式、负责人或会话发生变化；任务可能已送出，但未把其他上下文的输出当作原委托。请先核实状态。', reviewStatus: 'unreviewed' }, true);
    }
    const { state, chat } = await waitForReply(submitted, { ...reference, mode: initial.mode }, request.waitSeconds, deadline);
    return publicResult({ ...teamSnapshot(state, workspace), ...reference, ...chat, criteria: request.criteria, reviewStatus: 'unreviewed',
      delegationAccounting: 'manual_chat',
      accountingNotice: '真实工作者调用计入提供方总调用量；本次独立委托不消耗或调整自动调度预算，不额外调用规划或审核模型。',
    }, ['changed', 'error', 'cancelled', 'unknown'].includes(chat.status));
  };
  return {
    async handle(method, params = {}) {
      if (method === 'initialize') return {
        protocolVersion: versions.has(params.protocolVersion) ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {listChanged:true}, resources: { subscribe: false, listChanged: true }, extensions: { 'io.modelcontextprotocol/ui': {} } },
        serverInfo: { name: 'relay-native', title: '异智能体合作', version: '0.5.2', icons: [icon] },
      };
      if (method === 'ping') return {};
      if (method === 'tools/list') return { tools };
      if (method === 'resources/list') return { resources: [resource,{...resource,uri:PANEL_URI,name:'relay-panel',title:'异智能体'}] };
      if (method === 'resources/templates/list') return { resourceTemplates: [] };
      if (method === 'resources/read') {
        if (![RESOURCE_URI,PANEL_URI,'ui://relay/v0.5.1/workspace','ui://relay/v0.5.1/panel','ui://relay/v0.5.0/workspace','ui://relay/v0.5.0/panel','ui://relay/v0.4.0/workspace','ui://relay/v0.4.0/panel','ui://relay/v0.3.0/workspace','ui://relay/v0.3.0/panel','ui://relay/v0.2.4/workspace','ui://relay/v0.2.4/panel','ui://relay/v0.2.3/workspace','ui://relay/v0.2.3/panel','ui://relay/v0.2.2/workspace','ui://relay/v0.2.2/panel','ui://relay/workspace','ui://relay/panel'].includes(params.uri)) throw rpcError('UI 资源不存在。');
        let html=await inlineBundle(distRoot);
        if(params.uri===PANEL_URI || params.uri.endsWith('/panel')) html=html.replace('window.__RELAY_NATIVE__=true;',"window.__RELAY_NATIVE__=true;window.__RELAY_VIEW__='deepseek';");
        return { contents: [{
          ...resource, uri:params.uri,text:html,
          _meta: {
            ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } },
            'openai/ui': { availableDisplayModes: ['inline', 'fullscreen', 'pip'] },
            'openai/widgetDescription': '异智能体合作：直接在应用内管理两个对话，界面刷新通过 MCP，不调用推理模型。',
          },
        }] };
      }
      if (method === 'tools/call') {
        if (params.name === 'agent_team_status') return statusTool(params.arguments);
        if (params.name === 'delegate_agent_task') return delegateTool(params.arguments);
        if(params.name==='open_relay_panel') return {content:[{type:'text',text:'异智能体侧面板已打开。'}],structuredContent:{view:'deepseek',transport:'mcp'}};
        if (params.name === 'open_relay_workspace') {
          const args = params.arguments ?? {};
          if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'view') || (args.view !== undefined && !['split', 'deepseek'].includes(args.view))) throw rpcError('视图参数无效。');
          return { content: [{ type: 'text', text: '异智能体合作界面已就绪。入口的实际显示方式由桌面宿主决定。' }], structuredContent: { view: args.view ?? 'split', transport: 'mcp' } };
        }
        if (params.name !== 'relay_request') throw rpcError('工具不存在。', -32601);
        const result = await proxy(params.arguments);
        return { content: [], structuredContent: result, ...(result.ok ? {} : { isError: true }) };
      }
      if (method.startsWith('notifications/')) return undefined;
      throw rpcError('MCP 方法不存在。', -32601);
    },
  };
}

export async function runStdio(input = process.stdin, output = process.stdout) {
  const protocol = createProtocol();
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  function reply(value) { output.write(JSON.stringify(value) + '\n'); }
  async function receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无效 JSON。' } }); return; }
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      reply({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: '无效 JSON-RPC 请求。' } }); return;
    }
    const hasId = Object.hasOwn(message, 'id');
    try {
      const result = await protocol.handle(message.method, message.params);
      if (hasId) reply({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
    } catch (error) {
      if (hasId) reply({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message ?? 'MCP 请求失败。' } });
    }
  }
  for await (const line of lines) {
    if (!line.trim()) continue;
    const task = receive(line).finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStdio().catch(() => { process.stderr.write('异智能体 MCP 服务启动失败。\n'); process.exitCode = 1; });
}
