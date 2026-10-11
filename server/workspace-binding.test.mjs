import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync,
  symlinkSync, writeFileSync, promises as files,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Orchestrator, createInitialState } from './engine.mjs';
import {
  WorkspaceBindingError, canonicalWorkspace, createWorkspaceBinding, assertWorkspaceBinding,
} from './workspace.mjs';

const PREFIX = 'relay-workspace-binding-test-';
const INVALID = 'RELAY_WORKSPACE_INVALID';
const MISMATCH = 'RELAY_WORKSPACE_MISMATCH';
const UNBOUND = 'RELAY_WORKSPACE_UNBOUND';
const STATE_INVALID = 'RELAY_STATE_INVALID';

function safeCleanup(directory) {
  const absolute = resolve(directory);
  assert.equal(dirname(absolute), resolve(tmpdir()), 'cleanup must remain in the fixture temporary parent');
  assert.ok(basename(absolute).startsWith(PREFIX), 'cleanup must target an owned fixture root');
  rmSync(absolute, { recursive: true, force: true });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), PREFIX));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith(PREFIX));
  const A = join(root, 'A');
  const B = join(root, 'B');
  const store = join(root, 'snapshots');
  for (const directory of [A, B, store]) mkdirSync(directory);
  const engines = [];
  const providerCalls = { capabilities: 0, runs: 0 };
  const providers = {
    getCapabilities: () => {
      providerCalls.capabilities += 1;
      return { codex: { available: true }, harness: { available: true }, liveReady: true };
    },
    runAgent: async () => {
      providerCalls.runs += 1;
      assert.fail('workspace binding fixtures must never start a model');
    },
  };
  const engine = (options = {}) => {
    const value = new Orchestrator({ workspace: A, providers, ...options });
    engines.push(value);
    return value;
  };
  t.after(async () => {
    try {
      for (const value of engines.reverse()) await value.close();
    } finally {
      safeCleanup(root);
    }
  });
  return { root, A, B, store, providers, providerCalls, engine };
}

function bindingError(code) {
  return (error) => error instanceof WorkspaceBindingError && error.code === code;
}

function writeSnapshot(path, state) {
  // Keep unusual whitespace so a rejected load must preserve the actual bytes.
  const bytes = Buffer.from(` \n${JSON.stringify(state, null, 3)}\n\n`, 'utf8');
  writeFileSync(path, bytes);
  return bytes;
}

function mutationRecorder() {
  const calls = [];
  const fileOps = Object.fromEntries(['mkdir', 'writeFile', 'rename', 'unlink'].map((name) => [name, async (...args) => {
    calls.push(name);
    return files[name](...args);
  }]));
  return { calls, fileOps };
}

function assertRejectedSnapshot(f, { path, workspace, code, initialState }) {
  const original = readFileSync(path);
  const names = readdirSync(f.store).sort();
  const mutations = mutationRecorder();
  assert.throws(() => f.engine({ persistencePath: path, workspace, initialState, fileOps: mutations.fileOps }), bindingError(code));
  assert.deepEqual(readFileSync(path), original, 'rejected loading must retain every snapshot byte');
  assert.deepEqual(readdirSync(f.store).sort(), names, 'rejected loading must not create backups or temporary saves');
  assert.deepEqual(mutations.calls, [], 'rejected loading must not enter persistence');
  assert.deepEqual(f.providerCalls, { capabilities: 0, runs: 0 }, 'rejected loading must not check or run providers');
}

function retainedState() {
  const state = createInitialState();
  state.mode = 'live';
  state.collaborationMode = 'cooperative';
  state.phase = 'paused';
  state.tasks[0].status = 'accepted';
  state.tasks[0].attempt = 2;
  state.tasks[0].reviewAttempts = 1;
  state.tasks[0].output = 'SYNTHETIC_RETAINED_DELIVERY';
  state.tasks[0].criteria[0].status = 'passed';
  state.tasks[0].criteria[0].evidence = 'synthetic fixture evidence';
  state.usage.supervisorCalls = 5;
  state.usage.workerCalls = 7;
  state.usage.autoSupervisorCalls = 3;
  state.usage.autoWorkerCalls = 4;
  state.usage.providerCalls = { codex: 5, deepseek: 7 };
  state.usage.autoProviderCalls = { codex: 3, deepseek: 4 };
  state.usage.inputTokens = 123;
  state.usage.outputTokens = 45;
  state.settings.maxSupervisorCalls = 8;
  state.settings.maxWorkerCalls = 10;
  state.settings.maxProviderCalls = { codex: 8, deepseek: 10 };
  state.chatSessions['codex-supervisor'].providerSession = { provider: 'codex', id: 'fixture-native-session-reference' };
  state.messages.push({
    id: 'fixture-retained-chat-output', agentId: 'codex-supervisor', role: 'assistant',
    kind: 'message', at: '2026-10-11T00:00:00.000Z', text: 'SYNTHETIC_RETAINED_CHAT_OUTPUT',
    conversationId: state.chatSessions['codex-supervisor'].id, status: 'completed',
  });
  return state;
}

test('canonical workspace bindings identify the existing directory and accept dot and trailing separator aliases', (t) => {
  const f = fixture(t);
  const canonical = canonicalWorkspace(f.A);
  const expected = { version: 1, directory: canonical };
  for (const path of [f.A, `${f.A}${sep}.`, `${f.A}${sep}`]) {
    assert.equal(canonicalWorkspace(path), canonical);
    assert.deepEqual(createWorkspaceBinding(path), expected);
    assert.doesNotThrow(() => assertWorkspaceBinding(expected, canonicalWorkspace(path)));
  }
  assert.notEqual(canonicalWorkspace(f.A), canonicalWorkspace(f.B), 'sibling directories must have different identities');
  assert.throws(() => assertWorkspaceBinding(expected, canonicalWorkspace(f.B)), bindingError(MISMATCH));
});

test('a new snapshot and an unbound initialState acquire the engine canonical workspace binding', async (t) => {
  const f = fixture(t);
  const expected = createWorkspaceBinding(f.A);
  for (const [name, initialState] of [['new', undefined], ['initial', createInitialState()]]) {
    const path = join(f.store, `${name}.json`);
    const engine = f.engine({ workspace: `${f.A}${sep}.`, persistencePath: path, initialState });
    assert.equal(engine.workspace, expected.directory);
    assert.deepEqual(engine.getState().workspaceBinding, expected);
    assert.equal(await engine.flushPersistence(), true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).workspaceBinding, expected);
    if (initialState) assert.equal(Object.hasOwn(initialState, 'workspaceBinding'), false, 'binding must not mutate caller input');
  }
  assert.deepEqual(f.providerCalls, { capabilities: 0, runs: 0 });
});

test('same-workspace restart preserves outputs, budget usage and native chat session references', async (t) => {
  const f = fixture(t);
  const path = join(f.store, 'retained.json');
  const engine = f.engine({ persistencePath: path, initialState: retainedState() });
  assert.equal(await engine.flushPersistence(), true);
  await engine.close();
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  const restored = f.engine({ persistencePath: path });
  const state = restored.getState();
  for (const key of ['id', 'tasks', 'messages', 'usage', 'settings', 'chatSessions', 'chatArchives']) {
    assert.deepEqual(state[key], saved[key], `${key} must survive a bound restart`);
  }
  assert.equal(state.tasks[0].output, 'SYNTHETIC_RETAINED_DELIVERY');
  assert.equal(state.chatSessions['codex-supervisor'].providerSession.id, 'fixture-native-session-reference');
  assert.deepEqual(state.workspaceBinding, createWorkspaceBinding(f.A));
  assert.deepEqual(f.providerCalls, { capabilities: 0, runs: 0 });
});

test('junction and directory aliases may restore a snapshot bound to the same actual directory', async (t) => {
  const f = fixture(t);
  const alias = join(f.root, 'alias-A');
  symlinkSync(f.A, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const canonical = canonicalWorkspace(f.A);
  assert.equal(canonicalWorkspace(alias), canonical);
  const path = join(f.store, 'aliases.json');
  const initial = f.engine({ persistencePath: path, initialState: retainedState() });
  await initial.close();
  const sessionId = JSON.parse(readFileSync(path, 'utf8')).id;
  for (const workspace of [`${f.A}${sep}.`, `${f.A}${sep}`, alias]) {
    const restored = f.engine({ persistencePath: path, workspace });
    assert.equal(restored.workspace, canonical);
    assert.equal(restored.getState().id, sessionId);
    assert.deepEqual(restored.getState().workspaceBinding, { version: 1, directory: canonical });
    await restored.close();
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).workspaceBinding, { version: 1, directory: canonical });
  }
  assert.deepEqual(f.providerCalls, { capabilities: 0, runs: 0 });
});

test('a snapshot bound to sibling A is rejected from B without changing bytes or calling providers', (t) => {
  const f = fixture(t);
  const path = join(f.store, 'A-bound.json');
  const state = retainedState();
  state.workspaceBinding = createWorkspaceBinding(f.A);
  writeSnapshot(path, state);
  assertRejectedSnapshot(f, { path, workspace: f.B, code: MISMATCH });
});

test('legacy snapshots without a workspace binding are rejected from every requested directory', (t) => {
  const f = fixture(t);
  const path = join(f.store, 'legacy.json');
  const state = retainedState();
  assert.equal(Object.hasOwn(state, 'workspaceBinding'), false);
  writeSnapshot(path, state);
  for (const workspace of [f.A, f.B, `${f.A}${sep}.`]) {
    assertRejectedSnapshot(f, { path, workspace, code: UNBOUND });
  }
});

test('malformed saved bindings are rejected before persistence or provider work', (t) => {
  const f = fixture(t);
  const canonical = canonicalWorkspace(f.A);
  const cases = [
    ['non-object', 'fixture'],
    ['null', null],
    ['non-string-directory', { version: 1, directory: 42 }],
    ['relative-directory', { version: 1, directory: 'relative-workspace' }],
    ['empty-directory', { version: 1, directory: '' }],
    ['unknown-version', { version: 2, directory: canonical }],
    ['missing-version', { directory: canonical }],
  ];
  for (const [name, binding] of cases) {
    assert.throws(() => assertWorkspaceBinding(binding, canonical), bindingError(INVALID), name);
    const path = join(f.store, `${name}.json`);
    const state = retainedState();
    state.workspaceBinding = binding;
    writeSnapshot(path, state);
    assertRejectedSnapshot(f, { path, workspace: f.A, code: INVALID });
  }
});

test('missing workspaces and ordinary files cannot become an engine workspace', (t) => {
  const f = fixture(t);
  const plainFile = join(f.root, 'ordinary-file');
  writeFileSync(plainFile, 'synthetic ordinary file');
  for (const [name, workspace] of [['missing', join(f.root, 'missing')], ['file', plainFile], ['empty', ''], ['non-string', 42]]) {
    assert.throws(() => canonicalWorkspace(workspace), bindingError(INVALID), name);
    const mutations = mutationRecorder();
    const path = join(f.store, `${name}.json`);
    assert.throws(() => f.engine({ workspace, persistencePath: path, fileOps: mutations.fileOps }), bindingError(INVALID), name);
    assert.deepEqual(mutations.calls, [], 'invalid requested directory must fail before persistence');
  }
  assert.deepEqual(readdirSync(f.store), []);
  assert.deepEqual(f.providerCalls, { capabilities: 0, runs: 0 });
});

test('replacing original A with a junction to B cannot remap the saved directory identity', async (t) => {
  const f = fixture(t);
  const path = join(f.store, 'physical-identity.json');
  const originalBinding = createWorkspaceBinding(f.A);
  const engine = f.engine({ persistencePath: path, initialState: retainedState() });
  await engine.close();
  assert.equal(dirname(resolve(f.A)), resolve(f.root));
  assert.equal(basename(f.A), 'A');
  rmdirSync(f.A); // This owned workspace is empty; the snapshot is in the sibling store.
  symlinkSync(f.B, f.A, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(canonicalWorkspace(f.A), canonicalWorkspace(f.B));
  assert.notEqual(canonicalWorkspace(f.A), originalBinding.directory);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).workspaceBinding, originalBinding);
  assertRejectedSnapshot(f, { path, workspace: f.A, code: MISMATCH });
});

test('a forged or malformed initialState binding is rejected when no snapshot exists', (t) => {
  const f = fixture(t);
  for (const [name, workspaceBinding, code] of [
    ['other-root', createWorkspaceBinding(f.B), MISMATCH],
    ['malformed', { version: 1, directory: 'relative-workspace' }, INVALID],
  ]) {
    const initialState = retainedState();
    initialState.workspaceBinding = workspaceBinding;
    const mutations = mutationRecorder();
    assert.throws(() => f.engine({ initialState, persistencePath: join(f.store, `${name}.json`), fileOps: mutations.fileOps }), bindingError(code));
    assert.deepEqual(mutations.calls, []);
    assert.deepEqual(initialState.workspaceBinding, workspaceBinding);
  }
  assert.deepEqual(readdirSync(f.store), []);
  assert.deepEqual(f.providerCalls, { capabilities: 0, runs: 0 });
});

test('tampered state and staged persistence cannot replace the engine-owned binding', async (t) => {
  const f = fixture(t);
  const path = join(f.store, 'tampered-state.json');
  const expected = createWorkspaceBinding(f.A);
  const wrong = createWorkspaceBinding(f.B);
  const engine = f.engine({ persistencePath: path });
  await engine.flushPersistence();
  engine.state.workspaceBinding = wrong;
  assert.deepEqual(engine.getState().workspaceBinding, expected);
  const staged = structuredClone(engine.state);
  staged.goal = 'SYNTHETIC_STAGED_SAVE';
  staged.workspaceBinding = wrong;
  engine._persist(staged);
  assert.equal(await engine.flushPersistence(), true);
  const stagedSaved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(stagedSaved.goal, 'SYNTHETIC_STAGED_SAVE', 'staged persistence must retain its proposed data');
  assert.deepEqual(stagedSaved.workspaceBinding, expected);
  engine.state.workspaceBinding = { version: 77, directory: 'invalid' };
  engine._persist();
  assert.equal(await engine.flushPersistence(), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).workspaceBinding, expected);
  const exposed = engine.getState();
  try { exposed.workspaceBinding.directory = wrong.directory; }
  catch (error) { assert.ok(error instanceof TypeError, 'a frozen snapshot may reject mutation'); }
  assert.deepEqual(engine.getState().workspaceBinding, expected, 'snapshot consumers must not mutate the engine binding');
  assert.deepEqual(f.providerCalls, { capabilities: 0, runs: 0 });
});

test('failed-save pending snapshots and explicit retry always retain the engine-owned binding', async (t) => {
  const f = fixture(t);
  const path = join(f.store, 'retry-binding.json');
  const expected = createWorkspaceBinding(f.A);
  const wrong = createWorkspaceBinding(f.B);
  let locked = false;
  const attemptedBindings = [];
  const engine = f.engine({
    persistencePath: path, persistenceRetryDelays: [],
    fileOps: {
      writeFile: async (file, text, options) => {
        attemptedBindings.push(JSON.parse(text).workspaceBinding);
        return files.writeFile(file, text, options);
      },
      rename: async (from, to) => {
        if (locked) throw Object.assign(new Error('synthetic fixture destination lock'), { code: 'EPERM' });
        return files.rename(from, to);
      },
    },
  });
  assert.equal(await engine.flushPersistence(), true);
  const original = readFileSync(path);
  locked = true;
  engine.state.workspaceBinding = wrong;
  const staged = structuredClone(engine.state);
  staged.workspaceBinding = wrong;
  engine._persist(staged);
  assert.equal(await engine.flushPersistence(), false);
  assert.deepEqual(readFileSync(path), original, 'failed saves must preserve the last valid destination');
  assert.deepEqual(JSON.parse(engine.pendingSnapshot).workspaceBinding, expected, 'the failure recovery snapshot must also force the binding');
  assert.deepEqual(engine.getState().workspaceBinding, expected);
  engine.state.workspaceBinding = { version: 1, directory: 'relative-workspace' };
  locked = false;
  assert.equal(await engine.flushPersistence({ retry: true }), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).workspaceBinding, expected);
  assert.ok(attemptedBindings.length >= 3, 'the fixture must exercise initial, failed and retried writes');
  for (const binding of attemptedBindings) assert.deepEqual(binding, expected);
  assert.deepEqual(f.providerCalls, { capabilities: 0, runs: 0 });
});

test('a stale expectedStateId rejects a live message without changing state, snapshots or provider calls', async (t) => {
  const f = fixture(t);
  const path = join(f.store, 'stale-session-action.json');
  const mutations = mutationRecorder();
  const engine = f.engine({ persistencePath: path, initialState: retainedState(), fileOps: mutations.fileOps });
  assert.equal(await engine.flushPersistence(), true);
  const original = readFileSync(path);
  const before = engine.getState();
  mutations.calls.length = 0;
  await assert.rejects(engine.action({
    action: 'message', agentId: 'codex-supervisor', text: 'SYNTHETIC_STALE_MESSAGE',
    expectedStateId: `${before.id}-stale`,
  }), (error) => error.status === 409);
  assert.deepEqual(engine.getState(), before, 'rejected stale actions must not add messages or consume counters');
  assert.deepEqual(readFileSync(path), original);
  assert.deepEqual(mutations.calls, []);
  assert.deepEqual(f.providerCalls, { capabilities: 0, runs: 0 });
});

test('corrupt JSON snapshots fail closed without backup, overwrite or provider calls', (t) => {
  const f = fixture(t);
  const path = join(f.store, 'corrupt-json.json');
  writeFileSync(path, Buffer.from(' \n{"workspaceBinding": {"version": 1, "directory": \n', 'utf8'));
  assertRejectedSnapshot(f, { path, workspace: f.A, code: STATE_INVALID });
});

test('a valid workspace binding with invalid business schema fails closed without snapshot mutation', (t) => {
  const f = fixture(t);
  const path = join(f.store, 'invalid-business-schema.json');
  const state = retainedState();
  state.workspaceBinding = createWorkspaceBinding(f.A);
  state.tasks = { synthetic: 'tasks must be an array' };
  writeSnapshot(path, state);
  assertRejectedSnapshot(f, { path, workspace: f.A, code: STATE_INVALID });
});
