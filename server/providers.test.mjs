import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviders, JsonLines, processLaunch } from './providers.mjs';

function fakeProcess(onInput) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.received = [];
  let input = '';
  child.send = frame => child.stdout.write(Buffer.from(JSON.stringify(frame) + '\n'));
  child.stdin = new Writable({ write(chunk, _, callback) {
    input += chunk.toString();
    let newline;
    while ((newline = input.indexOf('\n')) >= 0) {
      const frame = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      child.received.push(frame);
      queueMicrotask(() => onInput?.(frame, child));
    }
    callback();
  } });
  child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
  return child;
}

function codexFixture({ auth = 'chatgpt', status = 'completed', approval = false, hang = false, missingResume = false, env = {}, fetch, models, childSetup, onTurnStart, cleanupTimeoutMs } = {}) {
  const calls = [];
  const children = [];
  const turnCounts = new Map();
  let nextThread = 0;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = fakeProcess((request, cp) => {
      if (request.method === 'initialize') cp.send({ id: request.id, result: { userAgent: 'fixture' } });
      else if (request.method === 'account/read') cp.send({ id: request.id, result: { account: { type: auth, email: 'private@example.test' } } });
      else if (request.method === 'model/list') cp.send({ id: request.id, result: { data: models || [{ id: 'catalog-key', model: 'fixture-model', displayName: 'Fixture Model', isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Lower latency' }, { reasoningEffort: 'high', description: 'More thinking' }], defaultReasoningEffort: 'high' }], nextCursor: null } });
      else if (request.method === 'thread/start') {
        cp.threadId = ++nextThread === 1 ? 'fixture-thread' : `fixture-thread-${nextThread}`;
        cp.send({ id: request.id, result: { thread: { id: cp.threadId } } });
      }
      else if (request.method === 'thread/resume') {
        if (missingResume) cp.send({ id: request.id, error: { message: 'Stored thread not found' } });
        else { cp.threadId = request.params.threadId; cp.send({ id: request.id, result: { thread: { id: cp.threadId } } }); }
      }
      else if (request.method === 'turn/start') {
        onTurnStart?.(request, cp);
        cp.send({ id: request.id, result: { turn: { id: 'fixture-turn' } } });
        if (hang) return;
        if (approval) {
          cp.send({ id: 99, method: 'item/commandExecution/requestApproval', params: { command: 'unsafe' } });
          return;
        }
        cp.send({ method: 'item/agentMessage/delta', params: { threadId: cp.threadId, itemId: 'comment', delta: '检查材料…' } });
        cp.send({ method: 'item/completed', params: { item: { id: 'comment', type: 'agentMessage', text: '检查材料…', phase: 'commentary' } } });
        cp.send({ method: 'item/started', params: { item: { id: 'cmd', type: 'commandExecution', command: 'node --test' } } });
        cp.send({ method: 'item/commandExecution/outputDelta', params: { delta: 'Tests passed\n' } });
        cp.send({ method: 'item/agentMessage/delta', params: { itemId: 'final', delta: '{"verdict":"accepted"}' } });
        cp.send({ method: 'item/completed', params: { item: { id: 'final', type: 'agentMessage', text: '{"verdict":"accepted"}', phase: 'final_answer' } } });
        const turnCount = (turnCounts.get(cp.threadId) || 0) + 1;
        turnCounts.set(cp.threadId, turnCount);
        cp.send({ method: 'thread/tokenUsage/updated', params: { threadId: cp.threadId, tokenUsage: { total: { inputTokens: 123 * turnCount, outputTokens: 45 * turnCount } } } });
        cp.send({ method: 'turn/completed', params: { turn: { id: 'fixture-turn', status, error: status === 'failed' ? { message: 'Fixture failure' } : undefined } } });
      }
    });
    childSetup?.(child);
    if (args.includes('--probe')) queueMicrotask(() => child.send({ type: 'capabilities', sdk: false, runtime: false, detail: 'Fixture SDK absent' }));
    children.push(child);
    return child;
  };
  const providers = createProviders({ spawn, fetch, cleanupTimeoutMs, probeHarness: async () => ({ sdkInstalled: true, reasoningEffortSupported: true, reasoningEfforts: ['off', 'low', 'high', 'max'], sdkVersion: '0.1.5rc1' }), platform: 'linux', env: { OPENAI_API_KEY: 'fake-paid-key', ...env }, codexBin: '/fake/codex', pythonBin: '/fake/python', existsSync: () => true, timeoutMs: 1000 });
  return { providers, calls, children };
}

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('JSON lines preserve fragmented Chinese UTF-8 and reject malformed protocol frames', () => {
  const values = [];
  const errors = [];
  const parser = new JsonLines(value => values.push(value), error => errors.push(error));
  const bytes = Buffer.from('{"text":"你好"}\n');
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  assert.deepEqual(values, [{ text: '你好' }]);
  parser.push('{invalid}\n');
  assert.equal(errors.length, 1);
  parser.push('{"ignored":true}\n');
  assert.equal(values.length, 1);
});

test('JSON line limit fails closed for oversized unframed data', () => {
  let failure;
  new JsonLines(() => assert.fail(), error => { failure = error; }, 8).push('xxxxxxxxx');
  assert.match(failure.message, /大小限制/);
});

test('Codex uses managed login and workspace permissions, separates tool stream from final JSON', async () => {
  const fixture = codexFixture();
  const chunks = [];
  const result = await fixture.providers.runAgent({ agent: { provider: 'codex', model: 'Codex 当前模型' }, prompt: 'a prompt with ` & $() "\n你好', workspace: process.cwd(), onDelta: (delta, meta) => chunks.push({ delta, meta }) });
  assert.equal(result.text, '{"verdict":"accepted"}');
  assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 45 });
  assert.ok(chunks.some(chunk => chunk.meta.type === 'tool' && chunk.delta.includes('node --test')));
  assert.ok(chunks.some(chunk => chunk.meta.type === 'text' && chunk.delta.includes('accepted')));
  const frames = fixture.children[0].received;
  assert.equal(frames[0].method, 'initialize');
  assert.equal(frames[1].method, 'initialized');
  const thread = frames.find(frame => frame.method === 'thread/start');
  assert.equal(thread.params.sandbox, 'workspace-write');
  assert.equal(thread.params.modelProvider, 'openai');
  assert.equal('model' in thread.params, false);
  assert.equal(frames.find(frame => frame.method === 'turn/start').params.sandboxPolicy.networkAccess, false);
  assert.deepEqual(fixture.calls[0].args, ['app-server']);
  assert.equal(fixture.calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(fixture.children[0].killed, true);
});

test('API key Codex account is rejected before a paid model turn', async () => {
  const fixture = codexFixture({ auth: 'apiKey' });
  await assert.rejects(fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'test' }), /ChatGPT 登录/);
  assert.equal(fixture.children[0].received.some(frame => frame.method === 'turn/start'), false);
  assert.equal(fixture.children[0].killed, true);
});

test('read-only Codex uses the locally generated schema tags on start, resume and every turn', async () => {
  const fixture = codexFixture();
  const first = await fixture.providers.runAgent({ agent: { provider: 'codex', accessMode: 'read-only' }, prompt: 'inspect' });
  await fixture.providers.runAgent({ agent: { provider: 'codex', accessMode: 'read-only' }, prompt: 'continue inspecting', session: first.session });
  assert.equal(fixture.children[0].received.find(frame => frame.method === 'thread/start').params.sandbox, 'read-only');
  assert.equal(fixture.children[1].received.find(frame => frame.method === 'thread/resume').params.sandbox, 'read-only');
  for (const child of fixture.children) assert.deepEqual(child.received.find(frame => frame.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
});

test('provider run takes an independent access/model/effort snapshot before asynchronous handshake', async () => {
  const fixture = codexFixture();
  const agent = { provider: 'codex', accessMode: 'read-only', modelId: 'fixture-model', reasoningEffort: 'low' };
  const pending = fixture.providers.runAgent({ agent, prompt: 'snapshot' });
  agent.accessMode = 'workspace-write'; agent.modelId = 'changed-model'; agent.reasoningEffort = 'high';
  await pending;
  const start = fixture.children[0].received.find(frame => frame.method === 'thread/start').params;
  const turn = fixture.children[0].received.find(frame => frame.method === 'turn/start').params;
  assert.equal(start.sandbox, 'read-only'); assert.equal(start.model, 'fixture-model');
  assert.equal(turn.sandboxPolicy.type, 'readOnly'); assert.equal(turn.effort, 'low');
});

test('explicit writable and omitted access mode preserve the existing workspace-write wire policy', async () => {
  const fixture = codexFixture();
  for (const accessMode of [undefined, 'workspace-write']) await fixture.providers.runAgent({ agent: { provider: 'codex', accessMode }, prompt: 'write' });
  for (const child of fixture.children) {
    assert.equal(child.received.find(frame => frame.method === 'thread/start').params.sandbox, 'workspace-write');
    const policy = child.received.find(frame => frame.method === 'turn/start').params.sandboxPolicy;
    assert.equal(policy.type, 'workspaceWrite'); assert.deepEqual(policy.writableRoots, [process.cwd()]); assert.equal(policy.networkAccess, false);
  }
});

test('invalid access modes reject before starting a provider or making a network request', async () => {
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'synthetic-key' }, existsSync: () => true,
    spawn: () => assert.fail('invalid access mode must not start process'), fetch: () => assert.fail('invalid access mode must not call API'),
  });
  for (const provider of ['codex', 'deepseek']) for (const accessMode of ['danger-full-access', 'readonly', null]) {
    await assert.rejects(providers.runAgent({ agent: { provider, accessMode }, prompt: 'test' }), /accessMode/);
  }
});

test('Codex chat resumes the same native thread while a new chat receives a separate thread', async () => {
  const fixture = codexFixture();
  let checkpoint;
  const first = await fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'remember ABC', onSession(ref) {
    checkpoint = ref;
    assert.equal(fixture.children[0].received.some(frame => frame.method === 'turn/start'), false);
  } });
  assert.deepEqual(checkpoint, { provider: 'codex', id: 'fixture-thread' });
  assert.deepEqual(first.session, checkpoint);
  const second = await fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'what was ABC?', session: first.session });
  assert.deepEqual(second.session, first.session);
  assert.equal(fixture.children[1].received.some(frame => frame.method === 'thread/start'), false);
  assert.equal(fixture.children[1].received.find(frame => frame.method === 'thread/resume').params.threadId, first.session.id);
  assert.equal(fixture.children[1].received.find(frame => frame.method === 'turn/start').params.threadId, first.session.id);
  // Cumulative thread totals must not be counted twice after resume.
  assert.deepEqual(second.usage, { inputTokens: 123, outputTokens: 45 });
  const separate = await fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'new chat' });
  assert.notEqual(separate.session.id, first.session.id);
  assert.deepEqual(separate.usage, { inputTokens: 123, outputTokens: 45 });
});

test('missing native Codex history fails without silently creating a replacement chat', async () => {
  const fixture = codexFixture({ missingResume: true });
  const ref = { provider: 'codex', id: 'missing-thread' };
  await assert.rejects(fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'continue', session: ref }), error => {
    assert.match(error.message, /not found/);
    assert.deepEqual(error.session, ref);
    return true;
  });
  assert.equal(fixture.children[0].received.some(frame => frame.method === 'thread/start'), false);
  assert.equal(fixture.children[0].received.some(frame => frame.method === 'turn/start'), false);
});

test('failed first Codex turn preserves its newly allocated native reference', async () => {
  const fixture = codexFixture({ status: 'failed' });
  let checkpoint;
  await assert.rejects(fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'test', onSession: ref => { checkpoint = ref; } }), error => {
    assert.deepEqual(error.session, { provider: 'codex', id: 'fixture-thread' });
    assert.deepEqual(error.session, checkpoint);
    return true;
  });
});

test('selected Codex modelId takes precedence over environment default on resumed thread', async () => {
  const fixture = codexFixture({ env: { RELAY_CODEX_MODEL: 'environment-model' } });
  await fixture.providers.runAgent({ agent: { provider: 'codex', modelId: 'selected-model' }, session: { provider: 'codex', id: 'existing-thread' }, prompt: 'test' });
  assert.equal(fixture.children[0].received.find(frame => frame.method === 'thread/resume').params.model, 'selected-model');
});

test('getModels reads only the CLI catalog and starts no model turn', async () => {
  const fixture = codexFixture();
  const catalog = await fixture.providers.getModels();
  assert.deepEqual(catalog.models, [{ id: 'fixture-model', label: 'Fixture Model', isDefault: true, reasoningEffortSupported: true, defaultReasoningEffort: 'high',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Lower latency' }, { reasoningEffort: 'high', description: 'More thinking' }] }]);
  assert.equal(catalog.catalogOnly, true);
  assert.equal(catalog.available, true);
  assert.equal(fixture.children[0].received.some(frame => frame.method === 'thread/start' || frame.method === 'turn/start'), false);
  assert.equal(fixture.children[0].killed, true);
});

test('Codex reasoning effort is per agent and reaches turn/start without shared state', async () => {
  const fixture = codexFixture();
  await fixture.providers.runAgent({ agent: { provider: 'codex', reasoningEffort: 'low' }, prompt: 'first agent' });
  await fixture.providers.runAgent({ agent: { provider: 'codex', reasoningEffort: 'high' }, prompt: 'second agent' });
  assert.equal(fixture.children[0].received.find(frame => frame.method === 'turn/start').params.effort, 'low');
  assert.equal(fixture.children[1].received.find(frame => frame.method === 'turn/start').params.effort, 'high');
});

test('Codex configured effort overrides env while auto inherits env and omitted default sends no effort', async () => {
  for (const [agentEffort, environment, expected] of [
    ['high', { RELAY_CODEX_REASONING_EFFORT: 'low' }, 'high'],
    ['auto', { RELAY_CODEX_REASONING_EFFORT: 'low' }, 'low'],
    ['auto', {}, undefined],
  ]) {
    const fixture = codexFixture({ env: environment });
    await fixture.providers.runAgent({ agent: { provider: 'codex', reasoningEffort: agentEffort }, prompt: 'test' });
    assert.equal(fixture.children[0].received.find(frame => frame.method === 'turn/start').params.effort, expected);
  }
});

test('Codex unsupported or invalid effort fails before any model turn', async () => {
  for (const reasoningEffort of ['xhigh', 'Very High']) {
    const fixture = codexFixture();
    await assert.rejects(fixture.providers.runAgent({ agent: { provider: 'codex', reasoningEffort }, prompt: 'test' }), /思考程度/);
    assert.equal(fixture.children.some(child => child.received.some(frame => frame.method === 'turn/start')), false);
  }
  const withoutDefault = codexFixture({ models: [{ model: 'a-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] });
  await assert.rejects(withoutDefault.providers.runAgent({ agent: { provider: 'codex', reasoningEffort: 'high' }, prompt: 'test' }), /不支持/);
  const noCapability = codexFixture({ models: [{ model: 'fixture-model', isDefault: true }] });
  const entry = (await noCapability.providers.getModels()).models[0];
  assert.equal(entry.reasoningEffortSupported, false);
  assert.deepEqual(entry.supportedReasoningEfforts, []);
  await assert.rejects(noCapability.providers.runAgent({ agent: { provider: 'codex', reasoningEffort: 'high' }, prompt: 'test' }), /不支持/);
});

test('DeepSeek model catalog comes from authenticated GET and returns only safe picker fields', async () => {
  const secret = 'synthetic-directory-key';
  let requested;
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: secret }, platform: 'linux', existsSync: () => false,
    probeHarness: async () => ({ sdkInstalled: false, reasoningEffortSupported: false }),
    spawn: () => assert.fail('catalog must not start SDK inference'),
    fetch: async (url, options) => {
      requested = { url, options };
      return { ok: true, json: async () => ({ object: 'list', apiKey: secret, data: [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', owned_by: 'deepseek', extraSecret: secret },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        { id: 'deepseek-v4-pro', name: 'Duplicate' },
        { id: 'new-provider-model' },
        { id: '', name: 'invalid' },
        { id: secret, name: 'must not leak credential' },
      ] }) };
    },
  });
  const result = await providers.getModels({ provider: 'deepseek' });
  assert.equal(requested.url, 'https://api.deepseek.com/models');
  assert.equal(requested.options.method, 'GET');
  assert.equal(requested.options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(requested.options.redirect, 'error');
  assert.deepEqual(result.models.map(({ id, label, isDefault }) => ({ id, label, ...(isDefault ? { isDefault } : {}) })), [
    { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', isDefault: true },
    { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro' },
    { id: 'new-provider-model', label: 'new-provider-model' },
  ]);
  assert.equal(result.available, true);
  assert.equal(result.catalogOnly, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('Codex and DeepSeek catalogs have independent caches and provider-scoped refresh', async () => {
  let reads = 0;
  const fixture = codexFixture({ env: { DEEPSEEK_API_KEY: 'synthetic-directory-key' }, fetch: async () => {
    reads++;
    return { ok: true, json: async () => ({ data: [{ id: 'deepseek-flash' }] }) };
  } });
  const codex = await fixture.providers.getModels();
  const [deepseek, duplicate] = await Promise.all([
    fixture.providers.getModels({ provider: 'deepseek' }), fixture.providers.getModels({ provider: 'deepseek' }),
  ]);
  assert.equal(deepseek.models[0].id, 'deepseek-flash');
  assert.deepEqual(duplicate, deepseek);
  assert.equal(reads, 1);
  assert.equal((await fixture.providers.getModels()).models[0].id, codex.models[0].id);
  assert.equal(fixture.calls.length, 1);
  await fixture.providers.getModels({ provider: 'deepseek', refresh: true });
  assert.equal(reads, 2);
  assert.equal(fixture.calls.length, 1);
});

test('DeepSeek missing key or unknown provider does not make a network request', async () => {
  let called = false;
  const providers = createProviders({ env: {}, existsSync: () => false, fetch: () => { called = true; assert.fail(); } });
  assert.equal((await providers.getModels({ provider: 'deepseek' })).available, false);
  assert.equal((await providers.getModels({ provider: 'unknown' })).available, false);
  assert.equal(called, false);
});

test('DeepSeek HTTP errors and malformed catalogs fail with no invented models or response secrets', async () => {
  for (const response of [
    { ok: false, status: 401, json: async () => ({ message: 'synthetic-directory-key' }) },
    { ok: true, json: async () => ({ object: 'list', data: null }) },
    { ok: true, json: async () => ({ data: [{ id: '' }] }) },
  ]) {
    const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'synthetic-directory-key' }, existsSync: () => false, fetch: async () => response });
    const result = await providers.getModels({ provider: 'deepseek' });
    assert.equal(result.available, false);
    assert.deepEqual(result.models, []);
    assert.equal(JSON.stringify(result).includes('synthetic-directory-key'), false);
  }
});

test('DeepSeek network failure scrubs credentials from diagnostic text', async () => {
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'synthetic-directory-key' }, existsSync: () => false,
    fetch: async () => { throw new Error('Failed with synthetic-directory-key'); },
  });
  const result = await providers.getModels({ provider: 'deepseek' });
  assert.equal(result.available, false);
  assert.equal(JSON.stringify(result).includes('synthetic-directory-key'), false);
});

test('DeepSeek catalog timeout aborts its read-only HTTP request', async () => {
  let aborted = false;
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'synthetic-directory-key' }, existsSync: () => false, probeTimeoutMs: 15,
    fetch: async (url, options) => new Promise((resolveFetch, rejectFetch) => {
      options.signal.addEventListener('abort', () => { aborted = true; rejectFetch(new Error('aborted')); });
    }),
  });
  const result = await providers.getModels({ provider: 'deepseek' });
  assert.equal(aborted, true);
  assert.match(result.detail, /超时/);
  assert.equal(result.available, false);
});

function harnessEffortFixture({ sdkSupports = true, levels = ['low', 'high', 'max'], env = {} } = {}) {
  const payloads = [];
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'synthetic-key', ...env }, pythonBin: '/fake/python', existsSync: () => true, platform: 'linux',
    probeHarness: async () => ({ sdkInstalled: true, reasoningEffortSupported: sdkSupports, reasoningEfforts: sdkSupports ? ['off', 'low', 'high', 'max'] : [], sdkVersion: '0.1.5rc1' }),
    fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: 'deepseek-flash', name: 'Flash', effort: { supported_levels: levels, default_level: 'high' } }] }) }),
    spawn() { return fakeProcess((frame, child) => { payloads.push(frame); child.send({ type: 'result', text: 'Result', finishReason: 'completed' }); }); },
  });
  return { providers, payloads };
}

test('DeepSeek reasoning choices intersect official API with installed Harness support', async () => {
  const fixture = harnessEffortFixture({ levels: ['low', 'high', 'max', 'unsupported-next'] });
  const entry = (await fixture.providers.getModels({ provider: 'deepseek' })).models[0];
  assert.deepEqual(entry.supportedReasoningEfforts.map(option => option.reasoningEffort), ['off', 'low', 'high', 'max']);
  assert.equal(entry.defaultReasoningEffort, 'high');
  assert.equal(entry.reasoningEffortSupported, true);
  assert.match(entry.reasoningEffortSource, /0\.1\.5rc1/);
});

test('legacy official DeepSeek ID-only catalog uses documented known capabilities without guessing unknown models', async () => {
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'synthetic-key' }, existsSync: () => false,
    probeHarness: async () => ({ sdkInstalled: true, reasoningEffortSupported: true, reasoningEfforts: ['off', 'low', 'high', 'max'], sdkVersion: '0.1.5rc1' }),
    fetch: async () => ({ ok: true, json: async () => ({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'new-provider-model' }] }) }),
  });
  const models = (await providers.getModels({ provider: 'deepseek' })).models;
  for (const entry of models.slice(0, 2)) {
    assert.deepEqual(entry.supportedReasoningEfforts.map(option => option.reasoningEffort), ['off', 'low', 'high', 'max']);
    assert.equal(entry.defaultReasoningEffort, 'high');
    assert.match(entry.reasoningEffortSource, /API 文档/);
  }
  assert.equal(models[2].reasoningEffortSupported, false);
});

test('DeepSeek configured effort overrides env and is sent as a real bridge parameter', async () => {
  const fixture = harnessEffortFixture({ env: { RELAY_DEEPSEEK_REASONING_EFFORT: 'low' } });
  await fixture.providers.runAgent({ agent: { provider: 'deepseek', reasoningEffort: 'max' }, prompt: 'first' });
  await fixture.providers.runAgent({ agent: { provider: 'deepseek', reasoningEffort: 'auto' }, prompt: 'second' });
  await fixture.providers.runAgent({ agent: { provider: 'deepseek', reasoningEffort: 'off' }, prompt: 'third' });
  assert.deepEqual(fixture.payloads.map(payload => payload.reasoningEffort), ['max', 'low', 'off']);
});

test('DeepSeek unsupported efforts or missing SDK/API support reject without starting inference', async () => {
  for (const [fixture, reasoningEffort] of [
    [harnessEffortFixture(), 'medium'],
    [harnessEffortFixture(), 'none'],
    [harnessEffortFixture({ sdkSupports: false }), 'high'],
    [harnessEffortFixture({ levels: [] }), 'high'],
  ]) {
    await assert.rejects(fixture.providers.runAgent({ agent: { provider: 'deepseek', reasoningEffort }, prompt: 'test' }), /不支持/);
    assert.equal(fixture.payloads.length, 0);
  }
  const unsupported = await harnessEffortFixture({ sdkSupports: false }).providers.getModels({ provider: 'deepseek' });
  assert.equal(unsupported.models[0].reasoningEffortSupported, false);
  assert.deepEqual(unsupported.models[0].supportedReasoningEfforts, []);
});

test('invalid native session provider cannot be submitted to a different adapter', async () => {
  const fixture = codexFixture();
  await assert.rejects(fixture.providers.runAgent({ agent: { provider: 'codex' }, session: { provider: 'deepseek', id: 'other' }, prompt: 'test' }), /不符/);
  assert.equal(fixture.calls.length, 0);
});

test('failed and interrupted Codex turn events cannot be treated as acceptance', async () => {
  for (const status of ['failed', 'interrupted']) {
    const fixture = codexFixture({ status });
    await assert.rejects(fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'test' }), status === 'failed' ? /Fixture failure/ : /interrupted/);
  }
});

test('server approval requests receive decline and abort without executing', async () => {
  const fixture = codexFixture({ approval: true });
  await assert.rejects(fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'test' }), /需要审批/);
  assert.deepEqual(fixture.children[0].received.find(frame => frame.id === 99).result, { decision: 'decline' });
  assert.equal(fixture.children[0].killed, true);
});

test('abort rejects the active Codex job and reaps the process', async () => {
  const fixture = codexFixture({ hang: true });
  const controller = new AbortController();
  const running = fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'test', signal: controller.signal });
  const checked = assert.rejects(running, error => error.name === 'AbortError');
  setTimeout(() => controller.abort(), 10);
  await checked;
  assert.equal(fixture.children[0].killed, true);
});

test('normal Codex completion does not settle until its root exit acknowledgement', async () => {
  const cleanup = deferred(); let child;
  const fixture = codexFixture({ childSetup(cp) { child = cp; cp.kill = () => { cp.killed = true; cleanup.resolve(); return true; }; } });
  let settled = false;
  const running = fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'test' });
  running.then(() => { settled = true; }, () => { settled = true; });
  await cleanup.promise;
  assert.equal(settled, false);
  child.exitCode = 0; child.emit('close', 0);
  assert.equal((await running).text, '{"verdict":"accepted"}');
});

test('Codex abort waits for reaping and carries cleanup confirmation instead of releasing early', async () => {
  const cleanup = deferred(), started = deferred(); let child;
  const fixture = codexFixture({ hang: true, onTurnStart: () => started.resolve(), childSetup(cp) { child = cp; cp.kill = () => { cleanup.resolve(); return true; }; } });
  const controller = new AbortController(); let settled = false;
  const running = fixture.providers.runAgent({ agent: { provider: 'codex', accessMode: 'read-only' }, prompt: 'test', signal: controller.signal });
  running.then(() => { settled = true; }, () => { settled = true; });
  await started.promise; controller.abort(); await cleanup.promise;
  assert.equal(settled, false);
  const checked = assert.rejects(running, error => error.name === 'AbortError' && error.cleanupConfirmed === true);
  child.exitCode = 0; child.emit('close', 0); await checked;
});

test('unconfirmed Codex cleanup is explicit and preserves the native session for a workspace barrier', async () => {
  const fixture = codexFixture({ cleanupTimeoutMs: 15, childSetup(child) { child.kill = () => true; } });
  await assert.rejects(fixture.providers.runAgent({ agent: { provider: 'codex' }, prompt: 'test' }), error => {
    assert.equal(error.name, 'ProcessCleanupError'); assert.equal(error.cleanupConfirmed, false);
    assert.deepEqual(error.session, { provider: 'codex', id: 'fixture-thread' }); return true;
  });
});

test('Windows cleanup requires both successful /T termination and root close, in either order', async () => {
  for (const firstAck of ['root', 'tree']) {
    const killing = deferred(); let killer, child, args;
    const providers = createProviders({ platform: 'win32', env: { DEEPSEEK_API_KEY: 'synthetic-key' }, pythonBin: 'fake-python.exe', existsSync: () => true, spawn(command, argv) {
      if (command === 'taskkill.exe') { args = argv; killer = new EventEmitter(); killing.resolve(); return killer; }
      child = fakeProcess((frame, cp) => cp.send({ type: 'result', text: 'Output', finishReason: 'completed' }));
      child.pid = 91001; return child;
    } });
    let settled = false;
    const running = providers.runAgent({ agent: { provider: 'deepseek' }, prompt: 'test' });
    running.then(() => { settled = true; }, () => { settled = true; });
    await killing.promise; assert.deepEqual(args, ['/PID', '91001', '/T', '/F']);
    if (firstAck === 'root') { child.exitCode = 0; child.emit('close', 0); }
    else killer.emit('close', 0);
    await Promise.resolve(); assert.equal(settled, false);
    if (firstAck === 'root') killer.emit('close', 0);
    else { child.exitCode = 0; child.emit('close', 0); }
    assert.equal((await running).text, 'Output');
  }
});

test('Windows tree kill failure never reports a successfully reaped worker', async () => {
  const providers = createProviders({ platform: 'win32', env: { DEEPSEEK_API_KEY: 'synthetic-key' }, pythonBin: 'fake-python.exe', existsSync: () => true, spawn(command) {
    if (command === 'taskkill.exe') { const killer = new EventEmitter(); queueMicrotask(() => killer.emit('close', 5)); return killer; }
    const child = fakeProcess((frame, cp) => cp.send({ type: 'result', text: 'Output', finishReason: 'completed' })); child.pid = 91002; return child;
  } });
  await assert.rejects(providers.runAgent({ agent: { provider: 'deepseek' }, prompt: 'test' }), error => error.cleanupConfirmed === false && error.name === 'ProcessCleanupError');
});

test('POSIX root exit alone does not release a surviving descendant process group', async () => {
  const checking = deferred(); let child, gone = false;
  const providers = createProviders({ platform: 'linux', env: { DEEPSEEK_API_KEY: 'synthetic-key' }, pythonBin: '/fake/python', existsSync: () => true,
    signalProcess(pid, signal) {
      assert.equal(pid, -91003);
      if (signal === 'SIGKILL') { queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); }); return true; }
      assert.equal(signal, 0); checking.resolve();
      if (gone) throw Object.assign(new Error('group is gone'), { code: 'ESRCH' });
      return true;
    }, spawn() { child = fakeProcess((frame, cp) => cp.send({ type: 'result', text: 'Output', finishReason: 'completed' })); child.pid = 91003; return child; },
  });
  let settled = false;
  const running = providers.runAgent({ agent: { provider: 'deepseek' }, prompt: 'test' });
  running.then(() => { settled = true; }, () => { settled = true; });
  await checking.promise; await Promise.resolve(); assert.equal(settled, false);
  gone = true; assert.equal((await running).text, 'Output');
});

test('missing DeepSeek credential rejects without any process or demo output', async () => {
  let spawned = false;
  const providers = createProviders({ env: {}, spawn: () => { spawned = true; assert.fail(); }, pythonBin: '/fake/python', existsSync: () => true });
  await assert.rejects(providers.runAgent({ agent: { provider: 'deepseek' }, prompt: 'test' }), /DEEPSEEK_API_KEY/);
  assert.equal(spawned, false);
});

test('Harness streams through stdin, returns only completed result and never exposes prompt in argv', async () => {
  let launch;
  let child;
  const chunks = [];
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'synthetic-key' }, platform: 'linux', pythonBin: '/fake/python', existsSync: () => true, spawn(command, args, options) {
    launch = { command, args, options };
    child = fakeProcess((payload, cp) => {
      cp.send({ type: 'delta', text: '测试输出' });
      cp.send({ type: 'tool', text: '[工具：read]', method: 'tool/call' });
      cp.send({ type: 'result', text: '最终结果', finishReason: 'completed', usage: { inputTokens: 40, outputTokens: 9 } });
    });
    return child;
  } });
  const result = await providers.runAgent({ agent: { provider: 'deepseek', model: 'DeepSeek Harness' }, prompt: 'secret prompt & 中文', onDelta: (text, meta) => chunks.push({ text, meta }) });
  assert.equal(result.text, '最终结果');
  assert.equal(result.session, undefined);
  assert.ok(!launch.args.join(' ').includes('secret prompt'));
  assert.equal(child.received[0].prompt, 'secret prompt & 中文');
  assert.equal(child.received[0].model, 'deepseek-flash');
  assert.equal(child.received[0].holdUntilClosed, true);
  assert.ok(child.received[0].home.endsWith('harness-home'));
  assert.equal(chunks[1].meta.type, 'tool');
});

test('Harness token-limited result fails rather than passing partial output to reviewer', async () => {
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'synthetic-key' }, pythonBin: '/fake/python', existsSync: () => true, platform: 'linux', spawn() {
    return fakeProcess((payload, child) => child.send({ type: 'result', text: 'Partial', finishReason: 'max-tokens' }));
  } });
  await assert.rejects(providers.runAgent({ agent: { provider: 'deepseek' }, prompt: 'test' }), /max-tokens/);
});

test('DeepSeek UI modelId takes precedence over the environment model and reaches Harness', async () => {
  let payload;
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'synthetic-key', RELAY_DEEPSEEK_MODEL: 'deepseek-flash' }, pythonBin: '/fake/python', existsSync: () => true, platform: 'linux', spawn() {
    return fakeProcess((frame, child) => {
      payload = frame;
      child.send({ type: 'result', text: 'Selected model output', finishReason: 'completed' });
    });
  } });
  await providers.runAgent({ agent: { provider: 'deepseek', model: 'Harness', modelId: 'deepseek-v4-pro' }, prompt: 'test' });
  assert.equal(payload.model, 'deepseek-v4-pro');
});

test('DeepSeek access mode is forwarded independently in its stdin payload and runtime environment', async () => {
  const launches = [], payloads = [];
  const providers = createProviders({ env: { DEEPSEEK_API_KEY: 'synthetic-key', DSH_PERMISSION_MODE: 'danger-full-access' }, pythonBin: '/fake/python', existsSync: () => true, platform: 'linux', spawn(command, args, options) {
    launches.push(options);
    return fakeProcess((frame, child) => { payloads.push(frame); child.send({ type: 'result', text: 'Output', finishReason: 'completed' }); });
  } });
  await providers.runAgent({ agent: { provider: 'deepseek', accessMode: 'read-only' }, prompt: 'read' });
  await providers.runAgent({ agent: { provider: 'deepseek' }, prompt: 'write default' });
  assert.deepEqual(payloads.map(frame => frame.accessMode), ['read-only', 'workspace-write']);
  assert.deepEqual(launches.map(options => options.env.DSH_PERMISSION_MODE), ['read-only', 'workspace-write']);
});

test('capabilities distinguish local login detection from inference verification and scrub account fields', async () => {
  const fixture = codexFixture();
  const capabilities = await fixture.providers.getCapabilities();
  assert.equal(capabilities.codex.authStatus, 'chatgpt-local');
  assert.equal(capabilities.codex.available, true);
  assert.match(capabilities.codex.detail, /执行时验证/);
  assert.ok(!JSON.stringify(capabilities).includes('private@example'));
  assert.equal(capabilities.liveReady, false);
});

test('Windows launcher supports cmd and ps1 safely without prompt interpolation', () => {
  const cmd = processLaunch('C:\\Program Files\\Codex\\codex.cmd', ['app-server'], 'win32', { ComSpec: 'cmd.exe' });
  assert.equal(cmd.command, 'cmd.exe');
  assert.deepEqual(cmd.args.slice(0, 3), ['/d', '/s', '/c']);
  const ps1 = processLaunch('C:\\bin\\codex.ps1', ['app-server'], 'win32');
  assert.equal(ps1.command, 'powershell.exe');
  assert.ok(ps1.args.includes('-File'));
  assert.throws(() => processLaunch('C:\\bad&path\\codex.cmd', ['app-server'], 'win32'), /不安全/);
});

const fixturePython = process.env.RELAY_PYTHON || join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3');
test('Python bridge uses real stdin/JSONL transport, isolated full SDK policy, and holds its root until cleanup', { skip: !existsSync(fixturePython) }, async () => {
  const testRoot = fileURLToPath(new URL('../.relay/provider-test-tmp/', import.meta.url));
  mkdirSync(testRoot, { recursive: true });
  const temporary = mkdtempSync(join(testRoot, 'relay-provider-test-'));
  const bridge = fileURLToPath(new URL('./harness_bridge.py', import.meta.url));
  writeFileSync(join(temporary, 'deepseek_harness_runtime.py'), 'import sys\ndef resolve_bundled_launch_args():\n    return (sys.executable,)\n', 'utf8');
  writeFileSync(join(temporary, 'deepseek_harness.py'), `from types import SimpleNamespace
from pathlib import Path
import os
import time

class DeepSeekHarnessConfig:
    __dataclass_fields__ = {'reasoning_effort': object()}

class Client:
    def __init__(self, workspace):
        self.workspace = workspace
        self.requested = False
    def next_request(self):
        if os.environ.get('RELAY_FAKE_HOST_REQUEST') == '1' and not self.requested:
            self.requested = True
            return SimpleNamespace(id='request-1')
        raise RuntimeError('fake transport closed')
    def respond_error(self, request_id, *, code, message):
        assert request_id == 'request-1'
        assert code == -32601
        assert message == 'Relay has no approval handler'
        (self.workspace / 'rejected.marker').write_text('rejected', encoding='utf8')

class DeepSeekHarness:
    def __init__(self, **options):
        assert options['profile'] == 'sdk'
        assert options['model'] == 'deepseek-flash'
        assert options['dsh_home'].endswith('isolated-home')
        assert options.get('reasoning_effort') == os.environ.get('RELAY_EXPECT_EFFORT')
        policy = Path(options['patches'][0]).read_text(encoding='utf8')
        access_mode = os.environ.get('RELAY_EXPECT_ACCESS_MODE', 'workspace-write')
        preset = 'relay-readonly' if access_mode == 'read-only' else 'relay-workspace'
        assert f'mode: {access_mode}' in policy
        assert 'policy: never' in policy
        assert f'defaultPreset: {preset}' in policy
        assert f'{preset}:\\n        sandbox: {access_mode}\\n        approval: never' in policy
        assert options['env']['DSH_PERMISSION_MODE'] == access_mode
        assert 'maxTokensAsSuccess: false' in policy
        self.workspace = Path(options['cwd'])
        self.client = Client(self.workspace)
    def __enter__(self):
        return self
    def __exit__(self, *args):
        (self.workspace / 'closed.marker').write_text('flushed', encoding='utf8')
    def run(self, prompt, *, session_id, on_notification):
        assert prompt == '中文 prompt & $(must stay literal)'
        if os.environ.get('RELAY_FAKE_HOST_REQUEST') == '1':
            for _ in range(100):
                if (self.workspace / 'rejected.marker').exists():
                    break
                time.sleep(0.005)
        events = [
            {'type':'assistant/chunk','data':{'chunk':{'type':'reasoning-delta','text':'PRIVATE_REASONING'}}},
            {'type':'assistant/message','data':{'message':{'content':[{'type':'text','text':'公开输出'}]},'usage':{'inputTokens':20,'outputTokens':7,'cacheReadTokens':5}}},
            {'type':'tool/call','data':{'callId':'c1','name':'pwsh','arguments':{'command':'Get-Content file.txt'}}},
            {'type':'tool/result','data':{'message':{'callId':'c1','content':[{'type':'text','text':'file evidence'}]}}},
        ]
        for event in events:
            on_notification(SimpleNamespace(method='session.event',payload={'sessionId':session_id,'event':event}))
        return SimpleNamespace(final_response='最终产物',finish_reason='completed',events=events)
`, 'utf8');
  try {
    const env = { ...process.env, PYTHONPATH: temporary, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', TEMP: temporary, TMP: temporary, DEEPSEEK_API_KEY: 'synthetic-test-key' };
    const probe = spawnSync(fixturePython, ['-u', bridge, '--probe'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(JSON.parse(probe.stdout).runtime, true);
    const input = JSON.stringify({ workspace: temporary, home: join(temporary, 'isolated-home'), prompt: '中文 prompt & $(must stay literal)' }) + '\n';
    const run = spawnSync(fixturePython, ['-u', bridge], { env, input, encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const frames = run.stdout.trim().split('\n').map(line => JSON.parse(line));
    const result = frames.find(frame => frame.type === 'result');
    assert.equal(result.text, '最终产物');
    assert.deepEqual(result.usage, { inputTokens: 25, outputTokens: 7, cachedInputTokens: 5 });
    assert.ok(frames.some(frame => frame.type === 'tool' && frame.text.includes('Get-Content')));
    assert.ok(frames.some(frame => frame.type === 'tool' && frame.text.includes('file evidence')));
    assert.ok(!run.stdout.includes('PRIVATE_REASONING'));
    assert.equal(readFileSync(join(temporary, 'closed.marker'), 'utf8'), 'flushed');
    const effortInput = JSON.stringify({ workspace: temporary, home: join(temporary, 'isolated-home'), prompt: '中文 prompt & $(must stay literal)', reasoningEffort: 'max' }) + '\n';
    const effortRun = spawnSync(fixturePython, ['-u', bridge], { env: { ...env, RELAY_EXPECT_EFFORT: 'max' }, input: effortInput, encoding: 'utf8', timeout: 5000 });
    assert.equal(effortRun.status, 0, effortRun.stdout + effortRun.stderr);
    const invalidInput = JSON.stringify({ workspace: temporary, home: join(temporary, 'isolated-home'), prompt: '中文 prompt & $(must stay literal)', reasoningEffort: 'xhigh' }) + '\n';
    const invalidRun = spawnSync(fixturePython, ['-u', bridge], { env, input: invalidInput, encoding: 'utf8', timeout: 5000 });
    assert.equal(invalidRun.status, 1);
    assert.match(invalidRun.stdout, /Unsupported Harness reasoning effort/);
    const readonlyInput = JSON.stringify({ workspace: temporary, home: join(temporary, 'isolated-home'), prompt: '中文 prompt & $(must stay literal)', accessMode: 'read-only' }) + '\n';
    const readonlyRun = spawnSync(fixturePython, ['-u', bridge], { env: { ...env, RELAY_EXPECT_ACCESS_MODE: 'read-only' }, input: readonlyInput, encoding: 'utf8', timeout: 5000 });
    assert.equal(readonlyRun.status, 0, readonlyRun.stdout + readonlyRun.stderr);
    const badAccessInput = JSON.stringify({ workspace: temporary, home: join(temporary, 'isolated-home'), prompt: '中文 prompt & $(must stay literal)', accessMode: 'danger-full-access' }) + '\n';
    const badAccessRun = spawnSync(fixturePython, ['-u', bridge], { env, input: badAccessInput, encoding: 'utf8', timeout: 5000 });
    assert.equal(badAccessRun.status, 1);
    assert.match(badAccessRun.stdout, /accessMode must be read-only or workspace-write/);
    const denied = spawnSync(fixturePython, ['-u', bridge], { env: { ...env, RELAY_FAKE_HOST_REQUEST: '1' }, input, encoding: 'utf8', timeout: 5000 });
    assert.equal(denied.status, 1);
    assert.equal(readFileSync(join(temporary, 'rejected.marker'), 'utf8'), 'rejected');
    const deniedFrames = denied.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(deniedFrames.some(frame => frame.type === 'result'), false);
    assert.match(deniedFrames.find(frame => frame.type === 'error').message, /unsupported host action/);
    async function heldBridge() {
      const child = spawnProcess(fixturePython, ['-u', bridge], { env: { ...env, OPENAI_API_KEY: '', ACCESS_TOKEN: '' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let closeSeen = false;
      const closed = new Promise(resolveClose => child.once('close', code => { closeSeen = true; resolveClose(code); }));
      const ready = new Promise((resolveReady, rejectReady) => {
        const timer = setTimeout(() => { child.stdin.end(); child.kill(); rejectReady(new Error('fake bridge result timeout')); }, 5000);
        const parser = new JsonLines(frame => {
          if (frame.type === 'result') { clearTimeout(timer); resolveReady(frame); }
          if (frame.type === 'error') { clearTimeout(timer); child.stdin.end(); rejectReady(new Error(frame.message)); }
        }, rejectReady);
        child.stdout.on('data', chunk => parser.push(chunk));
        child.once('error', rejectReady);
      });
      child.stdin.on('error', () => {}); child.stderr.resume();
      child.stdin.write(JSON.stringify({ workspace: temporary, home: join(temporary, 'isolated-home'), prompt: '中文 prompt & $(must stay literal)', holdUntilClosed: true }) + '\n');
      const frame = await ready;
      assert.equal(frame.text, '最终产物'); assert.equal(child.exitCode, null); assert.equal(closeSeen, false);
      return { child, closed, isClosed: () => closeSeen };
    }
    const eof = await heldBridge();
    try {
      await new Promise((resolveWrite, rejectWrite) => eof.child.stdin.write('close acknowledged by EOF next\n', error => error ? rejectWrite(error) : resolveWrite()));
      assert.equal(eof.isClosed(), false); assert.equal(eof.child.exitCode, null);
      eof.child.stdin.end(); assert.equal(await eof.closed, 0);
    } finally { if (!eof.isClosed()) { eof.child.stdin.end(); eof.child.kill(); await eof.closed; } }
    if (process.platform === 'win32') {
      const tree = await heldBridge();
      try {
        const killer = spawnProcess('taskkill.exe', ['/PID', String(tree.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        const killerCode = await new Promise((resolveKill, rejectKill) => { killer.once('error', rejectKill); killer.once('close', resolveKill); });
        assert.equal(killerCode, 0); await tree.closed; assert.equal(tree.isClosed(), true);
      } finally { if (!tree.isClosed()) { tree.child.stdin.end(); tree.child.kill(); await tree.closed; } }
    }
  } finally {
    // This exact disposable fixture directory is owned by this test.
    assert.equal(dirname(resolve(temporary)), resolve(testRoot));
    assert.ok(basename(temporary).startsWith('relay-provider-test-'));
    rmSync(temporary, { recursive: true, force: true });
  }
});
