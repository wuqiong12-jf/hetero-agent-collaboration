import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRecovery } from './recovery.mjs';

function task(overrides = {}) {
  return { id: 'origin', title: 'Origin task', status: 'queued', agentId: 'builder', attempt: 0,
    reviewAttempts: 0, dependsOn: [], criteria: [{ id: 'proof', text: 'Original proof', status: 'pending' }], ...overrides };
}
function fixture(overrides = {}) {
  return { revision: 41, phase: 'paused', mode: 'live', collaborationMode: 'cooperative', goal: 'A saved cooperative goal',
    leaderId: 'leader', agents: [{ id: 'leader', name: 'Monitor', provider: 'codex', status: 'idle' },
      { id: 'builder', name: 'Builder', provider: 'deepseek', accessMode: 'workspace-write', status: 'idle' }],
    settings: { autoReview: true, autoDispatch: true, maxSupervisorCalls: 12, maxWorkerCalls: 16,
      maxRetries: 2, maxReviewRetries: 1, maxProviderCalls: { codex: 12, deepseek: 16 } },
    usage: { supervisorCalls: 0, workerCalls: 0, autoSupervisorCalls: 0, autoWorkerCalls: 0,
      providerCalls: { codex: 0, deepseek: 0 }, autoProviderCalls: { codex: 0, deepseek: 0 } },
    tasks: [task()], activity: [], pendingCleanup: [], ...overrides };
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
const codes = (issues) => issues.map((issue) => issue.code);
const keys = (step) => step.issues.filter((issue) => issue.settingKey).map((issue) => issue.settingKey);

test('a frozen snapshot and context stay unchanged, and repeated descriptions have the same DTO', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', attempt: 1, output: 'RETAINED', reviewAttempts: 1, reviewError: 'Prior failed review' })], error: 'Prior warning' });
  const context = { workerCount: 1, taskActors: { origin: state.agents[1] }, activeCount: 0 };
  const before = structuredClone({ state, context });
  deepFreeze(state); deepFreeze(context);
  const summary = describeRecovery(state, context);
  assert.deepEqual(describeRecovery(state, context), summary);
  assert.deepEqual({ state, context }, before);
  assert.equal(summary.sourceRevision, 41);
  assert.equal(summary.lastError, 'Prior warning');
  assert.equal(summary.steps[0].nextAction, 'review-output');
  assert.equal(summary.steps[0].hasOutput, true);
  assert.equal(summary.steps[0].reviewAttempts, 1);
  assert.equal(summary.steps[0].interrupted, false);
  summary.steps[0].issues.push({ code: 'caller-change' });
  assert.deepEqual({ state, context }, before);
});

test('closed services cannot resume and do not suggest releasing cleanup locks', () => {
  const summary = describeRecovery(fixture(), { closed: true });
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['service-closed']);
  assert.equal(summary.globalIssues[0].action, 'none');
});

test('unconfirmed cleanup is a permanent distinct barrier whether reported by context or saved state', () => {
  for (const [state, context] of [[fixture(), { cleanupUnconfirmed: true }], [fixture({ pendingCleanup: [{ runId: 'old', reason: 'adapter-cleanup-unconfirmed' }] }), {}]]) {
    const summary = describeRecovery(state, context);
    assert.equal(summary.resume.allowed, false);
    assert.deepEqual(codes(summary.globalIssues), ['cleanup-unconfirmed']);
    assert.equal(summary.globalIssues[0].action, 'none');
    assert.match(summary.globalIssues[0].detail, /没有解除此锁的接口/);
  }
});

test('ordinary stopping is a wait barrier and clears when the context no longer reports it', () => {
  const state = fixture();
  const summary = describeRecovery(state, { stoppingCount: 2 });
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['stopping']);
  assert.equal(summary.globalIssues[0].action, 'wait');
  assert.match(summary.globalIssues[0].detail, /不代表已经退出/);
  assert.equal(describeRecovery(state, { stoppingCount: 0 }).resume.allowed, true);
});

test('a blocked workflow with active executions waits without claiming executions have stopped', () => {
  const summary = describeRecovery(fixture({ phase: 'blocked' }), { activeCount: 2 });
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['active-execution']);
  assert.equal(summary.globalIssues[0].action, 'wait');
  assert.match(summary.globalIssues[0].detail, /不代表这些执行已停止/);
  assert.equal(describeRecovery(fixture({ phase: 'blocked' }), { activeCount: 0 }).resume.allowed, true);
});

test('live chat workspace occupancy is supplied by context rather than old chat session labels', () => {
  const state = fixture({ chatSessions: { leader: { status: 'running' } } });
  assert.equal(describeRecovery(state).resume.allowed, true);
  const busy = describeRecovery(state, { chatBusy: true });
  assert.equal(busy.resume.allowed, false);
  assert.deepEqual(codes(busy.globalIssues), ['chat-busy']);
  assert.equal(busy.globalIssues[0].action, 'wait');
  const demo = describeRecovery(fixture({ mode: 'demo' }), { chatBusy: false, activeCount: 0 });
  assert.equal(demo.resume.allowed, true);
  assert.equal(demo.resume.needsCapabilityCheck, false);
});

test('persistence failure requires saving and never erases a simultaneous cleanup barrier', () => {
  const summary = describeRecovery(fixture(), { persistenceFailed: true, cleanupUnconfirmed: true });
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['cleanup-unconfirmed', 'persistence-failed']);
  assert.equal(summary.globalIssues[1].action, 'retry-save');
  assert.match(summary.globalIssues[1].detail, /保存成功后仍保持暂停/);
  const afterSave = describeRecovery(fixture(), { persistenceFailed: false, cleanupUnconfirmed: true });
  assert.deepEqual(codes(afterSave.globalIssues), ['cleanup-unconfirmed']);
  assert.equal(afterSave.resume.allowed, false);
});

test('cooperation disabled and an empty goal are independent structural gates', () => {
  const summary = describeRecovery(fixture({ collaborationMode: 'independent', goal: ' \n ' }));
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['cooperation-disabled', 'goal-empty']);
  assert.deepEqual(summary.globalIssues.map((issue) => issue.action), ['cooperation', 'goal']);
});

test('running and completed phases prohibit duplicate execution, while live capability checks stay separate', () => {
  for (const phase of ['running', 'completed']) {
    const summary = describeRecovery(fixture({ phase }));
    assert.equal(summary.resume.allowed, false);
    assert.equal(summary.resume.needsCapabilityCheck, true);
  }
  for (const phase of ['idle', 'paused', 'blocked']) assert.equal(describeRecovery(fixture({ phase })).resume.allowed, true);
});

test('all progress statuses are counted from the current graph in task order', () => {
  const statuses = ['accepted', 'reviewing', 'queued', 'rejected', 'running', 'cancelled'];
  const summary = describeRecovery(fixture({ tasks: statuses.map((status, index) => task({ id: `task-${index}`, status })) }));
  assert.deepEqual(summary.progress, { accepted: 1, reviewing: 1, queued: 1, rejected: 1, running: 1, cancelled: 1 });
  assert.deepEqual(summary.steps.map((step) => step.taskId), statuses.map((_, index) => `task-${index}`));
  assert.equal(summary.steps[4].nextAction, 'wait-running');
  assert.deepEqual(keys(summary.steps[4]), []);
});

test('a retained delivery can be reviewed even when worker calls and retry budgets are exhausted', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', attempt: 7, output: 'SAME_OUTPUT' })] });
  state.settings.maxWorkerCalls = 0;
  state.settings.maxRetries = 0;
  const summary = describeRecovery(state, { workerCount: 0 });
  assert.equal(summary.steps[0].nextAction, 'review-output');
  assert.equal(summary.steps[0].hasOutput, true);
  assert.deepEqual(keys(summary.steps[0]), []);
  assert.deepEqual(summary.globalIssues, []);
  assert.equal(summary.resume.allowed, true);
});

test('a review uses only monitor calls, the current leader provider, and review attempt limits', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', attempt: 9, reviewAttempts: 2, output: 'DELIVERY' })] });
  state.settings.maxSupervisorCalls = 0;
  state.settings.maxWorkerCalls = 0;
  state.settings.maxRetries = 0;
  state.settings.maxProviderCalls.codex = 0;
  state.settings.maxProviderCalls.deepseek = 0;
  const summary = describeRecovery(state);
  assert.deepEqual(keys(summary.steps[0]), ['maxSupervisorCalls', 'maxProviderCalls.codex', 'maxReviewRetries']);
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['next-order-blocked']);
  state.leaderId = 'builder';
  const afterHandoff = describeRecovery(state);
  assert.deepEqual(keys(afterHandoff.steps[0]), ['maxSupervisorCalls', 'maxProviderCalls.deepseek', 'maxReviewRetries']);
  assert.equal(state.tasks[0].reviewAttempts, 2);
});

test('review retries include the first call plus configured extra calls', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', reviewAttempts: 1, output: 'DELIVERY' })] });
  assert.deepEqual(keys(describeRecovery(state).steps[0]), []);
  state.settings.maxReviewRetries = 0;
  assert.deepEqual(keys(describeRecovery(state).steps[0]), ['maxReviewRetries']);
  state.settings.maxReviewRetries = 1;
  state.tasks[0].reviewAttempts = 2;
  assert.deepEqual(keys(describeRecovery(state).steps[0]), ['maxReviewRetries']);
});

test('a rejected worker action uses its actual actor provider and only worker/retry limits', () => {
  const state = fixture({ tasks: [task({ status: 'rejected', attempt: 3, output: 'OLD_DELIVERY' })] });
  state.settings.maxSupervisorCalls = 0;
  state.settings.maxWorkerCalls = 0;
  state.settings.maxReviewRetries = 0;
  state.settings.maxProviderCalls.codex = 0;
  state.settings.maxProviderCalls.deepseek = 0;
  const actualActor = { id: 'actual', name: 'Actual fallback worker', provider: 'codex', accessMode: 'read-only', status: 'idle' };
  const summary = describeRecovery(state, { taskActors: { origin: actualActor } });
  assert.equal(summary.steps[0].nextAction, 'run-worker');
  assert.deepEqual(keys(summary.steps[0]), ['maxWorkerCalls', 'maxProviderCalls.codex', 'maxRetries']);
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['next-order-blocked']);
  state.tasks[0].attempt = 2;
  assert.deepEqual(keys(describeRecovery(state, { taskActors: { origin: actualActor } }).steps[0]), ['maxWorkerCalls', 'maxProviderCalls.codex']);
});

test('a queued step that previously started warns through interrupted without acquiring a rejected retry limit', () => {
  const state = fixture({ tasks: [task({ attempt: 4, output: 'INTERRUPTED_PARTIAL_OUTPUT' })] });
  state.settings.maxRetries = 0;
  const summary = describeRecovery(state);
  assert.equal(summary.steps[0].interrupted, true);
  assert.equal(summary.steps[0].attempt, 4);
  assert.equal(summary.steps[0].hasOutput, true);
  assert.equal(summary.steps[0].nextAction, 'run-worker');
  assert.deepEqual(keys(summary.steps[0]), []);
});

test('retained deliveries awaiting review and running executions are never labelled interrupted', () => {
  for (const phase of ['paused', 'running', 'blocked']) {
    const summary = describeRecovery(fixture({ phase, tasks: [task({ status: 'reviewing', attempt: 1, reviewAttempts: 1, output: 'DELIVERY' }),
      task({ id: 'in-progress', status: 'running', attempt: 1, output: 'PARTIAL' })] }));
    assert.equal(summary.steps[0].interrupted, false);
    assert.equal(summary.steps[0].nextAction, 'review-output');
    assert.equal(summary.steps[1].interrupted, false);
    assert.equal(summary.steps[1].nextAction, 'wait-running');
  }
});

test('unaccepted dependencies gate downstream work before checking downstream budgets or its actor', () => {
  for (const status of ['queued', 'running', 'reviewing', 'rejected', 'cancelled']) {
    const state = fixture({ tasks: [task({ status, output: 'EXISTS_BUT_NOT_ACCEPTED' }), task({ id: 'downstream', status: 'rejected', attempt: 10, dependsOn: ['origin'] })] });
    state.settings.maxWorkerCalls = 0;
    state.settings.maxProviderCalls.deepseek = 0;
    state.settings.maxRetries = 0;
    const step = describeRecovery(state, { taskActors: {} }).steps[1];
    assert.equal(step.nextAction, 'wait-dependencies');
    assert.deepEqual(codes(step.issues), ['dependencies-not-accepted']);
    assert.deepEqual(keys(step), []);
  }
  const missing = describeRecovery(fixture({ tasks: [task({ dependsOn: ['missing'] })] })).steps[0];
  assert.equal(missing.nextAction, 'wait-dependencies');
  assert.match(missing.issues[0].detail, /missing/);
  const accepted = describeRecovery(fixture({ tasks: [task({ status: 'accepted' }), task({ id: 'downstream', dependsOn: ['origin'] })] })).steps[1];
  assert.equal(accepted.nextAction, 'run-worker');
});

test('accepted and cancelled steps never acquire budget, dependency or missing actor issues', () => {
  const state = fixture({ tasks: ['accepted', 'cancelled'].map((status) => task({ id: status, status, attempt: 99, reviewAttempts: 99, dependsOn: ['missing'] })) });
  Object.assign(state.settings, { maxWorkerCalls: 0, maxSupervisorCalls: 0, maxRetries: 0, maxReviewRetries: 0, maxProviderCalls: { codex: 0, deepseek: 0 } });
  const summary = describeRecovery(state, { taskActors: {}, workerCount: 0 });
  for (const step of summary.steps) {
    assert.equal(step.nextAction, step.status);
    assert.deepEqual(step.issues, []);
    assert.equal(step.interrupted, false);
  }
});

test('an explicitly missing actual actor prompts team repair rather than inventing provider availability', () => {
  const state = fixture();
  state.settings.maxProviderCalls.deepseek = 0;
  const step = describeRecovery(state, { taskActors: {} }).steps[0];
  assert.deepEqual(codes(step.issues), ['no-worker']);
  assert.equal(step.issues[0].action, 'team');
  assert.deepEqual(keys(step), []);
  assert.deepEqual(keys(describeRecovery(state).steps[0]), ['maxProviderCalls.deepseek']);
});

test('an empty graph uses the actual worker pool count, while existing review work needs no worker pool', () => {
  const summary = describeRecovery(fixture({ tasks: [] }), { workerCount: 0 });
  assert.deepEqual(codes(summary.globalIssues), ['no-workers']);
  assert.equal(summary.globalIssues[0].action, 'team');
  assert.equal(summary.resume.allowed, false);
  assert.equal(describeRecovery(fixture({ tasks: [] }), { workerCount: 1 }).resume.allowed, true);
  assert.equal(describeRecovery(fixture({ tasks: [task({ status: 'reviewing', output: 'DELIVERY' })] }), { workerCount: 0 }).resume.allowed, true);
});

test('an empty graph checks only budgets for planning through the current leader', () => {
  const state = fixture({ tasks: [] });
  state.settings.maxWorkerCalls = 0;
  state.settings.maxRetries = 0;
  state.settings.maxReviewRetries = 0;
  state.settings.maxProviderCalls.deepseek = 0;
  assert.deepEqual(describeRecovery(state).globalIssues, []);
  assert.equal(describeRecovery(state).resume.allowed, true);
  state.settings.maxSupervisorCalls = 0;
  state.settings.maxProviderCalls.codex = 0;
  const summary = describeRecovery(state);
  assert.deepEqual(codes(summary.globalIssues), ['supervisor-budget', 'provider-budget']);
  assert.deepEqual(summary.globalIssues.map((issue) => issue.settingKey), ['maxSupervisorCalls', 'maxProviderCalls.codex']);
  assert.match(summary.globalIssues[0].detail, /规划新任务/);
  assert.equal(summary.resume.allowed, false);
  state.leaderId = 'builder';
  assert.deepEqual(describeRecovery(state).globalIssues.map((issue) => issue.settingKey), ['maxSupervisorCalls', 'maxProviderCalls.deepseek']);
  state.phase = 'running';
  assert.deepEqual(describeRecovery(state).globalIssues, []);
});

test('an all-cancelled graph prompts a new goal instead of resuming an empty running workflow', () => {
  const summary = describeRecovery(fixture({ tasks: [task({ status: 'cancelled' }), task({ id: 'another', status: 'cancelled' })] }));
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['no-pending-tasks']);
  assert.equal(summary.globalIssues[0].action, 'goal');
  assert.equal(summary.progress.cancelled, 2);
  assert.ok(summary.steps.every((step) => step.nextAction === 'cancelled' && step.issues.length === 0));
});

test('review-only work with exhausted monitor, provider, or per-delivery review limits cannot resume into another block', () => {
  for (const exhausted of ['monitor', 'provider', 'review-attempts']) {
    const state = fixture({ tasks: [task({ status: 'reviewing', output: 'RETAINED_DELIVERY' })] });
    if (exhausted === 'monitor') state.settings.maxSupervisorCalls = 0;
    if (exhausted === 'provider') state.settings.maxProviderCalls.codex = 0;
    if (exhausted === 'review-attempts') state.tasks[0].reviewAttempts = 2;
    const summary = describeRecovery(state);
    assert.equal(summary.resume.allowed, false);
    assert.deepEqual(codes(summary.globalIssues), ['next-order-blocked']);
    assert.equal(summary.globalIssues[0].action, 'settings');
    assert.equal(summary.steps[0].hasOutput, true);
    assert.equal(summary.steps[0].nextAction, 'review-output');
    assert.match(summary.globalIssues[0].detail, /不表示其他执行已经停止/);
  }
});

test('a usable review can advance when only read-only worker actions need budget repairs', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', output: 'DELIVERY' }), task({ id: 'needs-worker' })] });
  state.agents[1].accessMode = 'read-only';
  state.settings.maxWorkerCalls = 0;
  state.settings.maxRetries = 0;
  state.settings.maxProviderCalls.deepseek = 0;
  const summary = describeRecovery(state);
  assert.equal(summary.resume.allowed, true);
  assert.deepEqual(summary.globalIssues, []);
  assert.deepEqual(summary.steps[0].issues, []);
  assert.deepEqual(keys(summary.steps[1]), ['maxWorkerCalls', 'maxProviderCalls.deepseek']);
});

test('a usable worker action can advance when other review actions need monitor budget repairs', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', output: 'DELIVERY', reviewAttempts: 2 }), task({ id: 'ready-worker' })] });
  state.settings.maxSupervisorCalls = 0;
  state.settings.maxProviderCalls.codex = 0;
  const summary = describeRecovery(state);
  assert.equal(summary.resume.allowed, true);
  assert.deepEqual(summary.globalIssues, []);
  assert.deepEqual(keys(summary.steps[0]), ['maxSupervisorCalls', 'maxProviderCalls.codex', 'maxReviewRetries']);
  assert.deepEqual(summary.steps[1].issues, []);
});

test('a ready writer with exhausted calls prevents a usable retained delivery from auto reviewing first', () => {
  for (const exhausted of ['worker', 'provider']) {
    const state = fixture({ tasks: [task({ status: 'reviewing', output: 'DELIVERY' }), task({ id: 'priority-writer', title: 'Priority writer' })] });
    if (exhausted === 'worker') state.settings.maxWorkerCalls = 0;
    else state.settings.maxProviderCalls.deepseek = 0;
    const summary = describeRecovery(state);
    assert.equal(summary.resume.allowed, false);
    assert.deepEqual(codes(summary.globalIssues), ['next-order-blocked']);
    assert.equal(summary.globalIssues[0].settingKey, exhausted === 'worker' ? 'maxWorkerCalls' : 'maxProviderCalls.deepseek');
    assert.match(summary.globalIssues[0].detail, /Priority writer/);
    assert.deepEqual(summary.steps[0].issues, []);
  }
});

test('the first reviewing delivery blocks before an otherwise usable read-only worker can start', () => {
  for (const exhausted of ['monitor', 'review-attempts']) {
    const state = fixture({ tasks: [task({ status: 'reviewing', title: 'Priority review', output: 'DELIVERY' }), task({ id: 'ready-reader' })] });
    state.agents[1].accessMode = 'read-only';
    if (exhausted === 'monitor') state.settings.maxSupervisorCalls = 0;
    else state.tasks[0].reviewAttempts = 2;
    const summary = describeRecovery(state);
    assert.equal(summary.resume.allowed, false);
    assert.deepEqual(codes(summary.globalIssues), ['next-order-blocked']);
    assert.equal(summary.globalIssues[0].settingKey, exhausted === 'monitor' ? 'maxSupervisorCalls' : 'maxReviewRetries');
    assert.match(summary.globalIssues[0].detail, /Priority review/);
    assert.deepEqual(summary.steps[1].issues, []);
  }
});

test('an exhausted first review cannot be bypassed by a later usable reviewing delivery', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', title: 'First review', reviewAttempts: 2, output: 'FIRST' }),
    task({ id: 'second-review', status: 'reviewing', output: 'SECOND' })] });
  const summary = describeRecovery(state);
  assert.equal(summary.resume.allowed, false);
  assert.equal(summary.globalIssues[0].code, 'next-order-blocked');
  assert.equal(summary.globalIssues[0].settingKey, 'maxReviewRetries');
  assert.match(summary.globalIssues[0].detail, /First review/);
  assert.deepEqual(summary.steps[1].issues, []);
});

test('a rejected retry cap blocks the worker pass before unaccepted dependencies are checked', () => {
  const state = fixture({ tasks: [task({ status: 'rejected', title: 'Capped dependent', attempt: 3, dependsOn: ['unaccepted'] }),
    task({ id: 'ready-writer' }), task({ id: 'unaccepted', status: 'reviewing', output: 'DELIVERY' })] });
  const summary = describeRecovery(state);
  assert.equal(summary.steps[0].nextAction, 'wait-dependencies');
  assert.deepEqual(keys(summary.steps[0]), []);
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['next-order-blocked']);
  assert.equal(summary.globalIssues[0].settingKey, 'maxRetries');
  assert.match(summary.globalIssues[0].detail, /Capped dependent/);
  assert.match(summary.globalIssues[0].detail, /依赖尚未验收/);
});

test('a rejected read-only retry cap still blocks before writer-fairness skips its dispatch', () => {
  const state = fixture({ tasks: [task({ status: 'rejected', attempt: 3, title: 'Capped reader' }), task({ id: 'busy-writer' })] });
  const context = { taskActors: {
    origin: { id: 'reader', provider: 'deepseek', accessMode: 'read-only', status: 'idle' },
    'busy-writer': { id: 'writer', provider: 'deepseek', accessMode: 'workspace-write', status: 'running' },
  } };
  const summary = describeRecovery(state, context);
  assert.equal(summary.resume.allowed, false);
  assert.equal(summary.globalIssues[0].settingKey, 'maxRetries');
  assert.match(summary.globalIssues[0].detail, /Capped reader/);
});

test('the first ready writer provider budget cannot be bypassed by a later usable writer', () => {
  const state = fixture({ tasks: [task({ title: 'First writer' }), task({ id: 'second-writer' })] });
  state.settings.maxProviderCalls.codex = 0;
  const context = { taskActors: {
    origin: { id: 'writer-codex', provider: 'codex', accessMode: 'workspace-write', status: 'idle' },
    'second-writer': { id: 'writer-deepseek', provider: 'deepseek', accessMode: 'workspace-write', status: 'idle' },
  } };
  const summary = describeRecovery(state, context);
  assert.equal(summary.resume.allowed, false);
  assert.equal(summary.globalIssues[0].settingKey, 'maxProviderCalls.codex');
  assert.match(summary.globalIssues[0].detail, /First writer/);
  assert.deepEqual(summary.steps[1].issues, []);
});

test('live writer ordering skips an earlier read-only budget issue when a usable writer starts first', () => {
  const state = fixture({ tasks: [task({ title: 'Earlier reader' }), task({ id: 'ready-writer' })] });
  state.settings.maxProviderCalls.codex = 0;
  const context = { taskActors: {
    origin: { id: 'reader-codex', provider: 'codex', accessMode: 'read-only', status: 'idle' },
    'ready-writer': { id: 'writer-deepseek', provider: 'deepseek', accessMode: 'workspace-write', status: 'idle' },
  } };
  assert.equal(describeRecovery(state, context).resume.allowed, true);
  state.mode = 'demo';
  const demo = describeRecovery(state, context);
  assert.equal(demo.resume.allowed, false);
  assert.equal(demo.globalIssues[0].settingKey, 'maxProviderCalls.codex');
});

test('a busy writer suppresses auto review and ready readers until the writer can enter', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', output: 'DELIVERY' }), task({ id: 'waiting-writer' }), task({ id: 'ready-reader' })] });
  const context = { taskActors: {
    'waiting-writer': { id: 'writer', provider: 'deepseek', accessMode: 'workspace-write', status: 'running' },
    'ready-reader': { id: 'reader', provider: 'deepseek', accessMode: 'read-only', status: 'idle' },
  } };
  const summary = describeRecovery(state, context);
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['no-automatic-step']);
});

test('a usable worker with no reviewing task ignores exhausted monitor calls even when auto dispatch is off', () => {
  const state = fixture();
  state.settings.maxSupervisorCalls = 0;
  state.settings.maxProviderCalls.codex = 0;
  state.settings.autoDispatch = false;
  assert.equal(describeRecovery(state).resume.allowed, true);
});

test('an actual first review start remains progress even if a later worker retry cap would block that same pass', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', output: 'DELIVERY' }), task({ id: 'capped-reader', status: 'rejected', attempt: 3 })] });
  state.agents[1].accessMode = 'read-only';
  const summary = describeRecovery(state);
  assert.equal(summary.resume.allowed, true);
  assert.deepEqual(summary.globalIssues, []);
});

test('a budget is not reported as an immediate scheduler stop while workspace occupancy prevents entry', () => {
  const state = fixture({ executionSummary: { readers: 1, writers: 0 } });
  state.settings.maxWorkerCalls = 0;
  const summary = describeRecovery(state);
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['no-automatic-step']);
  const review = fixture({ executionSummary: { readers: 0, writers: 1 }, tasks: [task({ status: 'reviewing', reviewAttempts: 2, output: 'DELIVERY' })] });
  assert.deepEqual(codes(describeRecovery(review).globalIssues), ['no-automatic-step']);
});

test('missing actual actors, dependency-only work, and running-only work have no automatic resume path', () => {
  for (const [tasks, context] of [[[task()], { taskActors: {} }],
    [[task({ dependsOn: ['missing'] })], {}], [[task({ status: 'running', attempt: 1 })], {}]]) {
    const summary = describeRecovery(fixture({ tasks }), context);
    assert.equal(summary.resume.allowed, false);
    assert.deepEqual(codes(summary.globalIssues), ['no-automatic-step']);
    assert.equal(summary.globalIssues[0].action, 'none');
  }
});

test('review-only work with auto review disabled prompts manual review and cannot resume automatically', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', output: 'DELIVERY' })] });
  state.settings.autoReview = false;
  const summary = describeRecovery(state);
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['no-automatic-step']);
  assert.deepEqual(codes(summary.steps[0].issues), ['manual-review']);
  assert.equal(summary.steps[0].hasOutput, true);
});

test('all accepted work can resume solely to mark completion without requiring any model budget', () => {
  const state = fixture({ tasks: [task({ status: 'accepted' }), task({ id: 'also-accepted', status: 'accepted' })] });
  Object.assign(state.settings, { maxWorkerCalls: 0, maxSupervisorCalls: 0, maxRetries: 0, maxReviewRetries: 0, maxProviderCalls: { codex: 0, deepseek: 0 } });
  const summary = describeRecovery(state, { workerCount: 0, taskActors: {} });
  assert.equal(summary.resume.allowed, true);
  assert.deepEqual(summary.globalIssues, []);
  state.phase = 'completed';
  assert.equal(describeRecovery(state).resume.allowed, false);
});

test('an accepted and cancelled graph with no pending steps prompts a new goal instead of resuming', () => {
  const summary = describeRecovery(fixture({ tasks: [task({ status: 'accepted' }), task({ id: 'cancelled', status: 'cancelled' })] }));
  assert.equal(summary.resume.allowed, false);
  assert.deepEqual(codes(summary.globalIssues), ['no-pending-tasks']);
  assert.equal(summary.globalIssues[0].action, 'goal');
  assert.deepEqual(summary.progress, { accepted: 1, reviewing: 0, queued: 0, rejected: 0, running: 0, cancelled: 1 });
});

test('auto review disabled is a task-level manual review hint and does not lock other actions', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', output: 'DELIVERY' }), task({ id: 'fresh' })] });
  state.settings.autoReview = false;
  const summary = describeRecovery(state);
  assert.deepEqual(codes(summary.steps[0].issues), ['manual-review']);
  assert.equal(summary.steps[0].issues[0].action, 'manual-review');
  assert.equal(summary.steps[0].nextAction, 'review-output');
  assert.deepEqual(summary.steps[1].issues, []);
  assert.deepEqual(summary.globalIssues, []);
  assert.equal(summary.resume.allowed, true);
});

test('automatic counters take precedence over aggregate counters from ordinary chatting', () => {
  const state = fixture({ tasks: [task({ status: 'reviewing', output: 'DELIVERY' })] });
  state.usage.supervisorCalls = 300;
  state.usage.workerCalls = 300;
  state.usage.providerCalls = { codex: 300, deepseek: 300 };
  assert.deepEqual(keys(describeRecovery(state).steps[0]), []);
  state.usage.autoSupervisorCalls = 12;
  state.usage.autoProviderCalls.codex = 12;
  assert.deepEqual(keys(describeRecovery(state).steps[0]), ['maxSupervisorCalls', 'maxProviderCalls.codex']);
});

test('legacy snapshots use engine defaults and old usage counters without writing migration fields', () => {
  const state = fixture({ revision: undefined, settings: { maxProviderCalls: { deepseek: 16 } },
    usage: { supervisorCalls: 12, workerCalls: 16, providerCalls: { codex: 12, deepseek: 16 } },
    tasks: [task({ status: 'reviewing', reviewAttempts: undefined, attempt: undefined, output: 'DELIVERY' })] });
  const before = structuredClone(state);
  const summary = describeRecovery(state);
  assert.equal(summary.sourceRevision, 0);
  assert.equal(summary.steps[0].attempt, 0);
  assert.equal(summary.steps[0].reviewAttempts, 0);
  assert.deepEqual(keys(summary.steps[0]), ['maxSupervisorCalls', 'maxProviderCalls.codex']);
  assert.deepEqual(state, before);
  assert.doesNotThrow(() => describeRecovery({}));
  assert.doesNotThrow(() => describeRecovery(null, null));
});

test('last accepted uses a current accepted task and an actual dated activity after the latest boundary', () => {
  const state = fixture({ tasks: [task({ status: 'accepted', title: 'Current graph title' }), task({ id: 'later', status: 'accepted', title: 'Later task' }), task({ id: 'not-accepted' })],
    activity: [{ type: 'accepted', taskId: 'origin', at: '2026-10-01T00:00:00Z' },
      { type: 'goal', at: '2026-10-02T00:00:00Z' },
      { type: 'accepted', taskId: 'origin', at: '2026-10-03T00:00:00Z' },
      { type: 'accepted', taskId: 'later', at: '2026-10-04T00:00:00Z' },
      { type: 'accepted', taskId: 'removed', at: '2026-10-05T00:00:00Z' },
      { type: 'accepted', taskId: 'not-accepted', at: '2026-10-06T00:00:00Z' }] });
  assert.deepEqual(describeRecovery(state).lastAccepted, { taskId: 'later', title: 'Later task', at: '2026-10-04T00:00:00Z' });
  for (const type of ['goal', 'cooperative-goal', 'reset', 'mode']) {
    state.activity.push({ type, at: '2026-10-07T00:00:00Z' });
    assert.equal(describeRecovery(state).lastAccepted, undefined);
    state.activity.pop();
  }
});

test('last accepted never invents a timestamp or treats old graph activity as current success', () => {
  for (const at of [undefined, '', 'invalid-date']) {
    const state = fixture({ tasks: [task({ status: 'accepted' })], activity: [{ type: 'accepted', taskId: 'origin', at }], updatedAt: '2026-10-11T00:00:00Z' });
    const summary = describeRecovery(state);
    assert.equal(summary.lastAccepted, undefined);
    assert.equal(Object.hasOwn(summary, 'lastAccepted'), false);
  }
});

test('last error text is preserved as history and never parsed as a present budget or process lock', () => {
  const error = '工作者预算用完；无法确认模型进程已停止；普通聊天仍在生成';
  const summary = describeRecovery(fixture({ phase: 'blocked', error }));
  assert.equal(summary.lastError, error);
  assert.deepEqual(summary.globalIssues, []);
  assert.deepEqual(summary.steps[0].issues, []);
  assert.equal(summary.resume.allowed, true);
});
