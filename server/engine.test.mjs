import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, promises as filesystem } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { Orchestrator, createInitialState } from './engine.mjs';

async function until(engine, predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const state = engine.getState();
    if (predicate(state)) return state;
    await sleep(3);
  }
  assert.fail(`Timed out waiting for state: ${JSON.stringify(engine.getState(), null, 2)}`);
}
const available = () => ({ codex: { available: true, detail: 'test fake' }, harness: { available: true, detail: 'test fake' }, liveReady: true });
const accepted = (criterionId) => ({ text: JSON.stringify({ verdict: 'accepted', criteria: [{ id: criterionId, status: 'passed', evidence: 'test fixture independently checked' }], feedback: 'test fixture passed' }) });
function workflowEngine(options = {}) {
  return new Orchestrator({ ...options, initialState: { ...(options.initialState ?? createInitialState()), collaborationMode: 'cooperative' } });
}
function deferredAgent(calls, args) {
  return new Promise((resolve, reject) => {
    const abort = () => setTimeout(() => reject(Object.assign(new Error('mock process reaped after abort'), { name: 'AbortError' })), 2);
    args.signal.addEventListener('abort', abort, { once: true });
    calls.push({ ...args, resolve: (value) => { if (!args.signal.aborted) { args.signal.removeEventListener('abort', abort); resolve(value); } }, reject });
  });
}

test('dynamic instance names stay unambiguous when adding or renaming members', async t => {
  const engine = new Orchestrator(); t.after(() => engine.close());
  const before = engine.getState();
  await assert.rejects(engine.action({action:'agentAdd',agent:{name:'codex',provider:'codex',role:'复核'}}), /同名智能体/);
  await assert.rejects(engine.action({action:'agentUpdate',agentId:'deepseek-builder',agent:{name:'Codex'}}), /同名智能体/);
  assert.equal(engine.getState().agents.length,before.agents.length);
  assert.equal(engine.getState().chatSessions['deepseek-builder'].id,before.chatSessions['deepseek-builder'].id);
});

test('demo rejects the missing criterion, retries, and dispatches dependencies only after acceptance', async (t) => {
  const engine = workflowEngine({ demoDelayMs: 5 }); t.after(() => engine.close());
  const observed = [];
  engine.subscribe((state) => {
    const integration = state.tasks.find((task) => task.id === 'task-integrate');
    if (integration.status === 'running') assert.ok(state.tasks.filter((task) => task.id !== integration.id).every((task) => task.status === 'accepted'));
    if (state.tasks[0].status === 'rejected') observed.push('rejected');
  });
  await engine.action({ action: 'start' });
  const state = await until(engine, (snapshot) => snapshot.phase === 'completed');
  assert.ok(observed.includes('rejected'));
  assert.equal(state.tasks[0].attempt, 2);
  assert.ok(state.tasks.every((task) => task.status === 'accepted' && task.criteria.every((criterion) => criterion.status === 'passed' && criterion.evidence)));
  assert.ok(state.tasks.some((task) => task.id === 'task-handoff' && task.status === 'accepted'));
  assert.ok(state.tasks.find((task) => task.id === 'task-integrate').dependsOn.includes('task-handoff'));
  assert.equal(state.usage.supervisorCalls, state.tasks.length + 1);
  assert.equal(state.usage.workerCalls, state.tasks.length + 1);
  assert.equal(state.usage.inputTokens, 0); assert.equal(state.usage.outputTokens, 0);
  assert.ok(state.messages.some((message) => message.kind === 'review' && message.text.includes('请补齐')));
  assert.ok(state.messages.filter((message) => message.role === 'assistant').every((message) => message.text.includes('演示')));
});

test('maxRetries stops the automatic repair loop', async (t) => {
  const engine = workflowEngine({ demoDelayMs: 3 }); t.after(() => engine.close());
  await engine.action({ action: 'settings', settings: { maxRetries: 0 } });
  await engine.action({ action: 'start' });
  const state = await until(engine, (snapshot) => snapshot.phase === 'blocked');
  assert.equal(state.tasks[0].attempt, 1);
  assert.equal(state.tasks[0].status, 'rejected');
  assert.match(state.error, /返工上限/);
  await assert.rejects(engine.action({ action: 'retry', taskId: state.tasks[0].id }), /返工次数/);
});

test('repeated manual completion reviews acquire one atomic review lock', async (t) => {
  const initial = createInitialState();
  initial.tasks = [initial.tasks[1]];
  initial.settings.autoReview = false;
  const engine = workflowEngine({ initialState: initial, demoDelayMs: 8 }); t.after(() => engine.close());
  await engine.action({ action: 'start' });
  await until(engine, (state) => state.tasks[0].status === 'reviewing');
  await Promise.all(Array.from({ length: 5 }, () => engine.action({ action: 'review', taskId: initial.tasks[0].id })));
  const state = await until(engine, (snapshot) => snapshot.phase === 'completed');
  assert.equal(state.usage.supervisorCalls, 1);
  assert.equal(state.activity.filter((activity) => activity.type === 'accepted').length, 1);
});

test('leader epoch ignores a late verdict from the outgoing supervisor', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.phase = 'paused';
  initial.tasks = [{ ...initial.tasks[1], status: 'reviewing', attempt: 1, output: 'A completed test fixture', criteria: [{ id: 'c-one', text: 'fixture criteria', status: 'pending' }] }];
  initial.settings.autoDispatch = false;
  const calls = [];
  const providers = { getCapabilities: available, runAgent: (args) => deferredAgent(calls, args) };
  const engine = workflowEngine({ initialState: initial, providers }); t.after(() => engine.close());
  await engine.action({ action: 'resume' });
  await until(engine, () => calls.length === 1);
  const oldEpoch = engine.getState().epoch;
  await engine.action({ action: 'leader', agentId: 'deepseek-builder' });
  await until(engine, () => calls.length === 2);
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve(accepted('c-one')); await sleep(10);
  assert.equal(engine.getState().tasks[0].status, 'reviewing');
  assert.equal(engine.getState().epoch, oldEpoch + 1);
  calls[1].resolve({ text: JSON.stringify({ verdict: 'rejected', criteria: [{ id: 'c-one', status: 'failed', evidence: 'new leader found fixture missing' }], feedback: 'add missing fixture' }) });
  const state = await until(engine, (snapshot) => snapshot.tasks[0].status === 'rejected');
  assert.equal(state.activity.filter((activity) => activity.type === 'accepted').length, 0);
  assert.equal(state.tasks[0].feedback, 'add missing fixture');
  assert.equal(state.usage.supervisorCalls, 2);
});

test('pause aborts streaming, retains partial output, and resumes with a new attempt', async (t) => {
  const initial = createInitialState(); initial.tasks = [initial.tasks[1]];
  const engine = workflowEngine({ initialState: initial, demoDelayMs: 12 }); t.after(() => engine.close());
  await engine.action({ action: 'start' });
  await until(engine, (state) => Boolean(state.tasks[0].output));
  await engine.action({ action: 'pause' });
  const paused = engine.getState();
  assert.equal(paused.phase, 'paused'); assert.equal(paused.tasks[0].status, 'queued');
  await sleep(60);
  assert.equal(engine.getState().tasks[0].output, paused.tasks[0].output);
  assert.equal(engine.getState().usage.supervisorCalls, 0);
  await engine.action({ action: 'resume' });
  const state = await until(engine, (snapshot) => snapshot.phase === 'completed');
  assert.equal(state.tasks[0].attempt, 2);
});

test('worker and supervisor call budgets prevent further dispatch', async (t) => {
  for (const [limit, expected] of [['maxWorkerCalls', '工作者'], ['maxSupervisorCalls', '监工']]) {
    const engine = workflowEngine({ demoDelayMs: 4 }); t.after(() => engine.close());
    await engine.action({ action: 'settings', settings: { [limit]: 1 } });
    await engine.action({ action: 'start' });
    const state = await until(engine, (snapshot) => snapshot.phase === 'blocked');
    assert.match(state.error, new RegExp(expected));
    assert.equal(state.usage[limit === 'maxWorkerCalls' ? 'workerCalls' : 'supervisorCalls'], 1);
    await sleep(30);
    assert.notEqual(engine.getState().phase, 'completed');
  }
});

test('saved in-flight work restores paused with evidence intact and no automatic calls', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-engine-test-'));
  const persistencePath = join(directory, 'state.json');
  const initial = createInitialState(); initial.phase = 'running';
  delete initial.collaborationMode;
  initial.tasks[0].status = 'running'; initial.tasks[0].output = 'preserved partial result';
  initial.tasks[1].status = 'reviewing'; initial.tasks[1].output = 'completed output awaiting review';
  writeFileSync(persistencePath, JSON.stringify(initial));
  const engine = new Orchestrator({ persistencePath, demoDelayMs: 2 });
  t.after(async () => { await engine.close(); rmSync(directory, { recursive: true, force: true }); });
  const state = engine.getState();
  assert.equal(state.collaborationMode, 'independent');
  assert.equal(state.phase, 'paused');
  assert.equal(state.tasks[0].status, 'queued'); assert.equal(state.tasks[0].output, initial.tasks[0].output);
  assert.equal(state.tasks[1].status, 'reviewing'); assert.equal(state.tasks[1].output, initial.tasks[1].output);
  await sleep(30); assert.equal(engine.getState().usage.supervisorCalls, 0);
});

test('live mode creates a plan from the user goal, serializes shared-workspace workers, and requires criterion evidence', async (t) => {
  let workersRunning = 0; let maxParallelWorkers = 0; const prompts = [];
  const providers = {
    getCapabilities: available,
    runAgent: async ({ prompt, onDelta }) => {
      prompts.push(prompt);
      if (prompt.startsWith('你是协作负责人')) return { text: JSON.stringify({ tasks: ['a', 'b'].map((suffix) => ({ id: `task-${suffix}`, title: `Task ${suffix}`, description: 'test task description', agentId: `deepseek-${suffix === 'a' ? 'builder' : 'tester'}`, dependsOn: [], criteria: [{ id: `criterion-${suffix}`, text: 'verifiable fixture' }] })) }) };
      if (prompt.startsWith('你是监工')) return accepted(prompt.includes('任务：Task a') ? 'criterion-a' : 'criterion-b');
      workersRunning += 1; maxParallelWorkers = Math.max(maxParallelWorkers, workersRunning);
      onDelta('test tool activity', { type: 'tool' }); onDelta('public test output');
      await sleep(15); workersRunning -= 1;
      return { text: 'public test output with verifiable fixture', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const engine = workflowEngine({ providers, demoDelayMs: 2 }); t.after(() => engine.close());
  await engine.action({ action: 'mode', mode: 'live' });
  assert.equal(engine.getState().tasks.length, 0);
  await engine.action({ action: 'goal', text: 'Use my exact test goal' });
  await engine.action({ action: 'start' });
  const state = await until(engine, (snapshot) => snapshot.phase === 'completed');
  assert.ok(prompts[0].includes('Use my exact test goal'));
  assert.equal(maxParallelWorkers, 1);
  assert.equal(state.tasks.length, 2); assert.equal(state.usage.supervisorCalls, 3); assert.equal(state.usage.workerCalls, 2);
  assert.equal(state.usage.inputTokens, 20); assert.equal(state.usage.outputTokens, 10);
  assert.ok(state.messages.some((message) => message.kind === 'tool' && message.text === 'test tool activity'));
  assert.ok(state.tasks.every((task) => !task.output.includes('test tool activity')));
});

test('a malformed or incomplete live acceptance is rejected rather than marked complete', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.tasks = [initial.tasks[1]]; initial.settings.maxRetries = 0;
  const providers = { getCapabilities: available, runAgent: async ({ prompt }) => prompt.startsWith('你是监工')
    ? { text: JSON.stringify({ verdict: 'accepted', criteria: [], feedback: 'looks good' }) }
    : { text: 'claimed work without evidence' } };
  const engine = workflowEngine({ initialState: initial, providers, demoDelayMs: 2 }); t.after(() => engine.close());
  await engine.action({ action: 'start' });
  const state = await until(engine, (snapshot) => snapshot.phase === 'blocked');
  assert.equal(state.tasks[0].status, 'rejected');
  assert.ok(state.tasks[0].criteria.every((criterion) => criterion.status === 'failed'));
  assert.match(state.tasks[0].feedback, /缺少唯一结果或证据/);
});

test('starting unconfigured live adapters does not call a model', async (t) => {
  const engine = workflowEngine(); t.after(() => engine.close());
  await engine.action({ action: 'mode', mode: 'live' });
  await assert.rejects(engine.action({ action: 'start' }), /真实模式尚不可用/);
  assert.equal(engine.getState().usage.supervisorCalls, 0);
  assert.equal(engine.getState().phase, 'idle');
});

test('an incoming leader finishes its worker output before supervising, without dropping work', async (t) => {
  const initial = createInitialState(); initial.tasks = [initial.tasks[1]];
  const engine = workflowEngine({ initialState: initial, demoDelayMs: 8 }); t.after(() => engine.close());
  await engine.action({ action: 'start' });
  await until(engine, (state) => Boolean(state.tasks[0].output));
  await engine.action({ action: 'leader', agentId: initial.tasks[0].agentId });
  assert.equal(engine.getState().tasks[0].status, 'running');
  const state = await until(engine, (snapshot) => snapshot.phase === 'completed');
  assert.equal(state.tasks[0].attempt, 1);
  assert.equal(state.leaderId, initial.tasks[0].agentId);
  assert.equal(state.usage.workerCalls, 1);
  assert.equal(state.usage.supervisorCalls, 1);
  assert.ok(state.messages.some((message) => message.agentId === state.leaderId && message.kind === 'review'));
});

test('HTTP preserves UTF-8 split across chunks and SSE delivers the resulting full snapshot', async (t) => {
  // index initializes local configuration; keep this HTTP fixture from reading
  // or decrypting a real user's credential while still using a fake engine.
  const hadEnvironmentKey = Object.hasOwn(process.env, 'DEEPSEEK_API_KEY');
  if (!hadEnvironmentKey) process.env.DEEPSEEK_API_KEY = 'TEST_FIXTURE_NO_REAL_REQUESTS';
  let createAppServer;
  try { ({ createAppServer } = await import('./index.mjs')); }
  finally { if (!hadEnvironmentKey) delete process.env.DEEPSEEK_API_KEY; }
  const engine = new Orchestrator({ demoDelayMs: 2 });
  const app = createAppServer({ engine, port: 0 });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); const url = `http://127.0.0.1:${address.port}`;
  const eventsController = new AbortController();
  t.after(() => { eventsController.abort(); app.close(); });
  const events = await fetch(`${url}/api/events`, { signal: eventsController.signal });
  assert.equal(events.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = events.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: snapshot/);
  const expected = '同时看到监工与 DeepSeek 输出，完成后自动验收。';
  const bytes = Buffer.from(JSON.stringify({ action: 'goal', text: expected }));
  const firstChinese = bytes.indexOf(Buffer.from('同'));
  const resultPromise = new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
    // Force one Chinese UTF-8 codepoint to arrive in three different chunks.
    request.write(bytes.subarray(0, firstChinese + 1));
    setTimeout(() => request.write(bytes.subarray(firstChinese + 1, firstChinese + 2)), 5);
    setTimeout(() => request.end(bytes.subarray(firstChinese + 2)), 10);
  });
  const result = await resultPromise;
  assert.equal(result.status, 200); assert.equal(result.body.goal, expected);
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.match(update, /event: snapshot/);
  assert.ok(update.includes(expected));
  await reader.cancel(); eventsController.abort();
});

function followUpFixture() {
  const initial = createInitialState(); initial.mode = 'live'; initial.phase = 'paused';
  initial.tasks = [
    { id: 'task-origin', title: 'Original task', description: 'original scope', agentId: 'deepseek-builder', status: 'reviewing', attempt: 1, dependsOn: [], output: 'original fixture evidence', criteria: [{ id: 'c-origin', text: 'original criterion must pass', status: 'pending' }] },
    { id: 'task-downstream', title: 'Downstream task', description: 'later delivery', agentId: 'deepseek-tester', status: 'queued', attempt: 0, dependsOn: ['task-origin'], criteria: [{ id: 'c-downstream', text: 'later criterion', status: 'pending' }] },
  ];
  return initial;
}
const newFollowUp = (overrides = {}) => ({ id: 'task-extra', title: 'Additional handoff', description: 'prepare missing handoff details', agentId: 'deepseek-tester', dependsOn: [], criteria: [{ id: 'c-extra', text: 'handoff evidence exists' }], ...overrides });

test('valid supervisor follow-ups are appended atomically and downstream work waits for their acceptance', async (t) => {
  const initial = followUpFixture();
  const providers = { getCapabilities: available, runAgent: async ({ prompt }) => {
    if (!prompt.startsWith('你是监工')) return { text: 'independently verifiable test fixture' };
    if (prompt.includes('任务 id：task-origin\n')) return { text: JSON.stringify({ ...JSON.parse(accepted('c-origin').text), followUpTasks: [newFollowUp()] }) };
    return accepted(prompt.includes('任务 id：task-extra\n') ? 'c-extra' : 'c-downstream');
  } };
  const engine = workflowEngine({ initialState: initial, providers }); t.after(() => engine.close());
  engine.subscribe((state) => {
    if (state.tasks.find((task) => task.id === 'task-downstream').status === 'running') assert.equal(state.tasks.find((task) => task.id === 'task-extra')?.status, 'accepted');
  });
  await engine.action({ action: 'resume' });
  const state = await until(engine, (snapshot) => snapshot.phase === 'completed');
  const extra = state.tasks.find((task) => task.id === 'task-extra');
  assert.ok(extra.dependsOn.includes('task-origin'));
  assert.ok(state.tasks.find((task) => task.id === 'task-downstream').dependsOn.includes(extra.id));
  assert.equal(state.tasks.filter((task) => task.id === extra.id).length, 1);
  assert.equal(state.tasks[0].criteria[0].text, 'original criterion must pass');
  assert.equal(state.usage.supervisorCalls, 3); assert.equal(state.usage.workerCalls, 2);
  assert.ok(state.activity.some((activity) => activity.type === 'plan' && activity.text.includes('追加 1 项任务')));
});

test('invalid follow-up JSON, duplicate IDs, unknown dependencies, cycles, task caps, and budgets cannot bypass original acceptance', async (t) => {
  const cases = [
    { name: 'not-an-array', tasks: 'invalid JSON shape' },
    { name: 'duplicate', tasks: [newFollowUp({ id: 'task-origin' })] },
    { name: 'unknown', tasks: [newFollowUp({ dependsOn: ['task-missing'] })] },
    { name: 'cycle-after-insertion', tasks: [newFollowUp({ dependsOn: ['task-downstream'] })] },
    { name: 'task-cap', tasks: Array.from({ length: 11 }, (_, index) => newFollowUp({ id: `extra-${index}` })) },
    { name: 'budget', tasks: [newFollowUp(), newFollowUp({ id: 'task-extra-2' })], maxWorkerCalls: 1 },
  ];
  for (const fixture of cases) {
    const initial = followUpFixture(); initial.settings.maxRetries = 0;
    if (fixture.maxWorkerCalls) initial.settings.maxWorkerCalls = fixture.maxWorkerCalls;
    const providers = { getCapabilities: available, runAgent: async () => ({ text: JSON.stringify({ ...JSON.parse(accepted('c-origin').text), followUpTasks: fixture.tasks }) }) };
    const engine = workflowEngine({ initialState: initial, providers, demoDelayMs: 1 }); t.after(() => engine.close());
    await engine.action({ action: 'resume' });
    const state = await until(engine, (snapshot) => snapshot.phase === 'blocked');
    assert.equal(state.tasks.length, initial.tasks.length, fixture.name);
    assert.equal(state.tasks[0].status, 'rejected', fixture.name);
    assert.equal(state.tasks[1].status, 'queued', fixture.name);
    assert.equal(state.usage.workerCalls, 0, fixture.name);
    assert.ok(state.tasks[0].criteria.every((criterion) => criterion.status === 'failed'), fixture.name);
  }
});

test('a transient Windows rename lock retries safely and coalesces the latest UTF-8 snapshot', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-persist-test-'));
  const persistencePath = join(directory, 'state.json');
  const previous = createInitialState(); previous.goal = '旧有效状态';
  writeFileSync(persistencePath, JSON.stringify(previous));
  let attempts = 0; const sources = []; const removals = [];
  const engine = new Orchestrator({ persistencePath, persistenceRetryDelays: [1, 2], fileOps: {
    rename: async (source, target) => {
      attempts += 1; sources.push(source);
      if (attempts === 1) {
        assert.equal(JSON.parse(readFileSync(target, 'utf8')).goal, previous.goal);
        throw Object.assign(new Error('temporarily locked by Windows'), { code: 'EPERM' });
      }
      await filesystem.rename(source, target);
    },
    unlink: async (path) => { removals.push(path); await filesystem.unlink(path); },
  } });
  t.after(async () => { await engine.close(); rmSync(directory, { recursive: true, force: true }); });
  await Promise.all(Array.from({ length: 8 }, (_, number) => engine.action({ action: 'goal', text: `最新目标 ${number} · 自动核查` })));
  assert.equal(await engine.flushPersistence(), true);
  const saved = JSON.parse(readFileSync(persistencePath, 'utf8'));
  assert.equal(saved.goal, '最新目标 7 · 自动核查');
  assert.equal(saved.messages.at(-2).text, saved.goal);
  assert.ok(attempts >= 2); assert.equal(sources[0], sources[1]);
  assert.ok(sources.every((source) => source !== `${persistencePath}.tmp` && source.startsWith(`${persistencePath}.`)));
  assert.ok(removals.every((path) => path !== persistencePath));
  assert.equal(engine.getState().phase, 'idle'); assert.equal(engine.getState().error, undefined);
});

test('exhausted persistence retries preserve the old JSON, visibly pause work, and require successful save before resuming', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-persist-test-'));
  const persistencePath = join(directory, 'state.json');
  const previous = createInitialState(); previous.goal = '最后一次确实保存的目标';
  previous.collaborationMode = 'cooperative';
  writeFileSync(persistencePath, JSON.stringify(previous));
  let locked = true; let attempts = 0;
  const engine = new Orchestrator({ persistencePath, demoDelayMs: 5, persistenceRetryDelays: [1, 1], fileOps: {
    rename: async (source, target) => {
      attempts += 1;
      if (locked) throw Object.assign(new Error('destination is locked'), { code: 'EPERM' });
      await filesystem.rename(source, target);
    },
  } });
  t.after(async () => { locked = false; await engine.close(); rmSync(directory, { recursive: true, force: true }); });
  await engine.action({ action: 'start' });
  const state = await until(engine, (snapshot) => snapshot.phase === 'paused' && snapshot.error?.includes('状态尚未保存'));
  assert.match(state.error, /EPERM/); assert.match(state.error, /旧有效状态文件已保留/);
  assert.equal(JSON.parse(readFileSync(persistencePath, 'utf8')).goal, previous.goal);
  assert.equal(attempts, 3); assert.equal(await engine.flushPersistence(), false);
  await sleep(25); assert.equal(attempts, 3);
  await assert.rejects(engine.action({ action: 'resume' }), /状态尚未保存/);
  assert.equal(attempts, 6); assert.equal(engine.getState().phase, 'paused');
  locked = false;
  await engine.action({ action: 'resume' });
  const completed = await until(engine, (snapshot) => snapshot.phase === 'completed');
  assert.equal(completed.error, undefined);
  assert.equal(await engine.flushPersistence(), true);
  assert.equal(JSON.parse(readFileSync(persistencePath, 'utf8')).phase, 'completed');
  assert.ok(completed.activity.some((event) => event.type === 'persistence-error'));
  assert.ok(completed.activity.some((event) => event.type === 'persistence'));
});

test('fallback chat carries only that side and conversation history, excludes internal work, and is not limited by workflow budgets', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.settings.maxWorkerCalls = 1;
  initial.messages.push({ id: 'internal-plan', agentId: 'deepseek-builder', role: 'assistant', kind: 'message', text: 'INTERNAL_PLANNER_JSON_SHOULD_NOT_LEAK', taskId: 'task-interface', at: new Date().toISOString() });
  const calls = [];
  const providers = { getCapabilities: available, runAgent: async (args) => { calls.push(args); return { text: `ANSWER_${calls.length}_${args.agent.id}` }; } };
  const engine = new Orchestrator({ initialState: initial, providers }); t.after(() => engine.close());
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'PRIVATE_LEFT_SIDE' });
  await until(engine, (state) => state.chatSessions['codex-supervisor'].status === 'idle');
  await engine.action({ action: 'message', agentId: 'deepseek-builder', text: 'Remember RIGHT_ONLY 42' });
  await until(engine, (state) => state.chatSessions['deepseek-builder'].status === 'idle');
  await engine.action({ action: 'message', agentId: 'deepseek-builder', text: 'What number did I give you?' });
  const state = await until(engine, (snapshot) => snapshot.chatSessions['deepseek-builder'].status === 'idle');
  assert.equal(calls.length, 3);
  assert.ok(calls[2].prompt.includes('Remember RIGHT_ONLY 42'));
  assert.ok(calls[2].prompt.includes('ANSWER_2_deepseek-builder'));
  assert.ok(!calls[2].prompt.includes('PRIVATE_LEFT_SIDE'));
  assert.ok(!calls[2].prompt.includes('INTERNAL_PLANNER_JSON_SHOULD_NOT_LEAK'));
  assert.equal(calls[2].prompt.split('What number did I give you?').length - 1, 1);
  assert.equal(calls[2].session, undefined);
  assert.equal(state.phase, 'idle'); assert.equal(state.error, undefined); assert.equal(state.usage.workerCalls, 2);
  const oldConversation = state.chatSessions['deepseek-builder'].id;
  const leftConversation = state.chatSessions['codex-supervisor'].id;
  const oldMessages = state.messages.filter((message) => message.conversationId === oldConversation);
  await engine.action({ action: 'newChat', agentId: 'deepseek-builder' });
  assert.notEqual(engine.getState().chatSessions['deepseek-builder'].id, oldConversation);
  assert.equal(engine.getState().chatSessions['codex-supervisor'].id, leftConversation);
  assert.deepEqual(engine.getState().messages.filter((message) => message.conversationId === oldConversation), oldMessages);
  await engine.action({ action: 'message', agentId: 'deepseek-builder', text: 'A fresh topic' });
  await until(engine, (snapshot) => snapshot.chatSessions['deepseek-builder'].status === 'idle');
  assert.ok(!calls[3].prompt.includes('RIGHT_ONLY')); assert.ok(!calls[3].prompt.includes('ANSWER_2'));
});

test('Codex native chat resumes with just the new turn, persists early IDs through errors, and works when Harness is unavailable', async (t) => {
  const calls = [];
  const providers = {
    getCapabilities: () => ({ codex: { available: true, detail: 'mock Codex' }, harness: { available: false, detail: 'Harness not configured' }, liveReady: false }),
    runAgent: async (args) => {
      calls.push(args); const reference = { provider: 'codex', id: 'native-codex-thread' };
      args.onSession(reference);
      if (calls.length === 1) throw Object.assign(new Error('first turn failed after thread creation'), { session: reference });
      return { text: 'Native conversation continued', session: reference };
    },
  };
  const engine = new Orchestrator({ providers }); t.after(() => engine.close());
  await engine.action({ action: 'mode', mode: 'live' });
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'NATIVE_FIRST_PRIVATE_TEXT' });
  const failed = await until(engine, (state) => state.chatSessions['codex-supervisor'].status === 'idle');
  assert.equal(failed.chatSessions['codex-supervisor'].providerSession.id, 'native-codex-thread');
  assert.match(failed.chatSessions['codex-supervisor'].lastError, /first turn failed/);
  assert.equal(failed.phase, 'idle'); assert.equal(failed.error, undefined);
  await assert.rejects(engine.action({ action: 'message', agentId: 'deepseek-builder', text: 'try unavailable right side' }), /Harness not configured/);
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'Continue my native thread' });
  const state = await until(engine, (snapshot) => snapshot.chatSessions['codex-supervisor'].status === 'idle');
  assert.deepEqual(calls[1].session, { provider: 'codex', id: 'native-codex-thread' });
  assert.ok(calls[1].prompt.includes('Continue my native thread'));
  assert.ok(!calls[1].prompt.includes('NATIVE_FIRST_PRIVATE_TEXT'));
  assert.equal(state.chatSessions['codex-supervisor'].lastError, undefined);
  assert.equal(state.chatSessions['deepseek-builder'].lastError, 'Harness not configured');
  const oldLeft = state.chatSessions['codex-supervisor'].id;
  const oldRight = state.chatSessions['deepseek-builder'].id;
  await engine.action({ action: 'model', agentId: 'codex-supervisor', model: 'gpt-test-model' });
  const changed = engine.getState();
  assert.equal(changed.agents[0].modelId, 'gpt-test-model');
  assert.notEqual(changed.chatSessions['codex-supervisor'].id, oldLeft);
  assert.equal(changed.chatSessions['codex-supervisor'].providerSession, undefined);
  assert.equal(changed.chatSessions['deepseek-builder'].id, oldRight);
  assert.equal(changed.chatArchives[oldLeft].providerSession.id, 'native-codex-thread');
  await assert.rejects(engine.action({ action: 'model', agentId: 'codex-supervisor', model: 'not a valid\nmodel' }), /有效的模型 ID/);
});

test('cancel and new-chat stop only one side, preserve partial history and queued work, and ignore late callbacks', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.phase = 'paused';
  initial.agents[0].accessMode = 'read-only'; initial.agents[1].accessMode = 'read-only';
  initial.tasks = [{ ...initial.tasks[1], agentId: 'deepseek-tester' }];
  const calls = [];
  const providers = { getCapabilities: available, runAgent: (args) => deferredAgent(calls, args) };
  const engine = workflowEngine({ initialState: initial, providers }); t.after(() => engine.close());
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'left independent chat' });
  await engine.action({ action: 'message', agentId: 'deepseek-builder', text: 'right independent chat' });
  await until(engine, () => calls.length === 2);
  const left = calls.find((call) => call.agent.id === 'codex-supervisor');
  const right = calls.find((call) => call.agent.id === 'deepseek-builder');
  left.onSession({ provider: 'codex', id: 'left-active-native-id' });
  left.onDelta('Left partial output'); right.onDelta('Right partial output');
  const before = engine.getState(); const rightConversation = before.chatSessions['deepseek-builder'].id;
  await engine.action({ action: 'cancelChat', agentId: 'codex-supervisor' });
  const cancelled = engine.getState();
  assert.equal(left.signal.aborted, true); assert.equal(right.signal.aborted, false);
  assert.equal(cancelled.phase, 'paused'); assert.equal(cancelled.epoch, before.epoch); assert.equal(cancelled.tasks[0].status, 'queued');
  assert.equal(cancelled.chatSessions['codex-supervisor'].status, 'idle'); assert.equal(cancelled.chatSessions['deepseek-builder'].status, 'running');
  assert.ok(cancelled.messages.some((message) => message.text === 'Left partial output' && message.status === 'cancelled'));
  await engine.action({ action: 'newChat', agentId: 'deepseek-builder' });
  assert.equal(right.signal.aborted, true);
  assert.notEqual(engine.getState().chatSessions['deepseek-builder'].id, rightConversation);
  assert.ok(engine.getState().messages.some((message) => message.conversationId === rightConversation && message.text === 'Right partial output'));
  assert.equal(engine.getState().chatArchives[rightConversation].agentId, 'deepseek-builder');
  left.onSession({ provider: 'codex', id: 'late-native-id' }); left.onDelta('LATE_LEFT_OUTPUT'); right.onDelta('LATE_RIGHT_OUTPUT');
  left.resolve({ text: 'LATE_LEFT_COMPLETE', session: { provider: 'codex', id: 'late-native-id' } }); right.resolve({ text: 'LATE_RIGHT_COMPLETE' });
  await sleep(10);
  assert.ok(!engine.getState().messages.some((message) => message.text.includes('LATE_')));
  assert.equal(engine.getState().chatSessions['codex-supervisor'].providerSession.id, 'left-active-native-id');
  assert.equal(engine.getState().tasks[0].status, 'queued');
});

test('chat archives and Codex native references survive restart without resuming output automatically', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-chat-test-')); const persistencePath = join(directory, 'state.json');
  const providers = { getCapabilities: available, runAgent: async (args) => { args.onSession({ provider: 'codex', id: 'saved-native-id' }); return { text: 'Saved conversation output', session: { provider: 'codex', id: 'saved-native-id' } }; } };
  const engine = new Orchestrator({ persistencePath, providers });
  let restored;
  t.after(async () => { await engine.close(); await restored?.close(); rmSync(directory, { recursive: true, force: true }); });
  await engine.action({ action: 'mode', mode: 'live' });
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'Keep this conversation' });
  await until(engine, (state) => state.chatSessions['codex-supervisor'].status === 'idle');
  const originalId = engine.getState().chatSessions['codex-supervisor'].id;
  await engine.action({ action: 'newChat', agentId: 'codex-supervisor' });
  await engine.close();
  const persistedRevision = JSON.parse(readFileSync(persistencePath, 'utf8')).revision;
  restored = new Orchestrator({ persistencePath, providers });
  const state = restored.getState();
  assert.ok(state.revision > persistedRevision);
  assert.equal(state.chatArchives[originalId].providerSession.id, 'saved-native-id');
  assert.equal(state.chatArchives[originalId].agent.provider, 'codex');
  assert.equal(state.chatArchives[originalId].agent.reasoningEffort, 'auto');
  assert.ok(state.messages.some((message) => message.conversationId === originalId && message.text === 'Saved conversation output'));
  assert.equal(state.chatSessions['codex-supervisor'].status, 'idle');
  assert.equal(state.chatSessions['codex-supervisor'].providerSession, undefined);
  assert.notEqual(state.chatSessions['codex-supervisor'].id, originalId);
});

test('independent is the default and enforces workflow rejection while ordinary side chats remain available', async (t) => {
  let calls = 0;
  const providers = { getCapabilities: available, runAgent: async () => { calls += 1; return { text: 'Independent ordinary reply' }; } };
  const initial = createInitialState(); initial.mode = 'live';
  const engine = new Orchestrator({ initialState: initial, providers }); t.after(() => engine.close());
  assert.equal(engine.getState().collaborationMode, 'independent');
  for (const action of ['start', 'resume', 'review', 'retry']) await assert.rejects(engine.action({ action, taskId: initial.tasks[0].id }), /非合作模式/);
  await assert.rejects(engine.action({ action: 'cooperativeGoal', text: 'Do not secretly dispatch' }), /非合作模式/);
  assert.equal(calls, 0);
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'ordinary independent request' });
  await until(engine, (state) => state.chatSessions['codex-supervisor'].status === 'idle');
  const before = engine.getState();
  await engine.action({ action: 'collaboration', mode: 'cooperative' }); await sleep(10);
  assert.equal(calls, 1); assert.equal(engine.getState().phase, 'idle');
  assert.deepEqual(engine.getState().tasks, before.tasks); assert.deepEqual(engine.getState().usage, before.usage);
  await engine.action({ action: 'collaboration', mode: 'independent' }); await sleep(10);
  assert.equal(calls, 1); assert.deepEqual(engine.getState().messages, before.messages);
  await assert.rejects(engine.action({ action: 'collaboration', mode: 'unknown' }), /合作模式必须/);
});

test('switching independent cancels old planner or review decisions, permits chat, and preserves evidence and budgets', async (t) => {
  for (const kind of ['plan', 'review']) {
    const initial = createInitialState(); initial.mode = 'live';
    initial.tasks = kind === 'plan' ? [] : [{ ...initial.tasks[1], status: 'reviewing', attempt: 1, output: 'preserved task artifact', criteria: [{ id: 'mode-proof', text: 'original evidence', status: 'pending' }] }];
    const calls = [];
    const providers = { getCapabilities: available, runAgent: (args) => deferredAgent(calls, args) };
    const engine = workflowEngine({ initialState: initial, providers }); t.after(() => engine.close());
    await engine.action({ action: 'resume' }); await until(engine, () => calls.length === 1);
    const before = engine.getState();
    await engine.action({ action: 'collaboration', mode: 'independent' });
    const paused = engine.getState();
    assert.equal(paused.phase, 'paused', kind); assert.equal(paused.collaborationMode, 'independent', kind);
    assert.equal(calls[0].signal.aborted, true, kind);
    assert.deepEqual(paused.tasks, before.tasks, kind); assert.deepEqual(paused.usage, before.usage, kind); assert.equal(paused.goal, before.goal, kind);
    calls[0].resolve(kind === 'review' ? accepted('mode-proof') : { text: JSON.stringify({ tasks: [newFollowUp()] }) });
    await until(engine, (state) => state.executionSummary.retiringReaders === 0 && state.executionSummary.retiringWriters === 0);
    await engine.action({ action: 'message', agentId: 'deepseek-builder', text: 'keep this independent side conversation' });
    await until(engine, () => calls.length === 2);
    calls[1].onDelta('Side reply continues'); calls[1].resolve({ text: 'Side reply continues' });
    await until(engine, (state) => state.chatSessions['deepseek-builder'].status === 'idle');
    assert.deepEqual(engine.getState().tasks, before.tasks, kind);
    assert.equal(calls.length, 2, kind);
    await engine.action({ action: 'settings', settings: { autoReview: true, autoDispatch: true } });
    await engine.action({ action: 'collaboration', mode: 'cooperative' }); await sleep(10);
    assert.equal(calls.length, 2, kind); assert.equal(engine.getState().phase, 'paused', kind);
    assert.ok(engine.getState().messages.some((message) => message.text === 'Side reply continues'), kind);
  }
});

test('cooperativeGoal actually plans, dispatches, and checks outputs without resetting budgets or polluting ordinary chat context', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.usage.supervisorCalls = 2; initial.usage.workerCalls = 3;
  let releasePlan; const planReady = new Promise((resolve) => { releasePlan = resolve; });
  const calls = [];
  const providers = { getCapabilities: available, runAgent: async (args) => {
    calls.push(args);
    if (args.prompt.startsWith('你是协作负责人')) {
      assert.ok(args.prompt.includes('UNIQUE_COOPERATIVE_TARGET'));
      await planReady;
      return { text: JSON.stringify({ tasks: [newFollowUp({ id: 'goal-piece', title: 'Actual goal delivery', criteria: [{ id: 'goal-proof', text: 'actual output evidence' }] })] }) };
    }
    if (args.prompt.startsWith('你是监工')) return accepted('goal-proof');
    if (args.prompt.startsWith('你是本地多模型协作系统')) return { text: 'Concrete completed worker output' };
    return { text: 'plain chat answer' };
  } };
  const engine = new Orchestrator({ initialState: initial, providers }); t.after(() => engine.close());
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'CHAT_HISTORY_KEEP' });
  await until(engine, (state) => state.chatSessions['codex-supervisor'].status === 'idle');
  await engine.action({ action: 'collaboration', mode: 'cooperative' }); assert.equal(calls.length, 1);
  const submission = await engine.action({ action: 'cooperativeGoal', text: 'UNIQUE_COOPERATIVE_TARGET' });
  assert.equal(submission.phase, 'running'); assert.equal(submission.goal, 'UNIQUE_COOPERATIVE_TARGET');
  await until(engine, () => calls.length === 2);
  await assert.rejects(engine.action({ action: 'cooperativeGoal', text: 'silently replace active goal' }), /先暂停/);
  assert.equal(engine.getState().goal, 'UNIQUE_COOPERATIVE_TARGET');
  releasePlan();
  const completed = await until(engine, (state) => state.phase === 'completed');
  assert.equal(completed.tasks[0].status, 'accepted'); assert.equal(completed.tasks[0].output, 'Concrete completed worker output');
  assert.equal(completed.tasks[0].criteria[0].status, 'passed');
  assert.equal(completed.usage.supervisorCalls, 5); assert.equal(completed.usage.workerCalls, 4);
  assert.equal(calls.length, 4);
  await engine.action({ action: 'collaboration', mode: 'independent' });
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'ordinary follow-up after cooperation' });
  await until(engine, (state) => state.chatSessions['codex-supervisor'].status === 'idle');
  const ordinary = calls.at(-1).prompt;
  assert.ok(ordinary.includes('CHAT_HISTORY_KEEP')); assert.ok(!ordinary.includes('UNIQUE_COOPERATIVE_TARGET'));
  assert.ok(!ordinary.includes('test fixture independently checked'));
});

function fakeCatalog({ provider }) {
  const efforts = provider === 'deepseek' ? ['off', 'low', 'high', 'max'] : ['low', 'medium', 'high'];
  return { available: true, catalogOnly: true, detail: 'mock catalog', models: ['a', 'b'].map((suffix) => ({
    id: `${provider}-${suffix}`, label: `${provider}-${suffix}`, isDefault: suffix === 'a', reasoningEffortSupported: true,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })), defaultReasoningEffort: 'high',
  })) };
}

test('dynamic teams enforce 2–8 members, keep configured roles, preserve archive metadata, and remap only unexecuted demo samples', async (t) => {
  const engine = new Orchestrator({ providers: { getCapabilities: available, getModels: fakeCatalog, runAgent: () => assert.fail('configuration must not call a model') } });
  t.after(() => engine.close());
  const before = engine.getState();
  const added = await engine.action({ action: 'agentAdd', agent: { name: 'New critic', provider: 'codex', modelId: 'codex-b', reasoningEffort: 'high', role: 'Critical review', hidden: true } });
  const critic = added.agents.find((agent) => agent.name === 'New critic');
  assert.ok(critic.id.startsWith('agent-')); assert.equal(critic.hidden, true); assert.equal(critic.role, 'Critical review');
  assert.ok(added.chatSessions[critic.id]); assert.ok(added.revision > before.revision);
  const chatId = added.chatSessions[critic.id].id;
  const renamed = await engine.action({ action: 'agentUpdate', agentId: critic.id, agent: { name: 'Exact critic', role: 'Custom retained role' } });
  assert.equal(renamed.agents.find((agent) => agent.id === critic.id).role, 'Custom retained role');
  assert.equal(renamed.chatSessions[critic.id].id, chatId);
  const shown = await engine.action({ action: 'agentVisibility', agentId: critic.id, hidden: false });
  assert.equal(shown.agents.find((agent) => agent.id === critic.id).hidden, false);
  assert.ok(shown.revision > renamed.revision); assert.equal(shown.messages.length, renamed.messages.length);
  await engine.action({ action: 'agentRemove', agentId: critic.id });
  assert.equal(engine.getState().chatArchives[chatId].agent.role, 'Custom retained role');
  await engine.action({ action: 'agentRemove', agentId: 'deepseek-tester' });
  assert.equal(engine.getState().agents.length, 2);
  assert.ok(engine.getState().tasks.every((task) => engine.getState().agents.some((agent) => agent.id === task.agentId)));
  await assert.rejects(engine.action({ action: 'agentRemove', agentId: 'deepseek-builder' }), /至少保留 2/);
  for (let number = 0; number < 6; number++) await engine.action({ action: 'agentAdd', agent: { name: `Worker ${number}`, provider: 'deepseek', modelId: 'deepseek-a', role: `Role ${number}` } });
  assert.equal(engine.getState().agents.length, 8);
  await assert.rejects(engine.action({ action: 'agentAdd', agent: { name: 'Ninth', provider: 'deepseek' } }), /最多支持 8/);
  await engine.action({ action: 'reset' });
  assert.ok(engine.getState().tasks.every((task) => engine.getState().agents.some((agent) => agent.id === task.agentId)));
  await assert.rejects(engine.action({ action: 'agentAdd', agent: { id: 'injected', name: 'Invalid', provider: 'codex' } }), /最多支持 8/);
});

test('model and reasoning choices use the actual catalog, clear explicitly, and archive the previous identity', async (t) => {
  const engine = new Orchestrator({ providers: { getCapabilities: available, getModels: fakeCatalog, runAgent: () => assert.fail('no inference needed') } }); t.after(() => engine.close());
  await engine.action({ action: 'model', agentId: 'codex-supervisor', model: 'codex-a' });
  const originalChat = engine.getState().chatSessions['codex-supervisor'].id;
  await engine.action({ action: 'agentUpdate', agentId: 'codex-supervisor', agent: { reasoningEffort: 'high' } });
  assert.notEqual(engine.getState().chatSessions['codex-supervisor'].id, originalChat);
  assert.equal(engine.getState().chatArchives[originalChat].agent.reasoningEffort, 'auto');
  for (const clear of [null, '', 'default', 'auto']) {
    await engine.action({ action: 'agentUpdate', agentId: 'codex-supervisor', agent: { reasoningEffort: clear } });
    assert.equal(engine.getState().agents[0].reasoningEffort, 'auto');
    await engine.action({ action: 'agentUpdate', agentId: 'codex-supervisor', agent: { reasoningEffort: 'low' } });
  }
  const preserved = engine.getState();
  await assert.rejects(engine.action({ action: 'model', agentId: 'codex-supervisor', model: 'unknown-model' }), /实际目录/);
  assert.equal(engine.getState().chatSessions['codex-supervisor'].id, preserved.chatSessions['codex-supervisor'].id);
  await assert.rejects(engine.action({ action: 'agentUpdate', agentId: 'codex-supervisor', agent: { reasoningEffort: 'off' } }), /未确认支持/);
  await assert.rejects(engine.action({ action: 'agentUpdate', agentId: 'deepseek-builder', agent: { modelId: 'deepseek-a', reasoningEffort: 'medium' } }), /未确认支持/);
  await engine.action({ action: 'agentUpdate', agentId: 'deepseek-builder', agent: { modelId: 'deepseek-a', reasoningEffort: 'off' } });
  assert.equal(engine.getState().agents[1].reasoningEffort, 'off');
  await assert.rejects(engine.action({ action: 'agentUpdate', agentId: 'deepseek-builder', agent: { status: 'idle' } }), /不支持的字段/);
});

test('busy identity changes and removal are rejected, while rename and hiding preserve the in-flight actor snapshot', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.tasks = [initial.tasks[0]];
  const calls = [];
  const providers = { getCapabilities: available, getModels: fakeCatalog, runAgent: (args) => deferredAgent(calls, args) };
  const engine = workflowEngine({ initialState: initial, providers }); t.after(() => engine.close());
  await engine.action({ action: 'start' }); await until(engine, () => calls.length === 1);
  const original = calls[0].agent;
  await engine.action({ action: 'agentUpdate', agentId: original.id, agent: { name: 'New display name', role: 'New display role', hidden: true } });
  await engine.action({ action: 'agentVisibility', agentId: original.id, hidden: false });
  assert.equal(calls[0].signal.aborted, false); assert.equal(engine.getState().tasks[0].status, 'running');
  assert.equal(calls[0].agent.name, original.name); assert.notEqual(engine.getState().agents[1].name, original.name);
  for (const agent of [{ provider: 'codex' }, { modelId: 'deepseek-a' }, { reasoningEffort: 'high' }]) await assert.rejects(engine.action({ action: 'agentUpdate', agentId: original.id, agent }), /暂时不能更改/);
  await assert.rejects(engine.action({ action: 'model', agentId: original.id, model: 'deepseek-a' }), /暂时不能更改/);
  await assert.rejects(engine.action({ action: 'agentRemove', agentId: original.id }), /不能移除/);
  await assert.rejects(engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'unsafe mixed workspace work' }), /工作目录正在使用/);
  assert.equal(engine.getState().agents[1].provider, 'deepseek'); assert.equal(engine.getState().agents[1].modelId, undefined);
});

test('single-provider teams truly plan dynamic members and follow-ups, including hidden members, with serial workflow writes', async (t) => {
  for (const provider of ['codex', 'deepseek']) {
    const initial = createInitialState(); initial.mode = 'live'; initial.tasks = [];
    initial.agents = [
      { id: `leader-${provider}`, name: 'Dynamic lead', provider, model: `${provider}-a`, modelId: `${provider}-a`, role: 'Verify exact scope', reasoningEffort: 'high', hidden: false, status: 'idle' },
      { id: `worker-${provider}`, name: 'Dynamic builder', provider, model: `${provider}-a`, modelId: `${provider}-a`, role: 'Build exact scope', reasoningEffort: 'low', hidden: false, status: 'idle' },
    ]; initial.leaderId = initial.agents[0].id;
    let extraId; let active = 0; let maximum = 0; const used = [];
    const providers = { getModels: fakeCatalog, getCapabilities: () => ({ codex: { available: provider === 'codex', detail: 'fixture' }, harness: { available: provider === 'deepseek', detail: 'fixture' }, liveReady: false }),
      runAgent: async ({ agent, prompt }) => {
        used.push(agent); active += 1; maximum = Math.max(maximum, active);
        await sleep(4); active -= 1;
        if (prompt.startsWith('你是协作负责人')) {
          assert.ok(prompt.includes(extraId)); assert.ok(prompt.includes('Custom extra role')); assert.ok(prompt.includes(`${provider}-b`));
          return { text: JSON.stringify({ tasks: [newFollowUp({ id: 'dynamic-original', agentId: `worker-${provider}`, criteria: [{ id: 'dynamic-proof', text: 'initial proof' }] })] }) };
        }
        if (prompt.startsWith('你是监工')) return prompt.includes('任务 id：dynamic-original\n')
          ? { text: JSON.stringify({ ...JSON.parse(accepted('dynamic-proof').text), followUpTasks: [newFollowUp({ id: 'dynamic-extra', agentId: extraId })] }) }
          : accepted('c-extra');
        return { text: `Actual mocked output from ${agent.id}` };
      } };
    const engine = workflowEngine({ initialState: initial, providers }); t.after(() => engine.close());
    const added = await engine.action({ action: 'agentAdd', agent: { name: 'Hidden supplemental specialist', provider, modelId: `${provider}-b`, reasoningEffort: 'high', role: 'Custom extra role', hidden: true } });
    extraId = added.agents.find((agent) => agent.name === 'Hidden supplemental specialist').id;
    await engine.action({ action: 'cooperativeGoal', text: `Use the ${provider}-only configured team` });
    const completed = await until(engine, (state) => state.phase === 'completed');
    assert.equal(maximum, 1, provider); assert.equal(completed.tasks.length, 2, provider);
    assert.ok(completed.tasks.some((task) => task.agentId === extraId && task.status === 'accepted'), provider);
    assert.ok(used.some((agent) => agent.id === extraId && agent.modelId === `${provider}-b` && agent.reasoningEffort === 'high'), provider);
    assert.equal(completed.usage.autoProviderCalls[provider], 5, provider); assert.equal(completed.usage.autoProviderCalls[provider === 'codex' ? 'deepseek' : 'codex'], 0, provider);
  }
});

test('provider budgets count expensive workers by provider and normal chat does not consume automatic limits', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.tasks = [];
  const providers = { getCapabilities: available, runAgent: async () => ({ text: 'ordinary mocked chat' }) };
  const engine = workflowEngine({ initialState: initial, providers }); t.after(() => engine.close());
  await engine.action({ action: 'settings', settings: { maxProviderCalls: { codex: 1 }, maxSupervisorCalls: 1 } });
  for (let turn = 0; turn < 3; turn++) {
    await engine.action({ action: 'message', agentId: 'codex-supervisor', text: `ordinary ${turn}` });
    await until(engine, (state) => state.chatSessions['codex-supervisor'].status === 'idle');
  }
  assert.equal(engine.getState().usage.providerCalls.codex, 3); assert.equal(engine.getState().usage.autoProviderCalls.codex, 0); assert.equal(engine.getState().usage.autoSupervisorCalls, 0);
  const second = createInitialState(); second.mode = 'live'; second.leaderId = 'deepseek-builder';
  second.agents[2].provider = 'codex';
  second.tasks = ['one', 'two'].map((suffix, index) => ({ id: `budget-${suffix}`, title: `Budget ${suffix}`, description: 'fixture', agentId: index ? second.agents[2].id : second.agents[0].id, status: 'queued', attempt: 0, dependsOn: [], criteria: [{ id: `budget-proof-${suffix}`, text: 'proof', status: 'pending' }] }));
  const costly = workflowEngine({ initialState: second, providers: { getCapabilities: available, runAgent: async ({ prompt }) => prompt.startsWith('你是监工') ? accepted('budget-proof-one') : { text: 'mocked worker result' } } }); t.after(() => costly.close());
  await costly.action({ action: 'settings', settings: { maxProviderCalls: { codex: 1 } } });
  await costly.action({ action: 'start' });
  const blocked = await until(costly, (state) => state.phase === 'blocked');
  assert.match(blocked.error, /Codex 提供方/); assert.equal(blocked.usage.autoProviderCalls.codex, 1); assert.equal(blocked.usage.autoWorkerCalls, 1);
});

test('workspace locking prevents manual or newly enabled review overlapping a worker and rejects chat/workflow mixing', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.settings.autoReview = false;
  initial.tasks = [initial.tasks[0], initial.tasks[1]];
  const calls = [];
  const providers = { getCapabilities: available, runAgent: (args) => deferredAgent(calls, args) };
  const engine = workflowEngine({ initialState: initial, providers }); t.after(() => engine.close());
  await engine.action({ action: 'start' }); await until(engine, () => calls.length === 1);
  calls[0].resolve({ text: 'first output awaiting review' });
  await until(engine, () => calls.length === 2);
  assert.ok(calls[1].prompt.startsWith('你是本地多模型协作系统'));
  await assert.rejects(engine.action({ action: 'review', taskId: initial.tasks[0].id }), /同目录存在写入任务/);
  await engine.action({ action: 'settings', settings: { autoReview: true } }); await sleep(10);
  assert.equal(calls.length, 2); assert.equal(engine.getState().usage.autoSupervisorCalls, 0);
  await assert.rejects(engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'mixed write' }), /工作目录正在使用/);
  calls[1].resolve({ text: 'second output awaiting review' }); await until(engine, () => calls.length === 3);
  assert.ok(calls[2].prompt.startsWith('你是监工'));
  await engine.action({ action: 'pause' });
  await until(engine, (state) => state.executionSummary.retiringReaders === 0 && state.executionSummary.retiringWriters === 0);
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'ordinary paused chat' }); await until(engine, () => calls.length === 4);
  await assert.rejects(engine.action({ action: 'resume' }), /普通聊天仍在生成/);
  await assert.rejects(engine.action({ action: 'cooperativeGoal', text: 'do not mix another write' }), /普通聊天仍在生成/);
  await assert.rejects(engine.action({ action: 'review', taskId: initial.tasks[0].id }), /普通聊天仍在生成/);
});

test('delegation expectations reject stale leader or session and self-delegation without writing messages or spending calls', async (t) => {
  let inferenceCalls = 0; let capabilityCalls = 0;
  const initial = createInitialState(); initial.mode = 'live';
  const providers = { getCapabilities: () => { capabilityCalls += 1; return available(); }, runAgent: async () => { inferenceCalls += 1; return { text: 'valid delegated output' }; } };
  const engine = new Orchestrator({ initialState: initial, providers }); t.after(() => engine.close());
  const before = engine.getState(); const workerId = 'deepseek-builder';
  for (const payload of [
    { agentId: workerId, expectedLeaderId: 'old-leader', expectedConversationId: before.chatSessions[workerId].id },
    { agentId: workerId, expectedLeaderId: before.leaderId, expectedConversationId: 'old-conversation' },
    { agentId: before.leaderId, expectedLeaderId: before.leaderId, expectedConversationId: before.chatSessions[before.leaderId].id },
  ]) await assert.rejects(engine.action({ action: 'message', text: 'stale delegation must not execute', ...payload }), (error) => error.status === 409);
  assert.equal(inferenceCalls, 0); assert.equal(capabilityCalls, 0);
  assert.deepEqual(engine.getState().messages, before.messages); assert.deepEqual(engine.getState().usage, before.usage);
  await engine.action({ action: 'message', agentId: workerId, text: 'valid delegation', expectedLeaderId: before.leaderId, expectedConversationId: before.chatSessions[workerId].id });
  await until(engine, (state) => state.chatSessions[workerId].status === 'idle');
  assert.equal(inferenceCalls, 1); assert.equal(engine.getState().usage.providerCalls.deepseek, 1);
  await engine.action({ action: 'message', agentId: before.leaderId, text: 'ordinary unguarded leader chat stays compatible' });
  await until(engine, (state) => state.chatSessions[before.leaderId].status === 'idle');
  assert.equal(inferenceCalls, 2);
});

test('delegation rechecks both expectations after async capability lookup before starting a model', async (t) => {
  for (const race of ['leader', 'conversation']) {
    const initial = createInitialState(); initial.mode = 'live';
    let engine; let inferenceCalls = 0;
    const providers = { getCapabilities: async () => {
      await sleep(1);
      if (race === 'leader') engine.state.leaderId = 'deepseek-builder';
      else engine._newChat('deepseek-builder');
      return available();
    }, runAgent: async () => { inferenceCalls += 1; return { text: 'must never happen' }; } };
    engine = new Orchestrator({ initialState: initial, providers }); t.after(() => engine.close());
    const before = engine.getState();
    await assert.rejects(engine.action({ action: 'message', agentId: 'deepseek-builder', text: 'race protected delegation', expectedLeaderId: before.leaderId, expectedConversationId: before.chatSessions['deepseek-builder'].id }), (error) => error.status === 409);
    assert.equal(inferenceCalls, 0, race);
    assert.deepEqual(engine.getState().messages, before.messages, race);
    assert.deepEqual(engine.getState().usage, before.usage, race);
  }
});

function accessFixture(modes) {
  const initial = createInitialState(); initial.mode = 'live'; initial.tasks = [];
  initial.agents = [{ id: 'access-lead', name: 'Access lead', provider: 'codex', model: 'default', role: 'verify', accessMode: 'workspace-write', status: 'idle' },
    ...modes.map((accessMode, index) => ({ id: `access-worker-${index}`, name: `Access worker ${index}`, provider: 'deepseek', model: 'default', role: 'inspect or implement', accessMode, status: 'idle' }))];
  initial.leaderId = 'access-lead'; return initial;
}
function accessTask(index, dependsOn = []) {
  return { id: `access-task-${index}`, title: `Access task ${index}`, description: 'mock scoped task', agentId: `access-worker-${index}`, status: 'queued', attempt: 0, dependsOn, criteria: [{ id: `access-proof-${index}`, text: 'mock evidence', status: 'pending' }] };
}

test('access mode defaults preserve write permission, validated edits archive identity, and reader limits stay bounded', async (t) => {
  const engine = new Orchestrator(); t.after(() => engine.close());
  assert.ok(engine.getState().agents.every((agent) => agent.accessMode === 'workspace-write'));
  assert.equal(engine.getState().settings.maxParallelReaders, 3);
  const old = engine.getState().chatSessions['deepseek-builder'].id;
  await engine.action({ action: 'agentUpdate', agentId: 'deepseek-builder', agent: { accessMode: 'read-only' } });
  assert.notEqual(engine.getState().chatSessions['deepseek-builder'].id, old);
  assert.equal(engine.getState().chatArchives[old].agent.accessMode, 'workspace-write');
  for (const bad of ['full-access', null, '']) await assert.rejects(engine.action({ action: 'agentUpdate', agentId: 'deepseek-builder', agent: { accessMode: bad } }), /accessMode 必须/);
  for (const bad of [0, 5, 1.5]) await assert.rejects(engine.action({ action: 'settings', settings: { maxParallelReaders: bad } }), /1–4/);
  await engine.action({ action: 'settings', settings: { maxParallelReaders: 4 } });
  assert.equal(engine.getState().settings.maxParallelReaders, 4);
});

test('held readonly workers actually overlap within N, while planning and one-at-a-time reviews are forced readonly', async (t) => {
  const initial = accessFixture(['read-only', 'read-only', 'read-only']); initial.settings.maxParallelReaders = 2; initial.settings.autoReview = false;
  const calls = []; let maximumReaders = 0; let writerSeen = false;
  const engine = workflowEngine({ initialState: initial, providers: { getCapabilities: available, runAgent: (args) => deferredAgent(calls, args) } }); t.after(() => engine.close());
  engine.subscribe((state) => { maximumReaders = Math.max(maximumReaders, state.executionSummary.readers); writerSeen ||= state.executionSummary.writers > 0; });
  await engine.action({ action: 'start' }); await until(engine, () => calls.length === 1);
  assert.ok(calls[0].prompt.startsWith('你是协作负责人')); assert.equal(calls[0].agent.accessMode, 'read-only');
  assert.equal(engine.getState().agents[0].accessMode, 'workspace-write');
  calls[0].resolve({ text: JSON.stringify({ tasks: [0, 1, 2].map((index) => accessTask(index)) }) });
  await until(engine, () => calls.length === 3);
  assert.equal(engine.getState().executionSummary.readers, 2);
  assert.equal(engine.getState().tasks.filter((task) => task.status === 'running').length, 2);
  assert.ok(calls.slice(1).every((call) => call.agent.accessMode === 'read-only' && !call.signal.aborted));
  await assert.rejects(engine.action({ action: 'settings', settings: { maxParallelReaders: 1 } }), /当前只读任务/);
  await assert.rejects(engine.action({ action: 'agentUpdate', agentId: 'access-worker-0', agent: { accessMode: 'workspace-write' } }), /暂时不能更改/);
  await engine.action({ action: 'agentVisibility', agentId: 'access-worker-1', hidden: true });
  assert.equal(calls[2].signal.aborted, false);
  calls[1].resolve({ text: 'first readonly evidence' }); await until(engine, () => calls.length === 4);
  assert.equal(engine.getState().executionSummary.readers, 2);
  await engine.action({ action: 'settings', settings: { autoReview: true } }); await sleep(5); assert.equal(calls.length, 4);
  calls[2].resolve({ text: 'second readonly evidence' }); await until(engine, () => calls.length === 5);
  assert.ok(calls[4].prompt.startsWith('你是监工')); assert.equal(calls[4].agent.accessMode, 'read-only');
  assert.equal(engine.getState().executionSummary.readers, 2);
  await engine.action({ action: 'review', taskId: 'access-task-0' }); assert.equal(calls.length, 5);
  calls[3].resolve({ text: 'third readonly evidence' });
  for (let index = 0; index < 3; index++) {
    await until(engine, () => calls.length >= 5 + index);
    const review = calls[4 + index];
    assert.equal(review.agent.accessMode, 'read-only'); review.resolve(accepted(`access-proof-${index}`));
  }
  const completed = await until(engine, (state) => state.phase === 'completed');
  assert.equal(maximumReaders, 2); assert.equal(writerSeen, false); assert.ok(completed.tasks.every((task) => task.status === 'accepted'));
});

test('a ready writer drains existing readers and takes precedence over new readers and pending reviews', async (t) => {
  const initial = accessFixture(['read-only', 'read-only', 'read-only', 'workspace-write']); initial.settings.maxParallelReaders = 2;
  initial.tasks = [accessTask(0), accessTask(1), accessTask(2), accessTask(3, ['access-task-0'])];
  const calls = []; const states = [];
  const engine = workflowEngine({ initialState: initial, providers: { getCapabilities: available, runAgent: (args) => deferredAgent(calls, args) } }); t.after(() => engine.close());
  engine.subscribe((state) => states.push(state.executionSummary));
  await engine.action({ action: 'start' }); await until(engine, () => calls.length === 2);
  assert.equal(engine.getState().executionSummary.readers, 2);
  calls[0].resolve({ text: 'reader zero done' }); await until(engine, () => calls.length === 3);
  assert.ok(calls[2].prompt.startsWith('你是监工')); assert.equal(calls[2].agent.accessMode, 'read-only');
  calls[2].resolve(accepted('access-proof-0')); await until(engine, (state) => state.tasks[0].status === 'accepted');
  await sleep(5); assert.equal(calls.length, 3);
  assert.equal(engine.getState().tasks[2].status, 'queued'); assert.equal(engine.getState().tasks[3].status, 'queued');
  calls[1].resolve({ text: 'reader one done' }); await until(engine, () => calls.length === 4);
  assert.equal(calls[3].agent.id, 'access-worker-3'); assert.equal(calls[3].agent.accessMode, 'workspace-write');
  assert.equal(engine.getState().executionSummary.writers, 1); assert.equal(engine.getState().executionSummary.readers, 0);
  await engine.action({ action: 'settings', settings: { maxParallelReaders: 4 } }); await sleep(5); assert.equal(calls.length, 4);
  assert.ok(states.every((summary) => summary.writers <= 1 && (!summary.writers || summary.readers === 0)));
});

test('independent readonly chats may overlap but a writer excludes readers and retains its lock until confirmed reaped', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.agents[0].accessMode = 'read-only'; initial.agents[1].accessMode = 'read-only';
  const calls = [];
  const providers = { getCapabilities: available, runAgent: (args) => new Promise((resolve, reject) => {
    const call = { ...args, resolve, confirmStopped: () => reject(Object.assign(new Error('mock process reaped'), { name: 'AbortError', cleanupConfirmed: true })) };
    args.signal.addEventListener('abort', () => { call.stopRequested = true; }, { once: true }); calls.push(call);
  }) };
  const engine = new Orchestrator({ initialState: initial, providers });
  t.after(async () => { for (const call of calls) call.confirmStopped(); await engine.close(); });
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'readonly left' });
  await engine.action({ action: 'message', agentId: 'deepseek-builder', text: 'readonly right' });
  await until(engine, () => calls.length === 2); assert.equal(engine.getState().executionSummary.readers, 2);
  await assert.rejects(engine.action({ action: 'message', agentId: 'deepseek-tester', text: 'unsafe writer overlap' }), /独占工作空间/);
  await engine.action({ action: 'cancelChat', agentId: 'codex-supervisor' });
  await engine.action({ action: 'cancelChat', agentId: 'deepseek-builder' });
  assert.equal(engine.getState().executionSummary.retiringReaders, 2);
  assert.equal(engine.getState().agents[0].status, 'stopping');
  await assert.rejects(engine.action({ action: 'message', agentId: 'deepseek-tester', text: 'still unsafe while stopping' }), /独占工作空间/);
  calls[0].confirmStopped(); calls[1].confirmStopped();
  await until(engine, (state) => state.executionSummary.retiringReaders === 0);
  await engine.action({ action: 'message', agentId: 'deepseek-tester', text: 'exclusive writer now allowed' });
  await until(engine, () => calls.length === 3);
  assert.equal(engine.getState().executionSummary.writers, 1); assert.equal(engine.getState().executionSummary.readers, 0);
  await assert.rejects(engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'reader during writer' }), /有写入任务/);
  await engine.action({ action: 'newChat', agentId: 'deepseek-tester' });
  assert.equal(engine.getState().executionSummary.retiringWriters, 1);
  await assert.rejects(engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'reader before writer stop confirmed' }), /有写入任务/);
  calls[2].confirmStopped(); await until(engine, (state) => state.executionSummary.retiringWriters === 0);
});

test('unconfirmed AbortError cleanup persists a workspace barrier across restart and cannot be bypassed by ordinary actions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-cleanup-test-')); const persistencePath = join(directory, 'state.json');
  const initial = createInitialState(); initial.mode = 'live';
  const calls = []; const providers = { getCapabilities: available, runAgent: (args) => deferredAgent(calls, args) };
  const engine = new Orchestrator({ initialState: initial, providers, persistencePath }); let restored;
  t.after(async () => { await engine.close(); await restored?.close(); rmSync(directory, { recursive: true, force: true }); });
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'mock writer requiring stop confirmation' }); await until(engine, () => calls.length === 1);
  await engine.action({ action: 'cancelChat', agentId: 'codex-supervisor' });
  calls[0].reject(Object.assign(new Error('process cleanup could not be confirmed'), { name: 'AbortError', cleanupConfirmed: false }));
  await until(engine, (state) => state.phase === 'blocked' && state.pendingCleanup.length === 1);
  assert.equal(engine.getState().executionSummary.writers, 1); assert.equal(engine.getState().executionSummary.retiringWriters, 1);
  assert.equal(await engine.close(), false);
  restored = new Orchestrator({ persistencePath, providers });
  assert.equal(restored.getState().phase, 'blocked'); assert.equal(restored.getState().agents[0].status, 'stopping');
  assert.equal(restored.getState().executionSummary.retiringWriters, 1);
  for (const action of [{ action: 'reset' }, { action: 'mode', mode: 'demo' }, { action: 'agentVisibility', agentId: 'codex-supervisor', hidden: true }, { action: 'collaboration', mode: 'cooperative' }]) {
    await restored.action(action); assert.equal(restored.getState().pendingCleanup.length, 1); assert.equal(restored.getState().phase, 'blocked');
  }
  for (const action of [{ action: 'message', agentId: 'deepseek-builder', text: 'must not bypass barrier' }, { action: 'resume' }, { action: 'cooperativeGoal', text: 'must not bypass barrier' }]) await assert.rejects(restored.action(action), (error) => error.status === 503);
  assert.equal(calls.length, 1);
});

const completeBrief = (objective = 'CONFIRMED_OBJECTIVE') => ({ objective, deliverables: 'DELIVERY_MARKER', acceptance: 'ACCEPTANCE_MARKER', constraints: 'CONSTRAINT_MARKER', questions: '' });
function confirmBrief(engine, revision) { const state = engine.getState(); return { action: 'confirmGoalBrief', revision, expectedMode: state.mode, expectedLeaderId: state.leaderId }; }

test('goal drafts cost no calls and do not change an active goal, task, signal, phase, budget, or confirmed snapshot', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.goal = 'RUNNING_OLD_TARGET'; initial.tasks = [initial.tasks[0]];
  initial.goalDraft = { ...completeBrief('OLD_OBJECTIVE'), revision: 1, updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString() };
  initial.activeBrief = structuredClone(initial.goalDraft);
  const calls = [];
  const engine = workflowEngine({ initialState: initial, providers: { getCapabilities: available, runAgent: (args) => deferredAgent(calls, args) } }); t.after(() => engine.close());
  await engine.action({ action: 'start' }); await until(engine, () => calls.length === 1);
  const before = engine.getState();
  const next = { objective: 'NEXT_DRAFT', deliverables: '', acceptance: '', constraints: '  preserve original whitespace\n', questions: 'Pending design decision' };
  await engine.action({ action: 'saveGoalBrief', expectedRevision: 1, brief: next });
  const state = engine.getState();
  assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, false);
  assert.equal(state.phase, before.phase); assert.equal(state.goal, before.goal);
  assert.deepEqual(state.tasks, before.tasks); assert.deepEqual(state.usage, before.usage); assert.deepEqual(state.activeBrief, before.activeBrief);
  assert.equal(state.goalDraft.revision, 2); assert.equal(state.goalDraft.confirmedAt, undefined);
  for (const key of Object.keys(next)) assert.equal(state.goalDraft[key], next[key]);
});

test('brief DTO, optimistic version, required fields and unresolved questions are rejected without model calls', async (t) => {
  const engine = workflowEngine({ providers: { getCapabilities: () => assert.fail('invalid confirmation must not probe models'), runAgent: () => assert.fail('draft must not call models') } }); t.after(() => engine.close());
  await assert.rejects(engine.action({ action: 'saveGoalBrief', brief: completeBrief() }), /expectedRevision/);
  await assert.rejects(engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: { ...completeBrief(), confirmedAt: 'forged' } }), /五个规定/);
  await assert.rejects(engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: { ...completeBrief(), objective: 'x'.repeat(3001) } }), /3000/);
  await engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: { objective: 'draft', deliverables: '', acceptance: '', constraints: '', questions: '' } });
  await assert.rejects(engine.action(confirmBrief(engine, 1)), /目标、交付物和验收标准/);
  await assert.rejects(engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: completeBrief() }), (error) => error.status === 409);
  await engine.action({ action: 'saveGoalBrief', expectedRevision: 1, brief: { ...completeBrief(), questions: 'Unresolved question' } });
  await assert.rejects(engine.action(confirmBrief(engine, 2)), /待决定问题/);
  await assert.rejects(engine.action(confirmBrief(engine, 1)), (error) => error.status === 409);
  assert.equal(engine.getState().goalDraft.confirmedAt, undefined); assert.equal(engine.getState().activeBrief, undefined);
  assert.equal(engine.getState().usage.supervisorCalls, 0);
});

test('confirmation starts exactly once, renders every field into prompts, and later draft edits cannot mutate the active brief', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; initial.tasks = [];
  const calls = []; let capabilityCalls = 0;
  const engine = workflowEngine({ initialState: initial, providers: { getCapabilities: () => { capabilityCalls += 1; return available(); }, runAgent: (args) => deferredAgent(calls, args) } }); t.after(() => engine.close());
  const fields = completeBrief();
  await engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: fields });
  assert.equal(capabilityCalls, 0); assert.equal(calls.length, 0);
  const payload = confirmBrief(engine, 1);
  await Promise.all([engine.action(payload), engine.action(payload), engine.action(payload)]);
  await until(engine, () => calls.length === 1);
  assert.equal(capabilityCalls, 1); assert.equal(engine.getState().activeBrief.revision, 1); assert.ok(engine.getState().activeBrief.confirmedAt);
  assert.equal(engine.getState().goalDraft.confirmedAt, engine.getState().activeBrief.confirmedAt);
  for (const value of Object.values(fields).filter(Boolean)) assert.ok(calls[0].prompt.includes(value));
  const active = engine.getState().activeBrief; const rendered = engine.getState().goal;
  await engine.action({ action: 'saveGoalBrief', expectedRevision: 1, brief: completeBrief('FUTURE_OBJECTIVE') });
  assert.deepEqual(engine.getState().activeBrief, active); assert.equal(engine.getState().goal, rendered);
  await assert.rejects(engine.action(confirmBrief(engine, 2)), /仍有执行|先暂停/);
  calls[0].resolve({ text: JSON.stringify({ tasks: [newFollowUp({ id: 'brief-delivery' })] }) });
  await until(engine, () => calls.length === 2);
  for (const value of Object.values(fields).filter(Boolean)) assert.ok(calls[1].prompt.includes(value));
  assert.ok(!calls[1].prompt.includes('FUTURE_OBJECTIVE'));
  calls[1].resolve({ text: 'mock delivered artifact' }); await until(engine, () => calls.length === 3);
  for (const value of Object.values(fields).filter(Boolean)) assert.ok(calls[2].prompt.includes(value));
  calls[2].resolve(accepted('c-extra')); await until(engine, (state) => state.phase === 'completed');
  await engine.action({ action: 'goal', text: 'LEGACY_NEW_TARGET' });
  assert.equal(engine.getState().activeBrief, undefined); assert.equal(engine.getState().goal, 'LEGACY_NEW_TARGET');
});

test('confirmation protects preview mode and leader before and after async capability lookup', async (t) => {
  const fields = completeBrief();
  const base = workflowEngine(); t.after(() => base.close());
  await base.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: fields }); const demoPreview = confirmBrief(base, 1);
  await base.action({ action: 'mode', mode: 'live' });
  await assert.rejects(base.action(demoPreview), (error) => error.status === 409);
  assert.equal(base.getState().activeBrief, undefined); assert.equal(base.getState().goalDraft.confirmedAt, undefined);
  for (const race of ['mode', 'leader']) {
    const initial = createInitialState(); initial.mode = 'live'; let engine; let calls = 0;
    const providers = { getCapabilities: async () => { await sleep(1); if (race === 'mode') engine.state.mode = 'demo'; else engine.state.leaderId = 'deepseek-builder'; return available(); }, runAgent: () => { calls += 1; assert.fail('changed preview must not start'); } };
    engine = workflowEngine({ initialState: initial, providers }); t.after(() => engine.close());
    await engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: fields });
    await assert.rejects(engine.action(confirmBrief(engine, 1)), (error) => error.status === 409);
    assert.equal(calls, 0); assert.equal(engine.getState().activeBrief, undefined); assert.equal(engine.getState().goalDraft.confirmedAt, undefined);
  }
});

test('ordinary chat and cleanup barriers guard confirmation while preserving an unconfirmed saved draft', async (t) => {
  const initial = createInitialState(); initial.mode = 'live'; const calls = [];
  const engine = workflowEngine({ initialState: initial, providers: { getCapabilities: available, runAgent: (args) => deferredAgent(calls, args) } }); t.after(() => engine.close());
  await engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: completeBrief() });
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'held independent chat' }); await until(engine, () => calls.length === 1);
  await assert.rejects(engine.action(confirmBrief(engine, 1)), (error) => error.status === 409);
  assert.equal(calls.length, 1); assert.equal(engine.getState().goalDraft.confirmedAt, undefined);
  await engine.action({ action: 'cancelChat', agentId: 'codex-supervisor' });
  await until(engine, (state) => state.executionSummary.retiringReaders === 0 && state.executionSummary.retiringWriters === 0);
  engine.state.pendingCleanup.push({ runId: 'unconfirmed-fixture', agentId: 'codex-supervisor', kind: 'chat', accessMode: 'workspace-write', reason: 'test' });
  await assert.rejects(engine.action(confirmBrief(engine, 1)), (error) => error.status === 503);
  assert.equal(engine.getState().activeBrief, undefined); assert.equal(engine.getState().goalDraft.confirmedAt, undefined);
});

test('briefs restore durably and completed same-version confirmation is idempotent until raw goals require a new draft version', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-brief-test-')); const persistencePath = join(directory, 'state.json');
  const engine = workflowEngine({ persistencePath, demoDelayMs: 1 }); let restored;
  t.after(async () => { await engine.close(); await restored?.close(); rmSync(directory, { recursive: true, force: true }); });
  await engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: completeBrief() });
  assert.equal(JSON.parse(readFileSync(persistencePath, 'utf8')).goalDraft.revision, 1);
  await engine.action(confirmBrief(engine, 1)); await until(engine, (state) => state.phase === 'completed');
  const before = engine.getState(); await engine.action(confirmBrief(engine, 1)); assert.deepEqual(engine.getState().usage, before.usage);
  await engine.close(); restored = new Orchestrator({ persistencePath, demoDelayMs: 1 });
  assert.equal(restored.getState().activeBrief.objective, 'CONFIRMED_OBJECTIVE'); assert.equal(restored.getState().goalDraft.revision, 1);
  await restored.action(confirmBrief(restored, 1)); assert.equal(restored.getState().phase, 'completed');
  await restored.action({ action: 'goal', text: 'raw changed objective' });
  await assert.rejects(restored.action(confirmBrief(restored, 1)), (error) => error.status === 409);
  assert.equal(restored.getState().activeBrief, undefined);
});

test('draft and confirmation write failures never falsely acknowledge saved confirmation or queue inference', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-brief-test-')); const persistencePath = join(directory, 'state.json');
  const initial = createInitialState(); initial.mode = 'live'; initial.collaborationMode = 'cooperative'; initial.tasks = [];
  writeFileSync(persistencePath, JSON.stringify(initial)); let locked = false; const calls = [];
  const engine = new Orchestrator({ persistencePath, providers: { getCapabilities: available, runAgent: (args) => deferredAgent(calls, args) }, persistenceRetryDelays: [1], fileOps: { rename: async (source, target) => { if (locked) throw Object.assign(new Error('test lock'), { code: 'EPERM' }); await filesystem.rename(source, target); } } });
  t.after(async () => { locked = false; await engine.close(); rmSync(directory, { recursive: true, force: true }); });
  await engine.flushPersistence(); locked = true;
  await assert.rejects(engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: completeBrief() }), (error) => error.status === 503);
  assert.equal(engine.getState().goalDraft.revision, 1); assert.equal(JSON.parse(readFileSync(persistencePath, 'utf8')).goalDraft, undefined); assert.equal(calls.length, 0);
  locked = false; await engine.action({ action: 'saveGoalBrief', expectedRevision: 1, brief: completeBrief() });
  assert.equal(JSON.parse(readFileSync(persistencePath, 'utf8')).goalDraft.revision, 2);
  const oldGoal = engine.getState().goal; locked = true;
  await assert.rejects(engine.action(confirmBrief(engine, 2)), (error) => error.status === 503);
  assert.equal(calls.length, 0); assert.equal(engine.getState().activeBrief, undefined); assert.equal(engine.getState().goalDraft.confirmedAt, undefined); assert.equal(engine.getState().goal, oldGoal);
  assert.equal(JSON.parse(readFileSync(persistencePath, 'utf8')).activeBrief, undefined);
  locked = false; await engine.action(confirmBrief(engine, 2)); await until(engine, () => calls.length === 1);
  const persisted = JSON.parse(readFileSync(persistencePath, 'utf8'));
  assert.equal(persisted.activeBrief.revision, 2); assert.ok(persisted.goalDraft.confirmedAt);
});

test('closing during prepared confirmation persistence cannot publish a success or queue a model', async (t) => {
  const files = new Map(); const persistencePath = join(tmpdir(), `relay-brief-memory-${Date.now()}.json`);
  let releaseWrite; const blockedWrite = new Promise((resolve) => { releaseWrite = resolve; }); let reachedConfirmation = false;
  const fileOps = { mkdir: async () => {}, writeFile: async (path, text) => files.set(path, text), unlink: async (path) => files.delete(path), rename: async (source, target) => {
    if (JSON.parse(files.get(source)).activeBrief && !reachedConfirmation) { reachedConfirmation = true; await blockedWrite; }
    files.set(target, files.get(source)); files.delete(source);
  } };
  let calls = 0;
  const initial = createInitialState(); initial.mode = 'live'; initial.tasks = [];
  const engine = workflowEngine({ initialState: initial, persistencePath, fileOps, providers: { getCapabilities: available, runAgent: () => { calls += 1; assert.fail('closing must not infer'); } } });
  t.after(async () => { releaseWrite(); await engine.close(); });
  await engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: completeBrief() });
  const attempted = engine.action(confirmBrief(engine, 1));
  const rejected = assert.rejects(attempted, (error) => error.status === 503);
  await until(engine, () => reachedConfirmation);
  const closing = engine.close(); releaseWrite();
  await rejected; await closing;
  assert.equal(calls, 0); assert.equal(engine.getState().activeBrief, undefined); assert.equal(engine.getState().goalDraft.confirmedAt, undefined);
  const persisted = JSON.parse(files.get(persistencePath));
  assert.equal(persisted.activeBrief, undefined); assert.equal(persisted.goalDraft.confirmedAt, undefined); assert.equal(persisted.goalDraft.revision, 1);
});

test('same-leader provider, model or reasoning changes cannot consume confirmation inference before or during preflight', async (t) => {
  for (const [key, value] of [['provider', 'deepseek'], ['modelId', 'new-costly-model'], ['reasoningEffort', 'high']]) {
    for (const when of ['before', 'during']) {
      const initial = createInitialState(); initial.mode = 'live'; let engine; let calls = 0;
      const providers = { getCapabilities: async () => { if (when === 'during') { await sleep(1); engine.state.agents[0][key] = value; } return available(); }, runAgent: () => { calls += 1; assert.fail('changed leader config must not infer'); } };
      engine = workflowEngine({ initialState: initial, providers }); t.after(() => engine.close());
      await engine.action({ action: 'saveGoalBrief', expectedRevision: 0, brief: completeBrief() });
      const leader = engine.getState().agents[0];
      const payload = { ...confirmBrief(engine, 1), expectedLeaderConfig: { provider: leader.provider, modelId: leader.modelId || 'default', reasoningEffort: leader.reasoningEffort || 'auto' } };
      if (when === 'before') engine.state.agents[0][key] = value;
      await assert.rejects(engine.action(payload), (error) => error.status === 409);
      assert.equal(calls, 0); assert.equal(engine.getState().activeBrief, undefined); assert.equal(engine.getState().goalDraft.confirmedAt, undefined);
    }
  }
});
