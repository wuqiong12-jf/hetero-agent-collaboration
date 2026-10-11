import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CODEX_READONLY_FEATURES, codexReadOnlyConfig, verifyCodexReadOnly } from './codex-readonly.mjs';
import { createProviders } from './providers.mjs';

const features = () => CODEX_READONLY_FEATURES.map(name => ({ name, enabled: false }));
const disabled = (name = 'sentinel') => ({ name, runtimeStatus: 'disabled', tools: {} });
const safeInventory = (overrides = {}) => ({
  'config/read': { config: { mcp_servers: { sentinel: { command: 'private-command', env: { SECRET: 'private-value' } } } } },
  'experimentalFeature/list': { data: features(), nextCursor: null },
  'mcpServerStatus/list': { data: [disabled()], nextCursor: null },
  ...overrides,
});
function sessionFixture(responses = safeInventory()) {
  const calls = [];
  return { calls, async request(method, params) {
    calls.push({ method, params });
    const value = responses[method];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(params) : value;
  } };
}

test('read-only config disables exact server names and omits inherited secrets', async () => {
  const servers = Object.fromEntries(['sentinel.dot', '__proto__', 'constructor'].map(name => [name, { command: 'private-command', env: { SECRET: 'private-value' } }]));
  const session = sessionFixture({ 'config/read': { config: { mcp_servers: servers } } });
  const result = await codexReadOnlyConfig(session, '/workspace');
  assert.deepEqual(Object.keys(result.mcp_servers), ['sentinel.dot', '__proto__', 'constructor']);
  for (const setting of Object.values(result.mcp_servers)) assert.deepEqual(setting, { enabled: false });
  assert.deepEqual(result.features, Object.fromEntries(CODEX_READONLY_FEATURES.map(name => [name, false])));
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.deepEqual(session.calls[0], { method: 'config/read', params: { cwd: '/workspace', includeLayers: false } });
});

test('an explicitly empty effective server inventory is allowed', async () => {
  const session = sessionFixture({ 'config/read': { config: { mcp_servers: {} } } });
  assert.deepEqual((await codexReadOnlyConfig(session, '/workspace')).mcp_servers, {});
});

test('missing or malformed effective config fails closed', async () => {
  for (const response of [undefined, {}, { config: [] }, { config: {} }, { config: { mcp_servers: [] } },
    { config: { mcp_servers: null } }, { config: { mcp_servers: { sentinel: [] } } }]) {
    await assert.rejects(codexReadOnlyConfig(sessionFixture({ 'config/read': response }), '/workspace'), { code: 'RELAY_CODEX_READONLY_UNVERIFIED' });
  }
});

test('configuration and inventory RPC errors do not leak private details', async () => {
  const secretError = new Error('https://private.test SECRET=private-value');
  for (const operation of [codexReadOnlyConfig(sessionFixture({ 'config/read': secretError }), '/workspace'),
    verifyCodexReadOnly(sessionFixture(safeInventory({ 'mcpServerStatus/list': secretError })), 'thread')]) {
    await assert.rejects(operation, error => error.code === 'RELAY_CODEX_READONLY_UNVERIFIED' && !/private|SECRET/.test(error.message));
  }
});

test('features and MCP inventory are verified through every page', async () => {
  const session = sessionFixture(safeInventory({
    'experimentalFeature/list': ({ cursor }) => cursor ? { data: features().slice(3), nextCursor: null }
      : { data: [{ name: 'shell_tool', enabled: true }, ...features().slice(0, 3)], nextCursor: 'features-2' },
    'mcpServerStatus/list': ({ cursor }) => cursor ? { data: [disabled('second')], nextCursor: null }
      : { data: [disabled('first')], nextCursor: 'mcp-2' },
  }));
  await verifyCodexReadOnly(session, 'thread');
  assert.deepEqual(session.calls.map(call => call.params.cursor), [undefined, 'features-2', undefined, 'mcp-2']);
  assert.ok(session.calls.every(call => call.params.threadId === 'thread'));
});

test('enabled, missing, or duplicate required features stop before reading MCP inventory', async () => {
  for (const data of [features().slice(1), [{ ...features()[0], enabled: true }, ...features().slice(1)], [...features(), features()[0]]]) {
    const session = sessionFixture(safeInventory({ 'experimentalFeature/list': { data, nextCursor: null } }));
    await assert.rejects(verifyCodexReadOnly(session, 'thread'), { code: 'RELAY_CODEX_READONLY_UNVERIFIED' });
    assert.equal(session.calls.some(call => call.method === 'mcpServerStatus/list'), false);
  }
});

test('disabled server status and an empty tool object are both required', async () => {
  for (const server of [{ ...disabled(), runtimeStatus: 'connected' }, { ...disabled(), tools: { write: {} } },
    { ...disabled(), tools: [] }, { ...disabled(), tools: null }, { name: 'sentinel', tools: {} }, null]) {
    const session = sessionFixture(safeInventory({ 'mcpServerStatus/list': { data: [server], nextCursor: null } }));
    await assert.rejects(verifyCodexReadOnly(session, 'thread'), { code: 'RELAY_CODEX_READONLY_UNVERIFIED' });
  }
});

test('malformed pagination and repeated cursors cannot certify a partial inventory', async () => {
  for (const response of [{ data: features() }, { data: features(), nextCursor: '' }, { data: features(), nextCursor: 1 },
    { data: {}, nextCursor: null }, { data: features(), nextCursor: 'loop' }]) {
    const session = sessionFixture(safeInventory({ 'experimentalFeature/list': response }));
    await assert.rejects(verifyCodexReadOnly(session, 'thread'), { code: 'RELAY_CODEX_READONLY_UNVERIFIED' });
  }
});

test('pagination is bounded even when each cursor is new', async () => {
  let pages = 0;
  const session = sessionFixture(safeInventory({ 'mcpServerStatus/list': () => ({ data: [], nextCursor: `page-${++pages}` }) }));
  await assert.rejects(verifyCodexReadOnly(session, 'thread'), { code: 'RELAY_CODEX_READONLY_UNVERIFIED' });
  assert.equal(pages, 20);
});

test('cancellation retains its AbortError identity', async () => {
  const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  await assert.rejects(codexReadOnlyConfig(sessionFixture({ 'config/read': cancellation }), '/workspace'), error => error === cancellation);
  await assert.rejects(verifyCodexReadOnly(sessionFixture(safeInventory({ 'experimentalFeature/list': cancellation })), 'thread'), error => error === cancellation);
});

function providerFixture(overrides = {}) {
  const children = [];
  const responses = safeInventory(overrides);
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killed = false; child.frames = [];
    child.send = frame => child.stdout.write(JSON.stringify(frame) + '\n');
    let input = '';
    child.stdin = new Writable({ write(chunk, _, callback) {
      input += chunk.toString();
      let newline;
      while ((newline = input.indexOf('\n')) >= 0) {
        const frame = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1); child.frames.push(frame);
        queueMicrotask(() => {
          if (frame.id === undefined) return;
          let result;
          if (frame.method === 'initialize') result = {};
          else if (frame.method === 'account/read') result = { account: { type: 'chatgpt' } };
          else if (frame.method === 'thread/start') result = { thread: { id: 'new-thread' } };
          else if (frame.method === 'thread/resume') result = { thread: { id: frame.params.threadId } };
          else if (frame.method === 'turn/start') {
            child.send({ id: frame.id, result: { turn: { id: 'turn' } } });
            child.send({ method: 'turn/completed', params: { turn: { status: 'completed', items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Reviewed.' }] } } });
            return;
          } else result = responses[frame.method];
          if (result instanceof Error) child.send({ id: frame.id, error: { code: -32601, message: result.message } });
          else child.send({ id: frame.id, result });
        });
      }
      callback();
    } });
    child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
    children.push(child); return child;
  };
  const providers = createProviders({ spawn, platform: 'linux', codexBin: '/fake/codex', pythonBin: '/fake/python', env: {}, existsSync: () => true, timeoutMs: 1000 });
  return { providers, children };
}
const run = (fixture, extra = {}) => fixture.providers.runAgent({ agent: { provider: 'codex', accessMode: 'read-only' }, prompt: 'Review fixtures', workspace: '/workspace', ...extra });

test('Codex read-only start verifies isolated tool inventory before inference', async () => {
  const fixture = providerFixture();
  assert.equal((await run(fixture)).text, 'Reviewed.');
  const frames = fixture.children[0].frames;
  assert.equal(frames[0].params.capabilities.experimentalApi, true);
  const start = frames.find(frame => frame.method === 'thread/start');
  assert.deepEqual(start.params.dynamicTools, []);
  assert.deepEqual(start.params.config.mcp_servers, { sentinel: { enabled: false } });
  assert.ok(frames.findIndex(frame => frame.method === 'mcpServerStatus/list') < frames.findIndex(frame => frame.method === 'turn/start'));
  assert.equal(fixture.children[0].killed, true);
});

test('Codex read-only resume keeps the stored thread and reapplies isolation', async () => {
  const fixture = providerFixture();
  assert.deepEqual((await run(fixture, { session: { provider: 'codex', id: 'stored-thread' } })).session, { provider: 'codex', id: 'stored-thread' });
  const frames = fixture.children[0].frames;
  assert.equal(frames.some(frame => frame.method === 'thread/start'), false);
  const resume = frames.find(frame => frame.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'stored-thread');
  assert.equal('dynamicTools' in resume.params, false);
  assert.equal(resume.params.config.features.apps, false);
});

test('Codex cannot start inference when any external server remains available', async () => {
  const fixture = providerFixture({ 'mcpServerStatus/list': { data: [{ ...disabled(), runtimeStatus: 'connected', tools: { write: {} } }], nextCursor: null } });
  const sessions = [];
  await assert.rejects(run(fixture, { onSession: session => sessions.push(session) }), error => error.code === 'RELAY_CODEX_READONLY_UNVERIFIED' && error.cleanupConfirmed === true && !error.session);
  assert.deepEqual(sessions, []);
  assert.equal(fixture.children[0].frames.some(frame => frame.method === 'turn/start'), false);
  assert.equal(fixture.children[0].killed, true);
});

test('rejected resume preflight preserves the original resumable session reference', async () => {
  const fixture = providerFixture({ 'experimentalFeature/list': { data: features().slice(1), nextCursor: null } });
  const original = { provider: 'codex', id: 'stored-thread' };
  const sessions = [];
  await assert.rejects(run(fixture, { session: original, onSession: session => sessions.push(session) }), error => {
    assert.deepEqual(error.session, original);
    return error.code === 'RELAY_CODEX_READONLY_UNVERIFIED';
  });
  assert.deepEqual(sessions, []);
  assert.equal(fixture.children[0].frames.some(frame => frame.method === 'turn/start'), false);
});

test('unsupported verification RPC stops a read-only run without leaking server errors', async () => {
  const fixture = providerFixture({ 'experimentalFeature/list': new Error('private-url SECRET=private-value') });
  await assert.rejects(run(fixture), error => error.code === 'RELAY_CODEX_READONLY_UNVERIFIED' && !/private|SECRET/.test(error.message));
  assert.equal(fixture.children[0].frames.some(frame => frame.method === 'turn/start'), false);
  assert.equal(fixture.children[0].killed, true);
});

test('writing Codex agents retain their inherited configuration and handshake', async () => {
  const fixture = providerFixture();
  await run(fixture, { agent: { provider: 'codex', accessMode: 'workspace-write' } });
  const frames = fixture.children[0].frames;
  assert.equal('capabilities' in frames[0].params, false);
  assert.equal(frames.some(frame => ['config/read', 'experimentalFeature/list', 'mcpServerStatus/list'].includes(frame.method)), false);
  const start = frames.find(frame => frame.method === 'thread/start');
  assert.equal('config' in start.params, false); assert.equal('dynamicTools' in start.params, false);
});
