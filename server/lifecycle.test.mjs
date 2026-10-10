import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, createInitialState } from './engine.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const isClosed = error => error.status === 503 && /已关闭/.test(error.message);
const available = { codex: { available: true }, harness: { available: true } };
const brief = { objective: 'fixture objective', deliverables: 'fixture output', acceptance: 'fixture evidence', constraints: '', questions: '' };

function liveState() {
  const state = createInitialState();
  state.mode = 'live'; state.collaborationMode = 'cooperative'; state.phase = 'paused';
  return state;
}

test('closing during capability preflight rejects late actions without changing the closed snapshot', { timeout: 4000 }, async t => {
  for (const action of ['start', 'resume', 'message', 'unavailable-message', 'cooperativeGoal', 'review']) {
    await t.test(action, async t => {
      const entered = deferred(), result = deferred(); let modelCalls = 0;
      const initialState = liveState();
      if (action === 'review') { initialState.tasks[0].status = 'reviewing'; initialState.tasks[0].output = 'retained fixture output'; }
      const engine = new Orchestrator({ initialState, providers: {
        getCapabilities: () => { entered.resolve(); return result.promise; },
        runAgent: () => { modelCalls++; assert.fail('closed actions must not invoke a model'); },
      } });
      t.after(async () => { result.resolve(available); await engine.close(); });
      const payload = action.includes('message') ? { action: 'message', agentId: initialState.agents[1].id, text: 'fixture message' }
        : action === 'cooperativeGoal' ? { action, text: 'replacement fixture goal' }
          : action === 'review' ? { action, taskId: initialState.tasks[0].id } : { action };
      const rejected = assert.rejects(engine.action(payload), isClosed);
      await entered.promise;
      const queued = assert.rejects(engine.action({ action: 'goal', text: 'queued fixture goal' }), isClosed);
      // Closing must finish while the capabilities promise remains unresolved.
      assert.equal(await engine.close(), true);
      const closed = engine.getState();
      result.resolve(action === 'unavailable-message' ? { codex: { available: false }, harness: { available: false } } : available);
      await rejected; await queued;
      assert.deepEqual(engine.getState(), closed);
      assert.equal(modelCalls, 0);
      assert.equal(engine.forceDispatch, false);
      assert.equal(engine.runs.size, 0);
      assert.equal(engine.pumpScheduled, false);
      assert.equal(engine.providerAvailability, undefined);
    });
  }
});

test('closing during a model catalog read cannot add members, change identity, or replace sessions', { timeout: 4000 }, async t => {
  for (const action of ['agentAdd', 'agentUpdate', 'model', 'catalog-error']) {
    await t.test(action, async t => {
      const entered = deferred(), result = deferred(); let modelCalls = 0;
      const engine = new Orchestrator({ initialState: liveState(), providers: {
        getModels: () => { entered.resolve(); return result.promise; },
        getCapabilities: () => assert.fail('configuration must not request capabilities'),
        runAgent: () => { modelCalls++; assert.fail('configuration must not invoke a model'); },
      } });
      t.after(async () => { result.resolve({ available: true, models: [{ id: 'fixture-model' }] }); await engine.close(); });
      const agentId = engine.getState().agents[1].id;
      const payload = action === 'agentAdd' || action === 'catalog-error' ? { action: 'agentAdd', agent: { name: 'fixture member', provider: 'codex', modelId: 'fixture-model' } }
        : action === 'agentUpdate' ? { action, agentId, agent: { name: 'fixture renamed member', modelId: 'fixture-model' } }
          : { action, agentId, model: 'fixture-model' };
      const rejected = assert.rejects(engine.action(payload), isClosed);
      await entered.promise;
      assert.equal(await engine.close(), true);
      const closed = engine.getState();
      if (action === 'catalog-error') result.reject(new Error('fixture catalog unavailable'));
      else result.resolve({ available: true, models: [{ id: 'fixture-model' }] });
      await rejected;
      assert.deepEqual(engine.getState(), closed);
      assert.equal(modelCalls, 0);
      assert.equal(engine.runs.size, 0);
      assert.equal(engine.pumpScheduled, false);
    });
  }
});

function memoryPersistence() {
  const persistencePath = join(tmpdir(), `relay-lifecycle-memory-${randomUUID()}.json`);
  const files = new Map(); let fail = false, gate;
  return {
    persistencePath, files,
    failNextWrite() { fail = true; },
    delayNextWrite() { gate = { entered: deferred(), release: deferred() }; return gate; },
    fileOps: {
      mkdir: async () => {},
      writeFile: async (path, text) => files.set(path, text),
      unlink: async path => files.delete(path),
      rename: async (source, target) => {
        if (fail) { fail = false; throw Object.assign(new Error('fixture locked write'), { code: 'EPERM' }); }
        if (gate) { const pending = gate; gate = undefined; pending.entered.resolve(); await pending.release.promise; }
        files.set(target, files.get(source)); files.delete(source);
      },
    },
  };
}

test('closing during persistence waits does not acknowledge a late save or continue a recovered action', { timeout: 4000 }, async t => {
  for (const action of ['saveGoalBrief', 'retrySave', 'start']) {
    await t.test(action, async t => {
      const persistence = memoryPersistence(); let capabilityCalls = 0, modelCalls = 0;
      const engine = new Orchestrator({ initialState: liveState(), persistencePath: persistence.persistencePath, fileOps: persistence.fileOps, persistenceRetryDelays: [], providers: {
        getCapabilities: () => { capabilityCalls++; return available; },
        runAgent: () => { modelCalls++; assert.fail('closed actions must not invoke a model'); },
      } });
      await engine.flushPersistence();
      if (action !== 'saveGoalBrief') {
        persistence.failNextWrite();
        await engine.action({ action: 'goal', text: 'fixture recoverable goal' });
        assert.equal(await engine.flushPersistence(), false);
      }
      const delayed = persistence.delayNextWrite();
      t.after(async () => { delayed.release.resolve(); await engine.close(); });
      const payload = action === 'saveGoalBrief' ? { action, expectedRevision: 0, brief } : { action };
      const rejected = assert.rejects(engine.action(payload), isClosed);
      await delayed.entered.promise;
      const closing = engine.close(); delayed.release.resolve();
      await rejected; assert.equal(await closing, true);
      const saved = JSON.parse(persistence.files.get(persistence.persistencePath));
      assert.equal(saved.phase, engine.getState().phase);
      assert.notEqual(saved.phase, 'running');
      assert.equal(capabilityCalls, 0); assert.equal(modelCalls, 0);
      assert.equal(engine.forceDispatch, false); assert.equal(engine.runs.size, 0);
      assert.equal(engine.pumpScheduled, false);
      assert.deepEqual(saved.usage, liveState().usage);
      if (action === 'saveGoalBrief') {
        assert.equal(saved.goalDraft.revision, 1);
        assert.equal(saved.goalDraft.objective, brief.objective);
      }
    });
  }
});
