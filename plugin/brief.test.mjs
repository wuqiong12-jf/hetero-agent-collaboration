import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { once } from 'node:events';
import { createProtocol, tools } from './relay-native/server.mjs';
import { createAppServer } from '../server/index.mjs';
import { Orchestrator, createInitialState } from '../server/engine.mjs';

const fields = ['objective', 'deliverables', 'acceptance', 'constraints', 'questions'];
const stamp = '2026-10-11T01:00:00.000Z';
const brief = { objective: '梳理目标', deliverables: '一份任务委托书', acceptance: '五字段和证据可核查', constraints: '在当前工作目录完成', questions: '' };
const serviceContext = extra => ({ service: 'relay-agent-workbench', protocolVersion: 1, workspace: 'C:\\fixtures\\brief', version: '0.5.3', ...extra });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const call = (api, name, args) => api.handle('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });

function stateFixture() {
  return {
    id: 'fixture-session', mode: 'live', collaborationMode: 'independent', phase: 'idle', leaderId: 'fixture-leader',
    agents: [{ id: 'fixture-leader', name: '负责人', provider: 'codex', modelId: 'fixture-model', reasoningEffort: 'high', status: 'idle', private: 'PRIVATE_AGENT' },
      { id: 'fixture-worker', name: '工作者', provider: 'deepseek', modelId: 'fixture-worker-model', status: 'idle' }],
    goalDraft: { ...brief, revision: 2, updatedAt: stamp, private: 'PRIVATE_DRAFT' },
    activeBrief: { objective: 'PRIVATE_ACTIVE_BRIEF' }, goal: 'PRIVATE_EXECUTING_GOAL',
    messages: [{ text: 'PRIVATE_MESSAGE' }], tasks: [{ output: 'PRIVATE_TASK_OUTPUT' }],
    chatSessions: { 'fixture-worker': { id: 'PRIVATE_PROVIDER_SESSION', status: 'idle', providerSession: { id: 'PRIVATE_SESSION' } } },
    settings: { secret: 'PRIVATE_SETTINGS_SECRET' }, error: 'PRIVATE_ENGINE_ERROR',
    pendingCleanup: [], executionSummary: { readers: 0, writers: 0, retiringReaders: 0, retiringWriters: 0, private: 'PRIVATE_EXECUTION' },
    recovery: { summary: { globalIssues: [{ code: 'unknown-private-code', detail: 'PRIVATE_RECOVERY' }], lastError: 'PRIVATE_LAST_ERROR' } },
  };
}

function fixture({ initial = stateFixture(), onPost, onRead, context = serviceContext() } = {}) {
  let state = structuredClone(initial), reads = 0;
  const calls = [];
  const api = createProtocol({ sleep: async () => {}, startService: async () => { throw new Error('PRIVATE_START_ERROR'); }, fetcher: async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path: url.pathname, method, body });
    assert.equal(url.hostname, '127.0.0.1');
    if (url.pathname === '/api/context') return response(typeof context === 'function' ? context({ calls }) : context);
    if (url.pathname === '/api/state') {
      reads++;
      return await onRead?.({ state, reads, calls }) || response(state);
    }
    assert.equal(url.pathname, '/api/actions');
    assert.equal(method, 'POST');
    assert.equal(body.action, 'saveGoalBrief');
    assert.deepEqual(Object.keys(body).sort(), ['action', 'brief', 'expectedRevision', 'expectedStateId']);
    const custom = await onPost?.({ state, body, calls });
    if (custom) return custom;
    state.goalDraft = { ...body.brief, revision: body.expectedRevision + 1, updatedAt: stamp, private: 'PRIVATE_SAVED_DRAFT' };
    return response(state);
  } });
  return { api, calls, get reads() { return reads; } };
}

function saveArgs(extra = {}) { return { ...brief, expectedRevision: 2, expectedStateId: 'fixture-session', ...extra }; }

test('public brief tools describe read, save and human UI execution boundaries', () => {
  const get = tools.find(tool => tool.name === 'get_task_brief');
  const save = tools.find(tool => tool.name === 'save_task_brief');
  assert.deepEqual(get.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(get.annotations.readOnlyHint, true);
  assert.equal(save.annotations.readOnlyHint, false);
  assert.equal(save.annotations.idempotentHint, false);
  assert.equal(save.inputSchema.additionalProperties, false);
  assert.deepEqual(save.inputSchema.required, [...fields, 'expectedRevision', 'expectedStateId']);
  assert.deepEqual(fields.map(key => save.inputSchema.properties[key].maxLength), [3000, 3000, 3000, 2000, 1000]);
  for (const tool of [get, save]) {
    assert.match(tool.description, /原生 Codex 主聊天/);
    assert.match(tool.description, /不调用推理模型/);
    assert.match(tool.description, /模型代码不得自行确认/);
    assert.equal(tool._meta, undefined, 'public bridge must be visible to native model code');
  }
  assert.match(save.description, /expectedStateId/);
  assert.match(save.description, /禁止自动重发/);
});

test('invalid brief arguments fail before any service request', async () => {
  const { api, calls } = fixture();
  for (const args of [null, [], 'text', { revision: 2 }, { confirm: true }, { route: '/api/state' }]) {
    await assert.rejects(call(api, 'get_task_brief', args), error => error.code === -32602);
  }
  const bad = [undefined, null, [], { ...saveArgs(), action: 'confirmGoalBrief' }, { ...saveArgs(), expectedMode: 'live' },
    { ...saveArgs(), brief }, ...fields.map(key => ({ ...saveArgs(), [key]: 3 })), ...fields.map(key => ({ ...saveArgs(), [key]: null })),
    ...fields.map(key => { const args = saveArgs(); delete args[key]; return args; }),
    ...Object.entries({ objective: 3001, deliverables: 3001, acceptance: 3001, constraints: 2001, questions: 1001 }).map(([key, length]) => saveArgs({ [key]: 'x'.repeat(length) })),
    saveArgs({ constraints: 'bad\0text' }), ...[-1, 0.5, '2', null, Number.MAX_SAFE_INTEGER + 1].map(expectedRevision => saveArgs({ expectedRevision })),
    ...[null, '', ' ', 3, 'x'.repeat(257), 'bad\0id'].map(expectedStateId => saveArgs({ expectedStateId }))];
  const missingRevision = saveArgs(); delete missingRevision.expectedRevision; bad.push(missingRevision);
  const missingState = saveArgs(); delete missingState.expectedStateId; bad.push(missingState);
  for (const args of bad) await assert.rejects(call(api, 'save_task_brief', args), error => error.code === -32602);
  assert.deepEqual(calls, []);
});

test('get reads only the public draft, context and fixed blocker summaries', async () => {
  const state = stateFixture();
  state.goalDraft.questions = '请用户决定格式';
  state.goalDraft.acceptance = ' ';
  state.goalDraft.confirmedAt = stamp;
  state.phase = 'running'; state.agents[1].status = 'running';
  state.pendingCleanup = [{ reason: 'PRIVATE_CLEANUP' }];
  state.recovery.summary.globalIssues.push({ code: 'persistence-failed', detail: 'PRIVATE_DISK_ERROR' });
  const { api, calls } = fixture({ initial: state, context: serviceContext({ private: 'PRIVATE_CONTEXT' }) });
  const result = await call(api, 'get_task_brief');
  const data = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), data);
  assert.equal(data.status, 'read');
  assert.equal(data.stateId, state.id);
  assert.equal(data.workspace, 'C:\\fixtures\\brief');
  assert.equal(data.mode, 'live'); assert.equal(data.collaborationMode, 'independent');
  assert.deepEqual(Object.keys(data.draft), [...fields, 'revision', 'updatedAt', 'confirmedAt']);
  assert.equal(data.draft.revision, 2); assert.equal(data.draft.confirmedAt, stamp);
  assert.deepEqual(data.problems.map(problem => [problem.code, problem.field]), [['required', 'acceptance'], ['unresolved', 'questions']]);
  assert.deepEqual(data.leader, { id: 'fixture-leader', name: '负责人', provider: 'codex', model: 'fixture-model', reasoningEffort: 'high' });
  for (const code of ['cooperation-disabled', 'cooperation-running', 'execution-busy', 'cleanup-unconfirmed', 'persistence-failed', 'already-confirmed']) {
    assert.ok(data.executionBlockers.some(blocker => blocker.code === code));
  }
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.ok(calls.every(request => request.method === 'GET'));
  assert.deepEqual(calls.map(request => request.path).sort(), ['/api/context', '/api/context', '/api/state'].sort());
});

test('missing drafts begin at zero, but invalid session IDs or draft metadata are never normalised to a valid draft', async () => {
  const initial = stateFixture(); delete initial.goalDraft;
  const good = await call(fixture({ initial }).api, 'get_task_brief', {});
  assert.deepEqual(good.structuredContent.draft, { ...Object.fromEntries(fields.map(key => [key, ''])), revision: 0, updatedAt: null, confirmedAt: null });
  assert.deepEqual(good.structuredContent.problems.map(problem => problem.field), ['objective', 'deliverables', 'acceptance']);
  for (const patch of [{ id: undefined }, { id: '' }, { id: 'x'.repeat(257) }, { goalDraft: null },
    { goalDraft: { ...brief, revision: 2, updatedAt: 'PRIVATE_BAD_TIMESTAMP' } },
    { goalDraft: { ...brief, revision: 0, updatedAt: stamp } },
    { goalDraft: { ...brief, revision: 2, updatedAt: stamp, confirmedAt: 3 } }]) {
    const result = await call(fixture({ initial: { ...stateFixture(), ...patch } }).api, 'get_task_brief', {});
    assert.equal(result.structuredContent.status, 'unknown'); assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  }
});

test('save submits exactly one save action and returns only the matching POST version', async () => {
  const { api, calls } = fixture({ onRead: ({ state, reads }) => {
    if (reads > 1) state.goalDraft = { ...brief, objective: '其他客户端的新草稿', revision: 99, updatedAt: stamp };
  } });
  const result = await call(api, 'save_task_brief', saveArgs());
  const data = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), data);
  assert.equal(data.status, 'saved'); assert.equal(result.isError, undefined);
  assert.deepEqual(data.draft, { ...brief, revision: 3, updatedAt: stamp, confirmedAt: null });
  assert.equal(data.stateId, 'fixture-session'); assert.equal(data.workspace, 'C:\\fixtures\\brief');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  const posts = calls.filter(request => request.method === 'POST');
  assert.deepEqual(posts.map(request => request.body), [{ action: 'saveGoalBrief', brief, expectedRevision: 2, expectedStateId: 'fixture-session' }]);
  assert.equal(calls.filter(request => request.path === '/api/state').length, 1, 'success must not replace the POST acknowledgment with a later GET');
  assert.match(data.notice, /界面/);
});

test('save permits empty drafts and exact length limits without trimming the content', async () => {
  for (const values of [Object.fromEntries(fields.map(key => [key, ''])),
    { objective: 'x'.repeat(3000), deliverables: 'x'.repeat(3000), acceptance: 'x'.repeat(3000), constraints: 'x'.repeat(2000), questions: 'x'.repeat(1000) },
    { ...brief, objective: '  保留原文\n' }]) {
    const { api } = fixture();
    const result = await call(api, 'save_task_brief', saveArgs(values));
    assert.equal(result.structuredContent.status, 'saved');
    for (const field of fields) assert.equal(result.structuredContent.draft[field], values[field]);
  }
});

test('unrelated, legacy and incompatible services do not receive draft actions', async () => {
  for (const context of [{ status: 'PRIVATE_SERVICE' }, serviceContext({ service: 'unrelated' }),
    serviceContext({ protocolVersion: 2 }), { workspace: 'C:\\fixtures', version: '0.5.2' }]) {
    for (const name of ['get_task_brief', 'save_task_brief']) {
      const { api, calls } = fixture({ context });
      const result = await call(api, name, name === 'save_task_brief' ? saveArgs() : {});
      assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
      assert.deepEqual(calls.map(request => request.path), ['/api/context']);
    }
  }
});

test('a replaced context after the successful initial probe prevents a public draft save', async () => {
  for (const replacement of [serviceContext({ service: 'PRIVATE_WRONG_SERVICE' }), serviceContext({ protocolVersion: 2 }),
    serviceContext({ workspace: '' }), { workspace: 'C:\\fixtures\\legacy', version: '0.5.2', private: 'PRIVATE_LEGACY_CONTEXT' }]) {
    for (const name of ['get_task_brief', 'save_task_brief']) {
      const { api, calls } = fixture({ context: ({ calls }) => calls.filter(request => request.path === '/api/context').length === 1 ? serviceContext() : replacement });
      const result = await call(api, name, name === 'save_task_brief' ? saveArgs() : {});
      assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
      assert.equal(calls.filter(request => request.path === '/api/context').length, 2);
      assert.equal(calls.filter(request => request.method === 'POST').length, 0);
    }
  }
});

test('save conflicts read the latest draft and compare it with the local submission without overwriting', async () => {
  const { api, calls } = fixture({ onPost: ({ state }) => {
    state.id = 'changed-session';
    state.goalDraft = { ...brief, objective: '其他用户的新目标', constraints: '新限制', revision: 4, updatedAt: stamp };
    return response({ error: 'PRIVATE_CONFLICT' }, 409);
  } });
  const result = await call(api, 'save_task_brief', saveArgs());
  assert.equal(result.structuredContent.status, 'conflict'); assert.equal(result.isError, true);
  assert.equal(result.structuredContent.draft.revision, 4); assert.equal(result.structuredContent.stateId, 'changed-session');
  assert.deepEqual(result.structuredContent.comparison, { differentFields: ['objective', 'constraints'], sameContent: false, stateChanged: true });
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(calls.filter(request => request.method === 'POST').length, 1);
  assert.equal(calls.filter(request => request.path === '/api/state').length, 2);
});

test('unreadable conflicts preserve the conflict result without exposing upstream errors', async () => {
  const { api, calls } = fixture({ onPost: () => response({ error: 'PRIVATE_CONFLICT' }, 409),
    onRead: ({ reads }) => reads > 1 ? response({ error: 'PRIVATE_READ_ERROR' }, 500) : undefined });
  const result = await call(api, 'save_task_brief', saveArgs());
  assert.equal(result.structuredContent.status, 'conflict'); assert.equal(result.structuredContent.draft, null);
  assert.equal(result.structuredContent.comparison, null); assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(calls.filter(request => request.method === 'POST').length, 1);
});

test('failed, malformed or mismatching save acknowledgments are unknown and never retried', async () => {
  const scenarios = [
    () => response({ error: 'PRIVATE_UPSTREAM_ERROR' }, 503),
    () => response({ error: 'PRIVATE_UPSTREAM_ERROR' }, 500),
    () => { throw new Error('PRIVATE_NETWORK_ERROR'); },
    () => ({ ok: true, status: 200, json: async () => { throw new Error('PRIVATE_JSON_ERROR'); } }),
    ({ state, body }) => response({ ...state, id: 'changed-session', goalDraft: { ...body.brief, revision: 3, updatedAt: stamp } }),
    ({ state, body }) => response({ ...state, goalDraft: { ...body.brief, revision: 4, updatedAt: stamp } }),
    ({ state, body }) => response({ ...state, goalDraft: { ...body.brief, objective: '不匹配', revision: 3, updatedAt: stamp } }),
    ({ state, body }) => response({ ...state, goalDraft: { ...body.brief, revision: 3, updatedAt: stamp, confirmedAt: stamp } }),
    ({ state, body }) => response({ ...state, goalDraft: { ...body.brief, revision: 3, updatedAt: 'PRIVATE_TIMESTAMP' } }),
    () => response({ private: 'PRIVATE_EMPTY_RESPONSE' }),
  ];
  for (const onPost of scenarios) {
    const { api, calls } = fixture({ onPost });
    const result = await call(api, 'save_task_brief', saveArgs());
    assert.equal(result.structuredContent.status, 'unknown'); assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /可能已经保存/); assert.match(result.structuredContent.error, /get_task_brief/);
    assert.match(result.structuredContent.error, /不要自动重发/);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
    assert.equal(calls.filter(request => request.method === 'POST').length, 1);
    assert.equal(calls.filter(request => request.path === '/api/state').length, 1);
  }
});

test('definitive HTTP rejection and failed preflight use stable public errors', async () => {
  for (const status of [400, 403, 404, 422]) {
    const { api, calls } = fixture({ onPost: () => response({ error: 'PRIVATE_REJECTED_REASON' }, status) });
    const result = await call(api, 'save_task_brief', saveArgs());
    assert.equal(result.structuredContent.status, 'rejected'); assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
    assert.equal(calls.filter(request => request.method === 'POST').length, 1);
  }
  for (const name of ['get_task_brief', 'save_task_brief']) {
    const { api, calls } = fixture({ onRead: () => response({ error: 'PRIVATE_READ_REASON' }, 500) });
    const result = await call(api, name, name === 'save_task_brief' ? saveArgs() : {});
    assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
    assert.equal(calls.filter(request => request.method === 'POST').length, 0);
  }
});

test('real HTTP engine with fake providers saves draft only and guards state and revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-public-brief-'));
  let providerCalls = 0, capabilityCalls = 0;
  const providers = { getCapabilities: async () => { capabilityCalls++; return { liveReady: true, codex: { available: true }, harness: { available: true } }; },
    runAgent: async () => { providerCalls++; throw new Error('unexpected fixture provider call'); } };
  const initial = createInitialState(); initial.mode = 'live'; initial.collaborationMode = 'cooperative';
  const engine = new Orchestrator({ providers, initialState: initial, workspace: directory, persistencePath: join(directory, 'fixture-state.json') });
  const app = createAppServer({ engine, host: '127.0.0.1', port: 0, assetsRoot: directory, workspace: directory, modelCatalogProvider: providers });
  try {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const api = createProtocol({ apiBase: `http://127.0.0.1:${app.server.address().port}`, startService: async () => { throw new Error('fixture server already started'); } });
    const original = engine.getState();
    const first = (await call(api, 'get_task_brief', {})).structuredContent;
    assert.equal(first.stateId, original.id); assert.equal(first.draft.revision, 0);
    const saved = (await call(api, 'save_task_brief', { ...brief, expectedRevision: 0, expectedStateId: first.stateId })).structuredContent;
    assert.equal(saved.status, 'saved'); assert.equal(saved.draft.revision, 1); assert.equal(saved.workspace, directory);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'fixture-state.json'), 'utf8')).goalDraft, { ...brief, revision: 1, updatedAt: saved.draft.updatedAt });
    const current = engine.getState();
    for (const key of ['goal', 'mode', 'collaborationMode', 'leaderId', 'phase', 'tasks', 'messages', 'usage', 'settings', 'activeBrief']) assert.deepEqual(current[key], original[key], `${key} must remain unchanged by draft save`);
    assert.equal(providerCalls, 0); assert.equal(capabilityCalls, 0);
    const stale = (await call(api, 'save_task_brief', { ...brief, expectedRevision: 0, expectedStateId: first.stateId })).structuredContent;
    assert.equal(stale.status, 'conflict'); assert.equal(stale.draft.revision, 1);
    const changedSession = (await call(api, 'save_task_brief', { ...brief, expectedRevision: 1, expectedStateId: 'other-fixture-session' })).structuredContent;
    assert.equal(changedSession.status, 'conflict'); assert.equal(changedSession.comparison.stateChanged, true);
    assert.equal(engine.getState().goalDraft.revision, 1); assert.equal(providerCalls, 0);
  } finally {
    await app.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('relay-public-brief-'));
    await rm(directory, { recursive: true, force: true });
  }
});
