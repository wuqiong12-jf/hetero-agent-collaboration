import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Orchestrator, createInitialState } from './engine.mjs';
import { prepareSettings } from './settings.mjs';

const PREFIX = 'relay-settings-concurrency-test-';
const available = () => ({ codex: { available: true }, harness: { available: true }, liveReady: true });
const status = (expected) => (error) => error.status === expected;

function fixture(t, { deferred = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), PREFIX));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const initial = createInitialState();
  initial.mode = 'live';
  initial.phase = 'paused';
  initial.agents[0].accessMode = 'read-only';
  initial.agents[1].accessMode = 'read-only';
  initial.tasks[0].status = 'accepted';
  initial.tasks[0].output = 'SYNTHETIC_RETAINED_DELIVERY';
  initial.tasks[0].attempt = 2;
  initial.tasks[0].criteria[0].status = 'passed';
  initial.tasks[0].criteria[0].evidence = 'synthetic fixture evidence';
  initial.usage.autoSupervisorCalls = 2;
  initial.usage.autoWorkerCalls = 3;
  initial.usage.autoProviderCalls = { codex: 2, deepseek: 3 };
  initial.usage.inputTokens = 123;
  initial.usage.outputTokens = 45;
  const calls = [];
  const providers = {
    getCapabilities: available,
    runAgent: (args) => {
      assert.ok(deferred, 'settings actions must not start model inference');
      return new Promise((resolve, reject) => {
        const call = {
          ...args, resolve,
          confirmStopped: () => reject(Object.assign(new Error('synthetic process reaped'), { name: 'AbortError', cleanupConfirmed: true })),
        };
        calls.push(call);
      });
    },
  };
  let engine;
  t.after(async () => {
    try {
      for (const call of calls) call.confirmStopped();
      await engine?.close();
    } finally {
      const absolute = resolve(root);
      assert.equal(dirname(absolute), resolve(tmpdir()), 'cleanup must remain inside the fixture temporary parent');
      assert.ok(basename(absolute).startsWith(PREFIX), 'cleanup must target this test\'s owned fixture root');
      rmSync(absolute, { recursive: true, force: true });
    }
  });
  engine = new Orchestrator({ workspace, initialState: initial, providers });
  return { engine, calls };
}

async function rejectedUnchanged(engine, payload, expectedStatus) {
  const before = engine.getState();
  let emissions = 0;
  const unsubscribe = engine.subscribe(() => { emissions += 1; });
  try {
    await assert.rejects(engine.action({ action: 'settings', ...payload }), status(expectedStatus));
    assert.deepEqual(engine.getState(), before, 'rejection must retain settings, revision, activity, tasks, delivery outputs, and usage');
    assert.equal(emissions, 0, 'rejected settings must not publish a changed snapshot');
  } finally {
    unsubscribe();
  }
}

async function until(engine, predicate) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (predicate(engine.getState())) return;
    await sleep(2);
  }
  assert.fail('synthetic chat fixture did not reach the expected state');
}

test('settings preparation is immutable and independent edits preserve the other provider budget', () => {
  const current = createInitialState().settings;
  const before = structuredClone(current);
  const next = prepareSettings(current, {
    settings: { maxWorkerCalls: 21, maxProviderCalls: { deepseek: 22 } },
    expectedSettings: { maxWorkerCalls: 16, maxProviderCalls: { deepseek: 16 } },
  });
  assert.deepEqual(current, before);
  assert.equal(next.maxWorkerCalls, 21);
  assert.deepEqual(next.maxProviderCalls, { codex: 12, deepseek: 22 });
  assert.notEqual(next.maxProviderCalls, current.maxProviderCalls);
});

test('same numeric field edited by two windows rejects the stale change without changing retained work', async (t) => {
  const { engine, calls } = fixture(t);
  const old = engine.getState();
  await engine.action({ action: 'settings', expectedStateId: old.id, settings: { maxWorkerCalls: 20 }, expectedSettings: { maxWorkerCalls: old.settings.maxWorkerCalls } });
  await rejectedUnchanged(engine, {
    expectedStateId: old.id,
    settings: { maxWorkerCalls: 24 }, expectedSettings: { maxWorkerCalls: old.settings.maxWorkerCalls },
  }, 409);
  assert.equal(engine.getState().settings.maxWorkerCalls, 20);
  assert.deepEqual(calls, []);
});

test('stale boolean expectation cannot overwrite an automatic dispatch change', async (t) => {
  const { engine, calls } = fixture(t);
  await engine.action({ action: 'settings', settings: { autoDispatch: false }, expectedSettings: { autoDispatch: true } });
  await rejectedUnchanged(engine, { settings: { autoDispatch: true }, expectedSettings: { autoDispatch: true } }, 409);
  assert.equal(engine.getState().settings.autoDispatch, false);
  assert.deepEqual(calls, []);
});

test('two windows editing different top level fields merge from the same rendered snapshot', async (t) => {
  const { engine, calls } = fixture(t);
  const old = engine.getState();
  await Promise.all([
    engine.action({ action: 'settings', expectedStateId: old.id, settings: { maxWorkerCalls: 20 }, expectedSettings: { maxWorkerCalls: old.settings.maxWorkerCalls } }),
    engine.action({ action: 'settings', expectedStateId: old.id, settings: { maxSupervisorCalls: 18 }, expectedSettings: { maxSupervisorCalls: old.settings.maxSupervisorCalls } }),
  ]);
  const current = engine.getState();
  assert.equal(current.settings.maxWorkerCalls, 20);
  assert.equal(current.settings.maxSupervisorCalls, 18);
  assert.deepEqual(current.tasks, old.tasks);
  assert.deepEqual(current.messages, old.messages);
  assert.deepEqual(current.usage, old.usage);
  assert.deepEqual(calls, []);
});

test('Codex and DeepSeek budget edits from the same snapshot merge at the provider leaf', async (t) => {
  const { engine, calls } = fixture(t);
  const old = engine.getState();
  await Promise.all([
    engine.action({ action: 'settings', settings: { maxProviderCalls: { codex: 18 } }, expectedSettings: { maxProviderCalls: { codex: old.settings.maxProviderCalls.codex } } }),
    engine.action({ action: 'settings', settings: { maxProviderCalls: { deepseek: 26 } }, expectedSettings: { maxProviderCalls: { deepseek: old.settings.maxProviderCalls.deepseek } } }),
  ]);
  assert.deepEqual(engine.getState().settings.maxProviderCalls, { codex: 18, deepseek: 26 });
  assert.deepEqual(calls, []);
});

test('a stale provider leaf rejects an entire multi field patch atomically', async (t) => {
  const { engine } = fixture(t);
  await engine.action({ action: 'settings', settings: { maxProviderCalls: { codex: 18 } }, expectedSettings: { maxProviderCalls: { codex: 12 } } });
  await rejectedUnchanged(engine, {
    settings: { autoReview: false, maxWorkerCalls: 30, maxProviderCalls: { codex: 20, deepseek: 40 } },
    expectedSettings: { autoReview: true, maxWorkerCalls: 16, maxProviderCalls: { codex: 12, deepseek: 16 } },
  }, 409);
});

test('unrelated chat stream revisions do not invalidate an unchanged settings field', async (t) => {
  const { engine, calls } = fixture(t, { deferred: true });
  const rendered = engine.getState();
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'synthetic stream fixture' });
  await until(engine, () => calls.length === 1);
  calls[0].onDelta('SYNTHETIC_STREAM_DELTA');
  assert.ok(engine.getState().revision > rendered.revision);
  assert.ok(engine.getState().messages.some((message) => message.text === 'SYNTHETIC_STREAM_DELTA'));
  const beforeSave = engine.getState();
  await engine.action({ action: 'settings', expectedStateId: rendered.id, settings: { maxWorkerCalls: 20 }, expectedSettings: { maxWorkerCalls: rendered.settings.maxWorkerCalls } });
  assert.equal(engine.getState().settings.maxWorkerCalls, 20);
  assert.deepEqual(engine.getState().messages, beforeSave.messages);
  assert.deepEqual(engine.getState().usage, beforeSave.usage);
  assert.equal(calls.length, 1, 'saving settings must not start another provider run');
});

test('malformed, unknown, empty, and array patches reject atomically before applying valid siblings', async (t) => {
  const { engine, calls } = fixture(t);
  const cases = [
    undefined, null, [], {}, 'settings',
    { unknownBudget: 20 },
    { maxWorkerCalls: 20, unknownBudget: 20 },
    { maxWorkerCalls: 20, autoReview: 'false' },
    { maxWorkerCalls: 20, autoDispatch: 1 },
    { maxWorkerCalls: 20, maxRetries: -1 },
    { maxWorkerCalls: 20, maxRetries: 21 },
    { maxWorkerCalls: 20, maxReviewRetries: 11 },
    { maxWorkerCalls: 20, maxSupervisorCalls: 0 },
    { maxWorkerCalls: 20, maxSupervisorCalls: 2001 },
    { maxWorkerCalls: 20.5 },
    { maxWorkerCalls: '20' },
    { maxParallelReaders: 0 },
    { maxParallelReaders: 5 },
    { maxProviderCalls: null },
    { maxProviderCalls: [] },
    { maxProviderCalls: {} },
    { maxProviderCalls: { codex: 20, other: 30 } },
    { maxProviderCalls: { codex: 20, deepseek: 0 } },
    { maxProviderCalls: { codex: 20, deepseek: 2001 } },
    { maxProviderCalls: { codex: 20, deepseek: '16' } },
  ];
  for (const settings of cases) await rejectedUnchanged(engine, { settings }, 400);
  assert.deepEqual(calls, []);
});

test('malformed or nonmatching expected fields reject with 400 rather than overwriting settings', async (t) => {
  const { engine, calls } = fixture(t);
  const settings = { maxWorkerCalls: 20, maxProviderCalls: { codex: 18 } };
  const cases = [
    undefined, null, [], {}, 'expected',
    { maxWorkerCalls: 16 },
    { maxWorkerCalls: 16, maxProviderCalls: { deepseek: 16 } },
    { maxWorkerCalls: 16, maxProviderCalls: { codex: 12, deepseek: 16 } },
    { maxWorkerCalls: 16, maxProviderCalls: { codex: 12 }, autoReview: true },
    { maxWorkerCalls: '16', maxProviderCalls: { codex: 12 } },
    { maxWorkerCalls: 16, maxProviderCalls: [] },
    { maxWorkerCalls: 16, maxProviderCalls: { codex: 0 } },
    { maxWorkerCalls: 16, maxProviderCalls: { codex: 12 }, unknownBudget: 1 },
  ];
  for (const expectedSettings of cases) await rejectedUnchanged(engine, { settings, expectedSettings }, 400);
  assert.deepEqual(calls, []);
});

test('a malformed new value is validated before stale expectation comparison', async (t) => {
  const { engine } = fixture(t);
  await rejectedUnchanged(engine, {
    settings: { maxWorkerCalls: 0 }, expectedSettings: { maxWorkerCalls: 15 },
  }, 400);
});

test('legacy callers without expectedSettings still update valid partial settings', async (t) => {
  const { engine, calls } = fixture(t);
  await engine.action({ action: 'settings', settings: { autoReview: false, maxRetries: 0, maxReviewRetries: 10, maxParallelReaders: 4, maxProviderCalls: { deepseek: 2000 } } });
  const current = engine.getState();
  assert.equal(current.settings.autoReview, false);
  assert.equal(current.settings.maxRetries, 0);
  assert.equal(current.settings.maxReviewRetries, 10);
  assert.equal(current.settings.maxParallelReaders, 4);
  assert.deepEqual(current.settings.maxProviderCalls, { codex: 12, deepseek: 2000 });
  assert.deepEqual(calls, []);
});

test('stale state identity still rejects even when all field expectations match', async (t) => {
  const { engine, calls } = fixture(t);
  await rejectedUnchanged(engine, {
    expectedStateId: 'synthetic-other-workspace-session',
    settings: { maxWorkerCalls: 20 }, expectedSettings: { maxWorkerCalls: 16 },
  }, 409);
  assert.deepEqual(calls, []);
});

test('active and retiring readers keep their limit until synthetic processes confirm cleanup', async (t) => {
  const { engine, calls } = fixture(t, { deferred: true });
  await engine.action({ action: 'message', agentId: 'codex-supervisor', text: 'synthetic left readonly' });
  await engine.action({ action: 'message', agentId: 'deepseek-builder', text: 'synthetic right readonly' });
  await until(engine, (state) => calls.length === 2 && state.executionSummary.readers === 2);
  const payload = { settings: { maxParallelReaders: 1, autoReview: false }, expectedSettings: { maxParallelReaders: 3, autoReview: true } };
  await rejectedUnchanged(engine, payload, 409);
  assert.equal(calls.length, 2);
  await engine.action({ action: 'cancelChat', agentId: 'codex-supervisor' });
  await engine.action({ action: 'cancelChat', agentId: 'deepseek-builder' });
  assert.equal(engine.getState().executionSummary.retiringReaders, 2);
  await rejectedUnchanged(engine, payload, 409);
  calls[0].confirmStopped();
  calls[1].confirmStopped();
  await until(engine, (state) => state.executionSummary.readers === 0);
  await engine.action({ action: 'settings', ...payload });
  assert.equal(engine.getState().settings.maxParallelReaders, 1);
  assert.equal(engine.getState().settings.autoReview, false);
  assert.equal(calls.length, 2, 'a settings save must not restart stopped processes');
});
