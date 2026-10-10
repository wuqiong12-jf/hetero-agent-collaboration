import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pluginRoot = dirname(fileURLToPath(import.meta.url));
const icon = {src:'data:image/png;base64,'+readFileSync(join(pluginRoot,'assets','icon.png')).toString('base64'),mimeType:'image/png',sizes:['256x256']};
export const RESOURCE_URI = 'ui://relay/v0.6.0/workspace';
export const PANEL_URI = 'ui://relay/v0.6.0/panel';
export const RESOURCE_MIME = 'text/html;profile=mcp-app';
const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const emptyInput = { type: 'object', properties: {}, additionalProperties: false };
const entryMetadata = {
  ui: { resourceUri: RESOURCE_URI },
  'openai/ui': { entrypoints: [{ type: 'global' }] },
  'openai/outputTemplate': RESOURCE_URI,
};
const waitSchema = { type: 'integer', minimum: 0, maximum: 45 };
const briefLimits = { objective: 3000, deliverables: 3000, acceptance: 3000, constraints: 2000, questions: 1000 };
const briefFields = Object.keys(briefLimits);
const briefProperties = Object.fromEntries(Object.entries(briefLimits).map(([key, maxLength]) => [key, { type: 'string', maxLength }]));

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
    name: 'get_task_brief',
    title: '读取公共任务委托书草稿',
    description: '用户要求梳理目标或写任务委托书时，供原生 Codex 主聊天读取当前 stateId、已保存的五字段草稿及 revision、必填及待决定问题、工作目录、模式、负责人摘要和粗略执行阻碍。后续保存须使用本次读取的 stateId 和 revision。只读取公开摘要，不返回聊天、执行目标、工作者产物或秘密配置；不调用推理模型、不派单。执行确认必须由用户在应用界面核对保存版本后完成，模型代码不得自行确认、启动或切换模式。',
    inputSchema: emptyInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'save_task_brief',
    title: '保存公共任务委托书草稿',
    description: '用户要求梳理目标或写任务委托书时，供原生 Codex 主聊天保存五个文本字段；必须先用 get_task_brief 读取 stateId 和草稿 revision，分别传入 expectedStateId 和 expectedRevision。五字段全部必填，允许暂时留空；各字段有长度限制，合计不超过12000字符。仅保存草稿，不调用推理模型、不派单、不确认执行、不启动、不切换模式、不重置。执行确认由用户在应用界面核对保存版本后完成，模型代码不得自行确认。发生冲突时核对返回的当前会话与保存版，再与本地草稿比对，禁止自动覆盖；结果不确定时可能已经保存，先用 get_task_brief 核对，禁止自动重发。',
    inputSchema: { type: 'object', properties: { ...briefProperties, expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, expectedStateId: { type: 'string', minLength: 1, maxLength: 256 } },
      required: [...briefFields, 'expectedRevision', 'expectedStateId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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

function validateBriefArgs(args, saving = false) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw rpcError('任务委托书参数必须是对象。');
  const allowed = saving ? [...briefFields, 'expectedRevision', 'expectedStateId'] : [];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw rpcError('任务委托书包含不支持的参数。');
  if (!saving) return {};
  if (!Object.hasOwn(args, 'expectedRevision') || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) throw rpcError('expectedRevision 必须是大于等于0的安全整数。');
  if (!Object.hasOwn(args, 'expectedStateId') || typeof args.expectedStateId !== 'string' || !args.expectedStateId.trim() || args.expectedStateId.length > 256 || args.expectedStateId.includes('\0')) throw rpcError('expectedStateId 必须是非空且不超过256字符的会话标识。');
  const brief = {};
  for (const [key, limit] of Object.entries(briefLimits)) {
    if (!Object.hasOwn(args, key) || typeof args[key] !== 'string' || args[key].length > limit || args[key].includes('\0')) throw rpcError(`${key} 必须为不超过${limit}字符的文本。`);
    brief[key] = args[key];
  }
  if (Object.values(brief).reduce((total, value) => total + value.length, 0) > 12000) throw rpcError('任务委托书五字段合计不能超过12000字符。');
  return { brief, expectedRevision: args.expectedRevision, expectedStateId: args.expectedStateId };
}

function publicBrief(value) {
  if (value === undefined) return { ...Object.fromEntries(briefFields.map(key => [key, ''])), revision: 0, updatedAt: null, confirmedAt: null };
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('无效任务委托书版本');
  const fields = {};
  for (const [key, limit] of Object.entries(briefLimits)) {
    if (!Object.hasOwn(value, key) || typeof value[key] !== 'string' || value[key].length > limit || value[key].includes('\0')) throw new Error('无效任务委托书字段');
    fields[key] = value[key];
  }
  const timestamp = date => typeof date === 'string' && date.length <= 100 && Number.isFinite(Date.parse(date));
  if (!timestamp(value.updatedAt) || (value.confirmedAt !== undefined && value.confirmedAt !== null && !timestamp(value.confirmedAt))) throw new Error('无效任务委托书时间');
  return { ...fields, revision: value.revision, updatedAt: value.updatedAt, confirmedAt: value.confirmedAt ?? null };
}

function briefProblems(draft) {
  const labels = { objective: '目标', deliverables: '交付物', acceptance: '验收标准' };
  const problems = Object.entries(labels).filter(([key]) => !draft[key].trim()).map(([field, label]) => ({ code: 'required', field, message: `确认前需填写${label}。` }));
  if (draft.questions.trim()) problems.push({ code: 'unresolved', field: 'questions', message: '还有待决定问题，解决后需保存新版本。' });
  return problems;
}

function briefSnapshot(state, workspace, draft = publicBrief(state.goalDraft)) {
  if (typeof state.id !== 'string' || !state.id.trim() || state.id.length > 256 || state.id.includes('\0')) throw new Error('无效协作会话标识');
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const leader = agents.find(agent => agent.id === state.leaderId);
  const blockers = new Map();
  const block = (code, message) => blockers.set(code, { code, message });
  if (state.collaborationMode !== 'cooperative') block('cooperation-disabled', '合作模式尚未开启；草稿可以保存，执行确认需在界面处理。');
  if (!leader) block('leader-unavailable', '当前负责人尚无法核实。');
  if (state.phase === 'running') block('cooperation-running', '当前合作任务正在执行。');
  if (agents.some(agent => ['running', 'reviewing'].includes(agent.status)) || Object.values(state.chatSessions || {}).some(session => session?.status === 'running') ||
    ['readers', 'writers', 'retiringReaders', 'retiringWriters'].some(key => Number.isSafeInteger(state.executionSummary?.[key]) && state.executionSummary[key] > 0)) block('execution-busy', '仍有执行或停止中的工作，请等待完成并核实停止状态。');
  const issueCodes = new Set(Array.isArray(state.recovery?.summary?.globalIssues) ? state.recovery.summary.globalIssues.map(issue => issue?.code) : []);
  if ((Array.isArray(state.pendingCleanup) && state.pendingCleanup.length) || issueCodes.has('cleanup-unconfirmed')) block('cleanup-unconfirmed', '旧执行尚未确认退出，执行确认前需处理工作空间锁。');
  if (issueCodes.has('persistence-failed')) block('persistence-failed', '当前状态尚未保存到磁盘，执行确认前需恢复保存。');
  if (issueCodes.has('service-closed')) block('service-closed', '协作服务已经关闭。');
  if (issueCodes.has('stopping')) block('stopping', '执行仍在停止，尚未确认退出。');
  if (state.phase === 'blocked') block('blocked', '当前协作状态有阻碍，需在界面核对恢复条件。');
  if (draft.confirmedAt) block('already-confirmed', '这个保存版本已由界面确认；新任务需先保存新版本。');
  return {
    stateId: state.id, draft, problems: briefProblems(draft), workspace: text(workspace, 2000),
    mode: ['live', 'demo'].includes(state.mode) ? state.mode : null,
    collaborationMode: ['independent', 'cooperative'].includes(state.collaborationMode) ? state.collaborationMode : null,
    leader: leader ? { id: text(leader.id, 256), name: text(leader.name), provider: ['codex', 'deepseek'].includes(leader.provider) ? leader.provider : null,
      model: text(leader.modelId || leader.model, 256), reasoningEffort: text(leader.reasoningEffort || 'auto', 40) } : null,
    executionBlockers: [...blockers.values()],
  };
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

class LocalServiceError extends Error {}

function validateServiceContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || context.service !== 'relay-agent-workbench') {
    if (context && typeof context.workspace === 'string' && typeof context.version === 'string' && context.service === undefined) {
      throw new LocalServiceError('本机服务缺少 Relay 服务标识，可能是旧版后台。请确认端口占用；旧版 Relay 需要停止并重启为当前版本。');
    }
    throw new LocalServiceError('本机端口上的服务不是 Relay 协作服务。请检查端口占用后重试。');
  }
  if (context.protocolVersion !== 1) throw new LocalServiceError('Relay 后台协议不兼容。请停止旧后台并启动当前项目服务后重试。');
  if (typeof context.workspace !== 'string' || !context.workspace.trim() || typeof context.version !== 'string' || !context.version.trim()) {
    throw new LocalServiceError('Relay 后台上下文无效，无法确认工作目录和版本。请重启当前项目服务后重试。');
  }
}

async function startLocalService({ base }) {
  const root = process.env.RELAY_PROJECT_ROOT;
  if (!root) throw new LocalServiceError('本地协作服务尚未启动，且未配置项目启动目录。请启动当前项目服务后重试。');
  try { await readFile(join(root, 'server', 'index.mjs')); }
  catch { throw new LocalServiceError('无法读取本地项目服务入口。请检查项目安装后重试。'); }
  try {
    const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
      cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, HOST: base.hostname.replace(/^\[|\]$/g, ''), PORT: base.port || '80' },
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  } catch { throw new LocalServiceError('无法启动本地协作服务。请检查项目安装和启动权限后重试。'); }
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
  startService = startLocalService, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, pollIntervalMs = 500 } = {}) {
  const base = loopbackBase(apiBase);
  let starting;
  const ready = async () => {
    let response;
    try { response = await fetcher(new URL('/api/context', base), { signal: AbortSignal.timeout(1500), redirect: 'error' }); }
    catch { return false; }
    if (!response.ok) throw new LocalServiceError('本机端口已有服务响应，但无法确认是 Relay 协作服务。请检查端口占用后重试。');
    let context;
    try { context = await response.json(); }
    catch { throw new LocalServiceError('本机端口已有服务响应，但服务上下文无法读取。请检查端口占用；旧版 Relay 后台需要重启。'); }
    validateServiceContext(context);
    return true;
  };
  const ensureService = () => {
    if (!starting) starting = (async () => {
      if (await ready()) return;
      try { await startService({ base }); }
      catch (error) {
        if (error instanceof LocalServiceError) throw error;
        throw new LocalServiceError('无法启动本地协作服务。请检查项目安装和启动权限后重试。');
      }
      for (let attempt = 0; attempt < 15; attempt++) { await sleep(500); if (await ready()) return; }
      throw new LocalServiceError('本地协作服务启动后未能就绪。请检查端口和项目服务后重试。');
    })().finally(() => { starting = undefined; });
    return starting;
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
    } catch (error) {
      return { ok: false, status: 503, data: null, error: error instanceof LocalServiceError ? error.message : '无法连接本地协作服务。请启动项目服务后重试。' };
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
    if (!context.ok) throw rpcError('无法核实工作目录。', -32001);
    validateServiceContext(context.data);
    return { state, workspace: context.data.workspace };
  };
  const getBriefTool = async args => {
    validateBriefArgs(args === undefined ? {} : args);
    try {
      const { state, workspace } = await readTeam();
      return publicResult({ status: 'read', ...briefSnapshot(state, workspace), notice: '此结果仅为保存草稿及当前条件摘要；执行确认须由用户在应用界面核对保存版本后完成。' });
    } catch (error) {
      return publicResult({ status: 'unknown', error: error instanceof LocalServiceError ? error.message : '无法读取有效的公共任务委托书。请检查本地服务后使用 get_task_brief 重新核对。' }, true);
    }
  };
  const saveBriefTool = async args => {
    const request = validateBriefArgs(args, true);
    let initial;
    try { initial = await readTeam(); briefSnapshot(initial.state, initial.workspace); }
    catch (error) {
      return publicResult({ status: 'rejected', error: error instanceof LocalServiceError ? error.message : '无法核实当前本地协作服务，未提交任务委托书。请先使用 get_task_brief 核对。' }, true);
    }
    const unknown = () => publicResult({ status: 'unknown', expectedRevision: request.expectedRevision, expectedStateId: request.expectedStateId,
      error: '保存结果未确认，草稿可能已经保存。请保留本地草稿，先用 get_task_brief 核对保存字段与版本；不要自动重发保存请求。' }, true);
    const response = await proxy({ route: '/api/actions', method: 'POST', body: {
      action: 'saveGoalBrief', brief: request.brief, expectedRevision: request.expectedRevision, expectedStateId: request.expectedStateId,
    } }, { ensure: false, timeoutMs: 45000 });
    if (response.status === 409) {
      try {
        const { state, workspace } = await readTeam();
        const snapshot = briefSnapshot(state, workspace);
        const differentFields = briefFields.filter(key => snapshot.draft[key] !== request.brief[key]);
        return publicResult({ status: 'conflict', ...snapshot, expectedRevision: request.expectedRevision, expectedStateId: request.expectedStateId,
          comparison: { differentFields, sameContent: differentFields.length === 0, stateChanged: snapshot.stateId !== request.expectedStateId },
          error: '保存版本已变化，本次保存被拒绝。请将返回的最新保存版与本地草稿逐项比对，再由用户决定保留哪些修改；不要自动覆盖。' }, true);
      } catch {
        return publicResult({ status: 'conflict', draft: null, comparison: null, expectedRevision: request.expectedRevision, expectedStateId: request.expectedStateId,
          error: '保存版本发生冲突，本次保存被拒绝，但最新保存版暂时无法读取。请保留本地草稿，用 get_task_brief 重新读取并比对；不要自动覆盖。' }, true);
      }
    }
    if (!response.ok) {
      if ([400, 403, 404, 422].includes(response.status)) return publicResult({ status: 'rejected',
        error: '本地服务拒绝了本次草稿保存。请保留本地草稿，使用 get_task_brief 核对服务及保存版本后再处理。' }, true);
      return unknown();
    }
    try {
      const draft = publicBrief(response.data?.goalDraft);
      if (response.data?.id !== request.expectedStateId || draft.revision !== request.expectedRevision + 1 || draft.confirmedAt !== null || briefFields.some(key => draft[key] !== request.brief[key])) return unknown();
      // Report exactly the version returned by this POST. A later GET could be
      // another client's save and must never be presented as this submission.
      const snapshot = briefSnapshot(response.data, initial.workspace, draft);
      return publicResult({ status: 'saved', ...snapshot,
        notice: `任务委托书草稿 v${draft.revision} 已保存。执行确认须由用户在应用界面核对保存版本后完成。` });
    } catch { return unknown(); }
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
        serverInfo: { name: 'relay-native', title: '异智能体合作', version: '0.6.0', icons: [icon] },
      };
      if (method === 'ping') return {};
      if (method === 'tools/list') return { tools };
      if (method === 'resources/list') return { resources: [resource,{...resource,uri:PANEL_URI,name:'relay-panel',title:'异智能体'}] };
      if (method === 'resources/templates/list') return { resourceTemplates: [] };
      if (method === 'resources/read') {
        if (![RESOURCE_URI,PANEL_URI,'ui://relay/v0.5.3/workspace','ui://relay/v0.5.3/panel','ui://relay/v0.5.2/workspace','ui://relay/v0.5.2/panel','ui://relay/v0.5.1/workspace','ui://relay/v0.5.1/panel','ui://relay/v0.5.0/workspace','ui://relay/v0.5.0/panel','ui://relay/v0.4.0/workspace','ui://relay/v0.4.0/panel','ui://relay/v0.3.0/workspace','ui://relay/v0.3.0/panel','ui://relay/v0.2.4/workspace','ui://relay/v0.2.4/panel','ui://relay/v0.2.3/workspace','ui://relay/v0.2.3/panel','ui://relay/v0.2.2/workspace','ui://relay/v0.2.2/panel','ui://relay/workspace','ui://relay/panel'].includes(params.uri)) throw rpcError('UI 资源不存在。');
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
        if (params.name === 'get_task_brief') return getBriefTool(params.arguments);
        if (params.name === 'save_task_brief') return saveBriefTool(params.arguments);
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
