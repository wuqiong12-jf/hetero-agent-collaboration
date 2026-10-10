const DEFAULTS = Object.freeze({
  maxSupervisorCalls: 12, maxWorkerCalls: 16, maxRetries: 2, maxReviewRetries: 1, maxParallelReaders: 3,
  maxProviderCalls: Object.freeze({ codex: 12, deepseek: 16 }),
});
const STATUSES = new Set(['accepted', 'reviewing', 'queued', 'rejected', 'running', 'cancelled']);
const BOUNDARIES = new Set(['goal', 'cooperative-goal', 'reset', 'mode']);
const PROVIDER_NAMES = { codex: 'Codex', deepseek: 'DeepSeek' };
const count = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const list = (value) => Array.isArray(value) ? value : [];

function lastAccepted(tasks, activity) {
  const accepted = new Map(tasks.filter((task) => task.status === 'accepted').map((task) => [task.id, task]));
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const event = activity[index];
    if (BOUNDARIES.has(event?.type)) break;
    const task = accepted.get(event?.taskId);
    if (event?.type !== 'accepted' || !task || typeof event.at !== 'string' || !event.at || !Number.isFinite(Date.parse(event.at))) continue;
    return { taskId: task.id, title: task.title, at: event.at };
  }
  return undefined;
}

// A compatibility fallback for callers that have not supplied the engine's actual
// actor map. An explicit map always wins, including a missing/unavailable actor.
function taskActor(task, state, context) {
  if (context.taskActors !== undefined) return context.taskActors?.[task.id];
  const agents = list(state.agents);
  const workers = agents.filter((agent) => agent.id !== state.leaderId);
  const assigned = agents.find((agent) => agent.id === task.agentId);
  if (assigned && assigned.id !== state.leaderId) return assigned;
  return workers.find((agent) => agent.provider === 'deepseek') ?? workers[0];
}

/**
 * Describe recovery from a snapshot only. This function never changes the input,
 * releases locks, updates usage, checks capabilities, or calls a provider.
 */
export function describeRecovery(state = {}, context = {}) {
  state ??= {};
  context ??= {};
  const tasks = list(state.tasks);
  const settings = state.settings ?? {};
  const usage = state.usage ?? {};
  const limit = (key) => count(settings[key], DEFAULTS[key]);
  const used = (kind) => count(usage[kind === 'supervisor' ? 'autoSupervisorCalls' : 'autoWorkerCalls'],
    count(usage[kind === 'supervisor' ? 'supervisorCalls' : 'workerCalls']));
  const providerLimit = (provider) => count(settings.maxProviderCalls?.[provider], DEFAULTS.maxProviderCalls[provider]);
  const providerUsed = (provider) => count(usage.autoProviderCalls?.[provider], count(usage.providerCalls?.[provider]));
  const leader = list(state.agents).find((agent) => agent.id === state.leaderId);
  const progress = { accepted: 0, reviewing: 0, queued: 0, rejected: 0, running: 0, cancelled: 0 };
  const globalIssues = [];
  let hardGate = false;
  const global = (code, title, detail, action, blocking = true) => {
    globalIssues.push({ code, title, detail, action });
    if (blocking) hardGate = true;
  };

  if (context.closed === true) {
    global('service-closed', '服务已经关闭', '此服务实例已关闭，不能继续启动协作。请重新打开服务后读取最新状态。', 'none');
  }
  if (context.cleanupUnconfirmed === true || list(state.pendingCleanup).length > 0) {
    global('cleanup-unconfirmed', '旧执行尚未确认退出', '工作空间锁仍保留。目前没有解除此锁的接口；继续、保存重试或重置都不能确认旧进程已经退出。需要在适配器或进程层确认清理并处理该锁。', 'none');
  }
  if (count(context.stoppingCount) > 0) {
    global('stopping', '执行正在停止', `还有 ${count(context.stoppingCount)} 个执行等待停止确认。请等清理完成后再继续；正在停止不代表已经退出。`, 'wait');
  }
  if (state.phase === 'blocked' && count(context.activeCount) > 0) {
    global('active-execution', '仍有执行正在进行', `还有 ${count(context.activeCount)} 个执行尚未结束。当前阻塞提示不代表这些执行已停止，请等待完成后读取最新诊断。`, 'wait');
  }
  if (context.chatBusy === true) {
    global('chat-busy', '普通聊天仍在使用工作目录', '请等待普通聊天完成或停止并确认退出后，再启动同目录协作。', 'wait');
  }
  if (context.persistenceFailed === true) {
    global('persistence-failed', '当前状态未能保存', '已有输出仍保留在当前服务中。请先重试保存；保存成功后仍保持暂停，由你决定何时继续协作。保存重试不会解除未确认退出的工作空间锁。', 'retry-save');
  }
  if (state.collaborationMode !== 'cooperative') {
    global('cooperation-disabled', '合作模式尚未开启', '先开启合作模式，再继续分工与验收。已有交付和调用记录会保留。', 'cooperation');
  }
  if (typeof state.goal !== 'string' || !state.goal.trim()) {
    global('goal-empty', '尚未填写合作目标', '请填写并确认本轮合作目标，再启动或继续协作。', 'goal');
  }
  const workerCount = count(context.workerCount, list(state.agents).filter((agent) => agent.id !== state.leaderId).length);
  if (tasks.length === 0 && workerCount === 0) {
    global('no-workers', '尚无可派单的工作者', '当前需要生成新任务计划。请在团队设置中配置至少一位可用工作者，再开始分工。', 'team');
  }
  if (tasks.length === 0 && state.phase !== 'running' && state.phase !== 'completed') {
    const planningIssues = callIssues('supervisor', leader, '规划新任务');
    globalIssues.push(...planningIssues);
    if (planningIssues.length) hardGate = true;
  }
  if (tasks.length > 0 && tasks.every((task) => task.status === 'accepted' || task.status === 'cancelled') && tasks.some((task) => task.status === 'cancelled')) {
    global('no-pending-tasks', '本轮没有待处理步骤', '所有步骤均已验收或已取消，当前没有可继续执行或核查的步骤。请提交新的合作委托，生成新的任务计划后再运行。', 'goal');
  }

  function callIssues(kind, actor, nextWork = kind === 'supervisor' ? '核查当前交付' : '执行此步骤') {
    const issues = [];
    const monitor = kind === 'supervisor';
    const key = monitor ? 'maxSupervisorCalls' : 'maxWorkerCalls';
    if (used(kind) >= limit(key)) {
      issues.push({ code: monitor ? 'supervisor-budget' : 'worker-budget', title: monitor ? '监工调用预算已用完' : '工作者调用预算已用完',
        detail: `本轮已启动 ${used(kind)} 次，上限为 ${limit(key)} 次。请提高此项预算后再${nextWork}。`, action: 'settings', settingKey: key });
    }
    const provider = actor?.provider;
    if (Object.hasOwn(PROVIDER_NAMES, provider) && providerUsed(provider) >= providerLimit(provider)) {
      issues.push({ code: 'provider-budget', title: `${PROVIDER_NAMES[provider]} 提供方预算已用完`,
        detail: `此动作使用 ${PROVIDER_NAMES[provider]}，本轮已启动 ${providerUsed(provider)} 次，上限为 ${providerLimit(provider)} 次。请提高该提供方的预算。`,
        action: 'settings', settingKey: `maxProviderCalls.${provider}` });
    }
    return issues;
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const steps = tasks.map((task) => {
    const status = STATUSES.has(task.status) ? task.status : 'queued';
    progress[status] += 1;
    const attempt = count(task.attempt);
    const reviewAttempts = count(task.reviewAttempts);
    const interrupted = status === 'queued' && attempt > 0;
    const step = { taskId: task.id, title: task.title, status, attempt, reviewAttempts,
      hasOutput: typeof task.output === 'string' && task.output.length > 0,
      nextAction: 'run-worker', interrupted, issues: [] };
    if (status === 'accepted' || status === 'cancelled') {
      step.nextAction = status;
      return step;
    }
    if (status === 'running') {
      step.nextAction = 'wait-running';
      step.issues.push({ code: 'worker-running', title: '等待当前执行结束', detail: '此步骤仍标记为执行中，请读取执行结束后的最新状态再决定下一步。', action: 'wait' });
      return step;
    }
    if (status === 'reviewing') {
      step.nextAction = 'review-output';
      if (!leader) step.issues.push({ code: 'no-leader', title: '当前监工不存在', detail: '请在团队中选择可用监工，再核查这份已有交付。', action: 'team' });
      step.issues.push(...callIssues('supervisor', leader));
      if (reviewAttempts >= 1 + limit('maxReviewRetries')) {
        step.issues.push({ code: 'review-limit', title: '当前交付的核查次数已到上限',
          detail: `已启动 ${reviewAttempts} 次核查，当前允许首次核查加 ${limit('maxReviewRetries')} 次额外核查。提高额外核查上限后可继续核查；工作者交付会保留。`,
          action: 'settings', settingKey: 'maxReviewRetries' });
      }
      if (settings.autoReview === false) {
        step.issues.push({ code: 'manual-review', title: '自动核查已关闭', detail: '已有交付会保留。继续协作不会自动核查此项，请使用此任务的核查按钮。', action: 'manual-review' });
      }
      return step;
    }
    const pendingDependencies = list(task.dependsOn).filter((id) => taskById.get(id)?.status !== 'accepted');
    if (pendingDependencies.length > 0) {
      step.nextAction = 'wait-dependencies';
      step.issues.push({ code: 'dependencies-not-accepted', title: '等待前置任务验收通过',
        detail: `以下前置任务尚未验收通过：${pendingDependencies.map((id) => taskById.get(id)?.title ?? id).join('、')}。已有输出或取消状态都不能替代验收通过。`, action: 'wait' });
      return step;
    }
    const actor = taskActor(task, state, context);
    if (!actor) step.issues.push({ code: 'no-worker', title: '当前没有可执行此项的工作者', detail: '请检查任务指派与团队配置，配置可用工作者后再执行此项。', action: 'team' });
    step.issues.push(...callIssues('worker', actor));
    if (status === 'rejected' && attempt > limit('maxRetries')) {
      step.issues.push({ code: 'retry-limit', title: '返工次数已到上限', detail: `此步骤已启动 ${attempt} 次执行，当前额外返工上限为 ${limit('maxRetries')} 次。请先查看未通过反馈，并提高返工上限后再执行。`,
        action: 'settings', settingKey: 'maxRetries' });
    }
    return step;
  });

  const phaseAllowsResume = state.phase !== 'running' && state.phase !== 'completed';
  const allAccepted = tasks.length > 0 && tasks.every((task) => task.status === 'accepted');
  // Resume forces one dispatch pass even when autoDispatch is off. Follow the
  // pump's ordering until the first actual start or the first blocking return;
  // a later usable task must not hide an earlier inevitable budget/retry block.
  function firstPumpOutcome() {
    const actors = new Map(tasks.map((task) => [task.id, taskActor(task, state, context)]));
    const stepById = new Map(steps.map((step) => [step.taskId, step]));
    const ready = (task) => ['queued', 'rejected'].includes(task.status)
      && list(task.dependsOn).every((id) => taskById.get(id)?.status === 'accepted');
    const busy = (actor) => ['running', 'reviewing', 'stopping'].includes(actor?.status);
    const canEnter = (accessMode) => {
      if (state.mode !== 'live') return true;
      const readers = count(state.executionSummary?.readers);
      const writers = count(state.executionSummary?.writers);
      return accessMode === 'read-only' ? writers === 0 && readers < limit('maxParallelReaders') : readers === 0 && writers === 0;
    };
    const writerWaiting = state.mode === 'live' && tasks.some((task) => ready(task) && actors.get(task.id)?.accessMode !== 'read-only');
    const blocked = (task, issue) => ({ started: false, blocker: { task, issue } });

    if (!writerWaiting && settings.autoReview !== false && leader && !busy(leader) && canEnter('read-only')) {
      const reviewing = tasks.find((task) => task.status === 'reviewing');
      if (reviewing) {
        const step = stepById.get(reviewing.id);
        const issue = step.issues.find((item) => item.code === 'review-limit')
          ?? step.issues.find((item) => item.code === 'supervisor-budget')
          ?? step.issues.find((item) => item.code === 'provider-budget');
        if (issue) return blocked(reviewing, issue);
        return { started: true };
      }
    }
    const ordered = state.mode === 'live' ? [...tasks].sort((left, right) =>
      Number(actors.get(left.id)?.accessMode === 'read-only') - Number(actors.get(right.id)?.accessMode === 'read-only')) : tasks;
    for (const task of ordered) {
      if (task.status === 'rejected' && count(task.attempt) > limit('maxRetries')) {
        return blocked(task, { code: 'retry-limit', title: '返工次数已到上限',
          detail: `此步骤已启动 ${count(task.attempt)} 次执行，当前额外返工上限为 ${limit('maxRetries')} 次。调度会先检查返工上限，即使它的依赖尚未验收也会在此暂停。`,
          action: 'settings', settingKey: 'maxRetries' });
      }
      if (!ready(task)) continue;
      const actor = actors.get(task.id);
      if (!actor || busy(actor) || state.mode === 'live' && writerWaiting && actor.accessMode === 'read-only' || !canEnter(actor.accessMode)) continue;
      const issue = callIssues('worker', actor)[0];
      if (issue) return blocked(task, issue);
      return { started: true };
    }
    return { started: false };
  }
  if (!hardGate && phaseAllowsResume && tasks.length > 0 && !allAccepted) {
    const outcome = firstPumpOutcome();
    if (outcome.blocker) {
      const { task, issue } = outcome.blocker;
      globalIssues.push({ code: 'next-order-blocked', title: '请先处理自动推进的优先步骤',
        detail: `继续协作会先停在「${task.title}」：${issue.detail} 后续可用步骤不能绕过本次调度的这个停止点。已有交付可在满足该任务核查预算与次数条件后，使用对应任务的核查按钮单独核查；此提示不表示其他执行已经停止。`,
        action: issue.action, ...(issue.settingKey ? { settingKey: issue.settingKey } : {}) });
      hardGate = true;
    } else if (!outcome.started) {
      global('no-automatic-step', '当前没有可自动推进的步骤', '请处理任务旁列出的设置、团队或依赖提醒；已有交付仍可使用对应任务的核查按钮进行人工触发的核查。处理后再读取最新诊断。此提示不表示其他执行已经停止。', 'none');
    }
  }
  const accepted = lastAccepted(tasks, list(state.activity));
  return {
    sourceRevision: count(state.revision), progress,
    ...(accepted ? { lastAccepted: accepted } : {}), globalIssues, steps,
    resume: { allowed: !hardGate && phaseAllowsResume, needsCapabilityCheck: state.mode === 'live' },
    ...(typeof state.error === 'string' && state.error ? { lastError: state.error } : {}),
  };
}
