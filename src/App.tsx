import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Command, ExternalLink, Eye, EyeOff, Folder, History, Loader2, MessageSquarePlus, Pause, Play, Plus, Settings2, Square, Trash2, UsersRound, X } from 'lucide-react';
import type { Agent, Capabilities, Message, ModelCatalog, Provider, State } from './types';
import { nativeHost, requestJson, watchState } from './transport';

type Dialog = 'settings' | 'history' | 'workflow' | 'team' | null;
type AgentForm = { name: string; provider: Provider; modelId: string; role: string; reasoningEffort: string; accessMode: 'read-only' | 'workspace-write'; hidden: boolean };
type CatalogModel = ModelCatalog['models'][number];
type Action = (payload: Record<string, unknown>, key?: string) => Promise<boolean>;
const initialEmbedded = window.__RELAY_VIEW__ === 'deepseek' || new URLSearchParams(location.search).get('embed') === 'deepseek';
const effortLabels: Record<string, string> = { auto: '跟随默认配置', none: '关闭', off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' };
const phaseLabels: Record<State['phase'], string> = { idle: '准备就绪', running: '协作中', paused: '已暂停', completed: '已完成', blocked: '等待处理' };
const date = (at: string) => new Date(at).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const providerName = (provider: Provider) => provider === 'codex' ? 'Codex' : 'DeepSeek';
const agentBusy = (agent: Agent, state: State) => agent.status !== 'idle' || state.chatSessions?.[agent.id]?.status === 'running';
const unfinishedTasks = (agent: Agent, state: State) => state.tasks.filter(task => task.agentId === agent.id && !['accepted', 'cancelled'].includes(task.status));
const configLocked = (agent: Agent, state: State) => agentBusy(agent, state) || state.phase === 'running';
const workMode = (agent: Agent) => agent.accessMode === 'read-only' ? 'read-only' : 'workspace-write';
const workModeNote = (agent: Agent) => '配置：' + (workMode(agent) === 'read-only' ? '只读分析，可并行。' : '修改文件，独占工作目录。') + '规划与核查固定只读，实际执行方式以运行计数为准。';
const identitySignature = (agent: Agent | undefined) => agent ? JSON.stringify([agent.provider, agent.modelId || 'default', agent.reasoningEffort || 'auto', workMode(agent)]) : '';
function executionLabel(state: State): string {
  const summary = state.executionSummary;
  return summary ? (state.mode === 'demo' ? '模拟：' : '') + '只读 ' + summary.readers + ' / 写入 ' + summary.writers : '执行状态待同步';
}
function currentWorkflowMessageIds(state: State): Set<string> {
  const boundaries = new Set(['mode', 'goal', 'cooperative-goal', 'reset']);
  const boundary = [...state.activity].reverse().find(event => boundaries.has(event.type))?.at;
  const taskIds = new Set(state.tasks.map(task => task.id));
  return new Set(state.messages.filter(message => {
    if (message.conversationId || message.role === 'system') return false;
    if (boundary && message.at < boundary) return false;
    if (message.taskId) return taskIds.has(message.taskId);
    return ['dispatch', 'review', 'tool'].includes(message.kind);
  }).map(message => message.id));
}
const removeLocked = (agent: Agent, state: State) => {
  if (state.agents.length <= 2 || agent.id === state.leaderId || agentBusy(agent, state)) return true;
  return unfinishedTasks(agent, state).some(task => !(state.mode === 'demo' && state.phase !== 'running' && task.status === 'queued' && task.attempt === 0 && !task.output));
};
function formFor(agent: Agent): AgentForm {
  return { name: agent.name, provider: agent.provider, modelId: agent.modelId || 'default', role: agent.role, reasoningEffort: agent.reasoningEffort || 'auto', accessMode: workMode(agent), hidden: Boolean(agent.hidden) };
}
function selectedModel(catalog: ModelCatalog | null | undefined, modelId: string): CatalogModel | undefined {
  if (modelId !== 'default') return catalog?.models.find(model => model.id === modelId);
  const defaults = catalog?.models.filter(model => model.isDefault === true) || [];
  return defaults.length === 1 ? defaults[0] : undefined;
}
function ProviderIcon({ provider }: { provider: Provider }) {
  return <span className={'provider-icon ' + provider} aria-hidden="true">{provider === 'codex' ? <Command size={18} /> : <span>≈</span>}</span>;
}
function ModelSelect({ catalog, value, disabled, label, onChange }: { catalog?: ModelCatalog | null; value: string; disabled?: boolean; label: string; onChange: (value: string) => void }) {
  const entries = catalog?.models || [];
  const unknown = value !== 'default' && !entries.some(model => model.id === value);
  return <select className="model-select" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="default">当前默认模型</option>
    {unknown && <option value={value}>{value} · 当前配置</option>}
    {entries.filter(model => model.id !== 'default').map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
  </select>;
}
function ThinkingSelect({ catalog, modelId, value, disabled, label, onChange }: { catalog?: ModelCatalog | null; modelId: string; value: string; disabled?: boolean; label: string; onChange: (value: string) => void }) {
  const model = selectedModel(catalog, modelId);
  const options = model?.supportedReasoningEfforts || [];
  const unavailable = !model || options.length === 0;
  const unknown = value !== 'auto' && !options.some(option => option.reasoningEffort === value);
  const note = !model ? modelId === 'default' ? '默认模型尚未明确，请选择具体模型后设置思考程度。' : '模型目录暂未提供这个模型的思考选项。' : model.reasoningEffortUnsupportedReason || '这个模型没有声明可用的思考程度。';
  const defaultNote = '默认跟随当前 Codex 或提供方配置；需要固定强度时请明确选择。修改后开启新会话，旧记录保留。';
  return <select className="effort-select" aria-label={label} value={value} disabled={disabled || unavailable} title={(unavailable ? note + ' ' : '') + defaultNote} onChange={event => onChange(event.target.value)}>
    <option value="auto">跟随默认配置</option>
    {unknown && <option value={value} disabled>{(effortLabels[value] || value) + ' · 当前配置'}</option>}
    {options.filter(option => option.reasoningEffort !== 'auto').map(option => <option key={option.reasoningEffort} value={option.reasoningEffort} title={option.description}>{effortLabels[option.reasoningEffort] || option.reasoningEffort}</option>)}
  </select>;
}

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const stateRef = useRef<State | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [models, setModels] = useState<Partial<Record<Provider, ModelCatalog>>>({});
  const [embedded, setEmbedded] = useState(initialEmbedded);
  const [panelOpen, setPanelOpen] = useState(true);
  const [workerId, setWorkerId] = useState('deepseek-builder');
  const [context, setContext] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [dismissedError, setDismissedError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [historyAgent, setHistoryAgent] = useState('codex-supervisor');
  const [views, setViews] = useState<Record<string, string | undefined>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, number>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [draftGoal, setDraftGoal] = useState('');
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [adding, setAdding] = useState(false);
  const [split, setSplit] = useState(50);
  const panes = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const acceptState = useCallback((next: State) => {
    const current = stateRef.current;
    if (current && current.id === next.id && (next.revision ?? 0) <= (current.revision ?? 0)) return;
    stateRef.current = next;
    setState(next);
  }, []);
  useEffect(() => {
    let disposed = false;
    const accept = (value: State) => { if (!disposed) acceptState(value); };
    const report = (message: string) => { if (!disposed) setError(message); };
    const stopWatching = watchState(accept, value => { if (!disposed) setConnected(value); }, report);
    requestJson<State>('/api/state').then(accept).catch(error => report(error.message));
    requestJson<Capabilities>('/api/capabilities').then(value => { if (!disposed) setCapabilities(value); }).catch(() => {});
    for (const provider of ['codex', 'deepseek'] as const) requestJson<ModelCatalog>('/api/models?provider=' + provider).then(value => { if (!disposed) setModels(old => ({ ...old, [provider]: value })); }).catch(() => {});
    requestJson<{ workspace: string }>('/api/context').then(value => { if (!disposed) setContext(value.workspace || ''); }).catch(() => {});
    const view = (event: Event) => { const side = (event as CustomEvent).detail === 'deepseek'; setEmbedded(side); if (side) setPanelOpen(true); };
    window.addEventListener('relay-view', view);
    return () => { disposed = true; stopWatching(); window.removeEventListener('relay-view', view); };
  }, [acceptState]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragging.current || !panes.current) return;
      const bounds = panes.current.getBoundingClientRect();
      setSplit(Math.min(72, Math.max(28, (event.clientX - bounds.left) / bounds.width * 100)));
    };
    const end = () => { dragging.current = false; document.body.classList.remove('resizing'); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setDialog(null); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('blur', end); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('blur', end); window.removeEventListener('keydown', key); end(); };
  }, []);
  useEffect(() => {
    if (!dialog) return;
    const old = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>('[role="dialog"]');
    const fields = () => [...(modal?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]') || [])];
    fields()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const list = fields(); if (!list.length) return;
      if (event.shiftKey && document.activeElement === list[0]) { event.preventDefault(); list.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === list.at(-1)) { event.preventDefault(); list[0].focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); old?.focus(); };
  }, [dialog]);
  const action: Action = async (payload, key = 'global') => {
    setPending(old => ({ ...old, [key]: (old[key] || 0) + 1 })); setError('');
    try { const result = await requestJson<State>('/api/actions', payload); acceptState(result); return true; }
    catch (err) { setError(err instanceof Error ? err.message : '无法连接服务'); return false; }
    finally { setPending(old => ({ ...old, [key]: Math.max(0, (old[key] || 1) - 1) })); }
  };
  const newChat = async (agentId: string) => { if (await action({ action: 'newChat', agentId }, agentId)) setViews(old => ({ ...old, [agentId]: undefined })); };
  const updateAgent = async (agentId: string, fields: Record<string, unknown>) => {
    const previous = stateRef.current?.chatSessions?.[agentId]?.id;
    const identity = identitySignature(stateRef.current?.agents.find(agent => agent.id === agentId));
    if (!await action({ action: 'agentUpdate', agentId, agent: fields }, agentId)) return false;
    if (stateRef.current?.chatSessions?.[agentId]?.id !== previous || identitySignature(stateRef.current?.agents.find(agent => agent.id === agentId)) !== identity) setViews(old => ({ ...old, [agentId]: undefined }));
    return true;
  };
  const stopAgent = async (agent: Agent) => {
    const current = stateRef.current; if (!current) return;
    return action(current.chatSessions?.[agent.id]?.status === 'running' ? { action: 'cancelChat', agentId: agent.id } : { action: 'pause' }, agent.id);
  };
  const stopAllActive = async () => {
    const current = stateRef.current; if (!current) return;
    setBulkBusy(true);
    try {
      const workflowActive = current.phase === 'running' || current.agents.some(agent => agentBusy(agent, current) && current.chatSessions?.[agent.id]?.status !== 'running');
      if (workflowActive && !await action({ action: 'pause' })) return;
      for (const agent of stateRef.current?.agents || []) {
        if (stateRef.current?.chatSessions?.[agent.id]?.status === 'running' && !await action({ action: 'cancelChat', agentId: agent.id }, agent.id)) return;
      }
    } finally { setBulkBusy(false); }
  };
  const setAllHidden = async (hidden: boolean) => {
    const current = stateRef.current; if (!current) return;
    setBulkBusy(true);
    try {
      for (const agent of current.agents.filter(item => item.id !== current.leaderId)) {
        if (stateRef.current?.leaderId === agent.id) continue;
        if (Boolean(stateRef.current?.agents.find(item => item.id === agent.id)?.hidden) === hidden) continue;
        if (!await action({ action: 'agentVisibility', agentId: agent.id, hidden }, agent.id)) return;
      }
      setPanelOpen(!hidden);
    } finally { setBulkBusy(false); }
  };
  const leader = state?.agents.find(agent => agent.id === state.leaderId) || state?.agents[0];
  const workers = state?.agents.filter(agent => agent.id !== leader?.id) || [];
  const visibleWorkers = workers.filter(agent => !agent.hidden);
  const worker = visibleWorkers.find(agent => agent.id === workerId) || visibleWorkers[0];
  const showWorkers = panelOpen && Boolean(worker);
  const cooperating = state?.collaborationMode === 'cooperative';
  const historyOwner = state?.agents.find(agent => agent.id === historyAgent);
  const archives = Object.entries(state?.chatArchives || {}).filter(([, session]) => session.agentId === historyAgent).sort((a, b) => b[1].startedAt.localeCompare(a[1].startedAt));
  const anyPending = bulkBusy || Object.values(pending).some(value => value > 0);
  const busyCount = state ? state.agents.filter(agent => agentBusy(agent, state)).length : 0;
  if (!state || !leader) return <div className="loading-screen"><Command size={25} /><p>{error || '正在连接对话…'}</p><small>本地服务启动后会自动连接。</small></div>;
  const accepted = state.tasks.filter(task => task.status === 'accepted').length;
  const errorKey = state.id + ':' + state.revision + ':' + state.error;
  const visibleError = error || (state.error && dismissedError !== errorKey ? state.error : '');
  const pane = (agent: Agent) => {
    const conversationId = views[agent.id] || state.chatSessions?.[agent.id]?.id || 'current';
    const key = agent.id + ':' + conversationId;
    return <ChatPane key={agent.id} agent={agent} state={state} selectedConversation={views[agent.id]} connected={connected} pending={Boolean(pending[agent.id])} showWorkflow={Boolean(cooperating || showWorkflow)} providerReady={agent.provider === 'codex' ? capabilities?.codex.available : capabilities?.harness.available} models={models[agent.provider] || null} embedded={embedded} input={drafts[key] || ''} onInput={text => setDrafts(old => ({ ...old, [key]: text }))} onSent={text => setDrafts(old => old[key] === text ? { ...old, [key]: '' } : old)} onSend={text => action(cooperating && agent.id === state.leaderId ? { action: 'cooperativeGoal', text } : { action: 'message', agentId: agent.id, text }, agent.id)} onNew={() => newChat(agent.id)} onCancel={() => stopAgent(agent)} onHistory={() => { setHistoryAgent(agent.id); setDialog('history'); }} onReturn={() => setViews(old => ({ ...old, [agent.id]: undefined }))} onModel={modelId => updateAgent(agent.id, { modelId, reasoningEffort: 'auto' })} onEffort={reasoningEffort => updateAgent(agent.id, { reasoningEffort })} onSettings={() => setDialog('settings')} />;
  };
  const toggleWorkers = () => { if (!visibleWorkers.length) { setDialog('team'); return; } setPanelOpen(open => !open); };
  const openWorkflow = () => { setDraftGoal(state.goal); setDialog('workflow'); };
  return <div className={'application-shell ' + (embedded ? 'embedded-shell' : '')}>
    <nav className="app-rail" aria-label="应用功能"><button className={'feature-button ' + (showWorkers ? 'active' : '')} title="显示或隐藏工作者对话" aria-label="显示或隐藏工作者对话" aria-pressed={showWorkers} onClick={toggleWorkers}><UsersRound size={20} /></button></nav>
    <div className={'split-app ' + (embedded ? 'embedded' : '')}>
      <header className="split-topbar">
        <div className="split-brand">{embedded ? <><ProviderIcon provider={worker?.provider || 'deepseek'} /><span>第二个对话</span></> : <><Command size={17} /><span>异智能体</span></>}</div>
        {!embedded && <div className="split-project" title={context}><Folder size={13} /><span>{context.split(/[\\/]/).filter(Boolean).at(-1) || '异智能体合作'}</span></div>}
        <div className="split-top-actions">
          <div className="collaboration-toggle" aria-label="合作模式"><button className={!cooperating ? 'selected' : ''} aria-pressed={!cooperating} disabled={anyPending} onClick={() => action({ action: 'collaboration', mode: 'independent' })}>非合作</button><button className={cooperating ? 'selected' : ''} aria-pressed={Boolean(cooperating)} disabled={anyPending} onClick={() => action({ action: 'collaboration', mode: 'cooperative' })}>合作</button></div>
          <button className="team-button" title="管理智能体团队" onClick={() => setDialog('team')}><UsersRound size={15} /><span>{state.agents.length} 个</span>{busyCount > 0 && <small>{busyCount} 运行</small>}</button>
          <span className={'connection-status ' + (connected ? 'online' : '')} title={connected ? '本地服务已连接' : '正在重连'} />
          <button className="mode-chip" onClick={() => setDialog('settings')}>{state.mode === 'demo' ? '演示' : '真实对话'}</button>
          <button className="icon-button" title="设置" onClick={() => setDialog('settings')}><Settings2 size={16} /></button>
        </div>
      </header>
      {(cooperating || busyCount > 0) && <div className="cooperation-status"><span>{cooperating ? phaseLabels[state.phase] + ' · ' + leader.name + ' 监工 · ' + accepted + '/' + state.tasks.length + ' 达标' : '独立对话'} · {executionLabel(state)}</span>{cooperating ? state.phase === 'running' ? <button className="button secondary" disabled={anyPending} onClick={() => action({ action: 'pause' })}><Pause size={12} />暂停</button> : ['paused', 'blocked'].includes(state.phase) ? <button className="button secondary" disabled={anyPending || !state.goal.trim()} onClick={() => action({ action: 'resume' })}><Play size={12} />继续</button> : <button className="button secondary" onClick={openWorkflow}>目标与分工</button> : <button className="button secondary" onClick={() => setDialog('team')}>管理运行</button>}</div>}
      {visibleError && <div className="error-note" role="alert"><span>{visibleError}</span><button className="icon-button" title="关闭提示" onClick={() => { setError(''); setDismissedError(errorKey); }}><X size={14} /></button></div>}
      <main className={'split-panes ' + (!showWorkers || embedded ? 'single' : '')} ref={panes} style={embedded || !showWorkers ? { display: 'flex' } : { gridTemplateColumns: 'minmax(240px, ' + split + 'fr) 7px minmax(240px, ' + (100 - split) + 'fr)' }}>
        {!embedded && pane(leader)}
        {!embedded && showWorkers && <div className="split-divider" role="separator" aria-label="调整分屏比例" aria-orientation="vertical" aria-valuenow={Math.round(split)} aria-valuemin={28} aria-valuemax={72} tabIndex={0} onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); document.body.classList.add('resizing'); }} onDoubleClick={() => setSplit(50)} onKeyDown={event => { if (event.key === 'ArrowLeft') { event.preventDefault(); setSplit(value => Math.max(28, value - 3)); } if (event.key === 'ArrowRight') { event.preventDefault(); setSplit(value => Math.min(72, value + 3)); } if (event.key === 'Home') { event.preventDefault(); setSplit(50); } }} />}
        {showWorkers && worker ? <div className="worker-column"><div className="worker-switcher"><label>工作者<select aria-label="选择工作者对话" value={worker.id} onChange={event => setWorkerId(event.target.value)}>{visibleWorkers.map(agent => <option key={agent.id} value={agent.id}>{agent.name + (agentBusy(agent, state) ? ' · 运行中' : '')}</option>)}</select></label><button className="icon-button" title="隐藏工作者聊天；后台继续运行" onClick={() => setPanelOpen(false)}><EyeOff size={14} /></button></div>{pane(worker)}</div> : embedded ? <div className="panel-closed"><p>工作者聊天已隐藏，后台运行状态保持不变。</p><button className="button secondary" onClick={() => visibleWorkers.length ? setPanelOpen(true) : setDialog('team')}>显示工作者</button><button className="button secondary" onClick={() => setDialog('team')}>管理团队与停止任务</button></div> : null}
      </main>
      {dialog && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null); }}><section className={'modal ' + (dialog === 'team' ? 'wide' : '')} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="modal-heading"><h2 id="dialog-title">{dialog === 'settings' ? '设置' : dialog === 'history' ? (historyOwner?.name || '智能体') + ' 的对话' : dialog === 'team' ? '智能体团队' : '协作设置'}</h2><button className="icon-button" title="关闭" onClick={() => setDialog(null)}><X size={18} /></button></div>
        <div className="modal-content">
          {error && <div className="error-note" role="alert"><span>{error}</span></div>}
          {dialog === 'team' && <>
            <div className="team-toolbar"><span>{state.agents.length}/8 个智能体 · {busyCount} 个运行中 · {executionLabel(state)}</span>{(busyCount > 0 || state.phase === 'running') && <button className="button secondary" disabled={bulkBusy} onClick={stopAllActive}><Square size={12} />停止全部</button>}<button className="button secondary" disabled={bulkBusy} onClick={() => setAllHidden(visibleWorkers.length > 0)}>{visibleWorkers.length > 0 ? <EyeOff size={14} /> : <Eye size={14} />}{visibleWorkers.length > 0 ? '隐藏全部工作者' : '显示全部工作者'}</button><button className="button primary" disabled={state.agents.length >= 8 || bulkBusy} onClick={() => setAdding(value => !value)}><Plus size={14} />新增智能体</button></div>
            <p className="context-note">显示或隐藏只改变聊天界面。只读分析可以并行；修改文件时独占工作目录，不能与其他执行同时运行。规划与核查固定只读，当前监工始终可见。</p>
            {state.agents.map(agent => <AgentEditor key={agent.id} agent={agent} state={state} catalog={models} pending={Boolean(pending[agent.id]) || bulkBusy} onSave={fields => updateAgent(agent.id, fields)} onRemove={() => action({ action: 'agentRemove', agentId: agent.id }, agent.id)} onVisibility={hidden => action({ action: 'agentVisibility', agentId: agent.id, hidden }, agent.id)} onLead={() => action({ action: 'leader', agentId: agent.id }, agent.id)} onStop={() => stopAgent(agent)} />)}
            {adding && <NewAgentEditor catalog={models} count={state.agents.length} pending={Boolean(pending.add) || bulkBusy} onAdd={async agent => { const existing = new Set(stateRef.current?.agents.map(item => item.id)); if (await action({ action: 'agentAdd', agent }, 'add')) { setAdding(false); const added = stateRef.current?.agents.find(item => !existing.has(item.id)); if (added && !added.hidden) { setWorkerId(added.id); setPanelOpen(true); } } }} onCancel={() => setAdding(false)} />}
          </>}
          {dialog === 'settings' && <>
            <div className="setting-row"><div><strong>运行模式</strong><p>演示不调用模型；真实对话使用已配置的渠道。</p></div><select aria-label="运行模式" value={state.mode} disabled={anyPending || state.phase === 'running' || busyCount > 0} onChange={event => action({ action: 'mode', mode: event.target.value })}><option value="demo">演示</option><option value="live" disabled={!capabilities?.codex.available && !capabilities?.harness.available}>真实对话</option></select></div>
            <div className="connection-row"><ProviderIcon provider="codex" /><div><strong>Codex · ChatGPT 登录</strong><p>{capabilities?.codex.detail || '正在检测…'}</p></div></div>
            <div className="connection-row"><ProviderIcon provider="deepseek" /><div><strong>DeepSeek Harness</strong><p>{capabilities?.harness.detail || '正在检测…'}</p></div></div>
            <div className="detail-note"><strong>保留 Codex 原有界面</strong><p>项目栏、标签页、预览、定时任务和新建任务继续由 Codex 宿主提供。插件后台监工独立运行；原生主聊天也可以直接委托工作者，收到结果后核查并继续派单。</p><p>{nativeHost ? '从原生菜单打开「异智能体」侧面板，即可同时查看主聊天和工作者对话。' : '当前为浏览器备用预览；原生入口由本地插件提供。'}</p>{!nativeHost && <a href="http://127.0.0.1:4318/?embed=deepseek" target="_blank" rel="noreferrer">浏览器备用预览 <ExternalLink size={12} /></a>}</div>
            <div className="settings-actions"><button className="button secondary" onClick={() => setDialog('team')}>管理团队</button><button className="button secondary" onClick={openWorkflow}>协作设置</button></div>
            {context && <p className="context-note" title={context}>工作目录：{context}</p>}
          </>}
          {dialog === 'history' && <>
            <button className="session-row current" onClick={() => { setViews(old => ({ ...old, [historyAgent]: undefined })); setDialog(null); }}><span>当前对话</span><Check size={15} /></button>
            {archives.map(([sessionId, session]) => { const title = state.messages.find(message => message.conversationId === sessionId && message.role === 'user')?.text || '新对话'; return <button className="session-row" key={sessionId} onClick={() => { setViews(old => ({ ...old, [historyAgent]: sessionId })); setDialog(null); }}><span>{title.slice(0, 60)}</span><small>{date(session.startedAt)}</small></button>; })}
            {!archives.length && <p className="context-note">新建对话或切换模型后，原对话会保留在这里。</p>}
          </>}
          {dialog === 'workflow' && <>
            <p className="context-note">合作模式允许后台分工。仅切换开关不调用模型；提交目标后才开始运行。</p>
            <label className="workflow-field">目标<textarea aria-label="协作目标" value={draftGoal} onChange={event => setDraftGoal(event.target.value)} /></label>
            <label className="workflow-field inline">监工<select aria-label="协作监工" value={leader.id} disabled={anyPending} onChange={event => action({ action: 'leader', agentId: event.target.value })}>{state.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
            <label className="workflow-check"><input type="checkbox" checked={state.settings.autoReview} disabled={anyPending} onChange={event => action({ action: 'settings', settings: { autoReview: event.target.checked } })} />工作完成后自动核查</label>
            <label className="workflow-check"><input type="checkbox" checked={state.settings.autoDispatch} disabled={anyPending} onChange={event => action({ action: 'settings', settings: { autoDispatch: event.target.checked } })} />核查后继续分工</label>
            <label className="workflow-check"><input type="checkbox" checked={showWorkflow} onChange={event => setShowWorkflow(event.target.checked)} />在对话中显示本次协作输出</label>
            <BudgetField label="同时只读智能体上限" value={state.settings.maxParallelReaders ?? 3} max={4} disabled={anyPending} onSave={value => action({ action: 'settings', settings: { maxParallelReaders: value } })} />
            <p className="context-note">最多同时运行 1–4 个只读执行，独立聊天与合作任务共享此限额。写入执行独占目录；当前 {executionLabel(state)}。</p>
            <BudgetField label="Codex 自动调用上限" value={state.settings.maxProviderCalls?.codex ?? 12} used={state.usage.autoProviderCalls?.codex ?? 0} disabled={anyPending} onSave={value => action({ action: 'settings', settings: { maxProviderCalls: { codex: value } } })} />
            <BudgetField label="DeepSeek 自动调用上限" value={state.settings.maxProviderCalls?.deepseek ?? 16} used={state.usage.autoProviderCalls?.deepseek ?? 0} disabled={anyPending} onSave={value => action({ action: 'settings', settings: { maxProviderCalls: { deepseek: value } } })} />
            <p className="context-note">全部实际调用：Codex {state.usage.providerCalls?.codex ?? 0} 次，DeepSeek {state.usage.providerCalls?.deepseek ?? 0} 次。上限限制自动协作，不代表精确订阅额度；手动聊天单独计量。</p>
            {!cooperating && <p className="context-note">请先在顶栏切换「合作」，再运行目标。</p>}
            <div className="modal-actions">{state.phase === 'running' ? <button className="button secondary" disabled={anyPending} onClick={() => action({ action: 'pause' })}><Pause size={14} />暂停协作</button> : <button className="button primary" disabled={anyPending || !draftGoal.trim() || !cooperating} onClick={async () => { if (draftGoal.trim() !== state.goal && !await action({ action: 'goal', text: draftGoal.trim() })) return; setShowWorkflow(true); if (await action({ action: state.phase === 'paused' || state.phase === 'blocked' ? 'resume' : 'start' })) setDialog(null); }}><Play size={14} />运行协作</button>}</div>
          </>}
        </div>
      </section></div>}
    </div>
  </div>;
}

function AgentEditor({ agent, state, catalog, pending, onSave, onRemove, onVisibility, onLead, onStop }: { agent: Agent; state: State; catalog: Partial<Record<Provider, ModelCatalog>>; pending: boolean; onSave: (fields: Record<string, unknown>) => Promise<boolean>; onRemove: () => Promise<boolean>; onVisibility: (hidden: boolean) => Promise<boolean>; onLead: () => Promise<boolean>; onStop: () => Promise<boolean | undefined> }) {
  const [form, setForm] = useState(() => formFor(agent));
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const locked = configLocked(agent, state);
  const signature = JSON.stringify(formFor(agent));
  useEffect(() => { if (!dirty) setForm(formFor(agent)); }, [signature, dirty]);
  const edit = (fields: Partial<AgentForm>) => { setForm(old => ({ ...old, ...fields })); setDirty(true); };
  const isLeader = state.leaderId === agent.id;
  const working = agentBusy(agent, state) || isLeader && state.phase === 'running';
  const provider = locked ? agent.provider : form.provider;
  const modelId = locked ? agent.modelId || 'default' : form.modelId;
  const effort = locked ? agent.reasoningEffort || 'auto' : form.reasoningEffort;
  const accessMode = locked ? workMode(agent) : form.accessMode;
  const displayedEffort = agent.reasoningEffort && agent.reasoningEffort !== 'auto' ? effortLabels[agent.reasoningEffort] || agent.reasoningEffort : '跟随默认配置';
  const configurationId = 'configuration-' + agent.id;
  return <form className="agent-editor" onSubmit={async event => { event.preventDefault(); const fields: Record<string, unknown> = { name: form.name.trim(), role: form.role.trim() }; if (!locked) Object.assign(fields, { provider: form.provider, modelId: form.modelId, reasoningEffort: form.reasoningEffort, accessMode: form.accessMode }); if (await onSave(fields)) setDirty(false); }}>
    <div className="agent-editor-heading">
      <ProviderIcon provider={agent.provider} />
      <div><strong>{agent.name}</strong><p className="context-note">{providerName(agent.provider)} / {agent.modelId && agent.modelId !== 'default' ? agent.modelId : '当前默认模型'} · 思考：{displayedEffort} · {workMode(agent) === 'read-only' ? '配置只读 / 可并行' : '配置可写 / 独占目录'}{dirty ? ' · 有未保存设置' : ''}</p></div>
      <span className={'agent-status ' + agent.status}>{isLeader ? '监工' : '工作者'} · {agent.status === 'stopping' ? '停止中' : working ? '运行中' : '空闲'}{!isLeader && agent.hidden ? ' · 已隐藏' : ''}</span>
      {!isLeader && <button className="icon-button" type="button" title={(agent.hidden ? '显示 ' : '隐藏 ') + agent.name + ' 聊天'} aria-label={(agent.hidden ? '显示 ' : '隐藏 ') + agent.name + ' 聊天'} disabled={pending} onClick={() => onVisibility(!agent.hidden)}>{agent.hidden ? <Eye size={14} /> : <EyeOff size={14} />}</button>}
      {working && <button className="button secondary" type="button" disabled={pending || agent.status === 'stopping'} onClick={onStop}><Square size={12} />{agent.status === 'stopping' ? '等待停止完成' : '停止 ' + agent.name}</button>}
      <button className="agent-card-toggle" type="button" aria-expanded={expanded} aria-controls={configurationId} onClick={() => setExpanded(value => !value)}>{expanded ? '收起 ' : '展开 '}{agent.name}</button>
    </div>
    {expanded && <div className="agent-configuration" id={configurationId}>
    <div className="agent-form">
      <label>名称<input aria-label={agent.name + ' 名称'} value={form.name} maxLength={80} disabled={pending} onChange={event => edit({ name: event.target.value })} /></label>
      <label>分工<input aria-label={agent.name + ' 分工'} value={form.role} maxLength={160} disabled={pending} onChange={event => edit({ role: event.target.value })} /></label>
      <label>提供方<select aria-label={agent.name + ' 提供方'} value={provider} disabled={pending || locked} onChange={event => edit({ provider: event.target.value as Provider, modelId: 'default', reasoningEffort: 'auto' })}><option value="codex">Codex</option><option value="deepseek">DeepSeek Harness</option></select></label>
      <label>模型<ModelSelect catalog={catalog[provider]} value={modelId} disabled={pending || locked} label={agent.name + ' 编辑模型'} onChange={value => edit({ modelId: value, reasoningEffort: 'auto' })} /></label>
      <label>思考程度<ThinkingSelect catalog={catalog[provider]} modelId={modelId} value={effort} disabled={pending || locked} label={agent.name + ' 编辑思考程度'} onChange={value => edit({ reasoningEffort: value })} /></label>
      <label>工作方式<select aria-label={agent.name + ' 工作方式'} value={accessMode} disabled={pending || locked} onChange={event => edit({ accessMode: event.target.value as AgentForm['accessMode'] })}><option value="read-only">只读分析 · 可并行</option><option value="workspace-write">修改文件 · 独占目录</option></select></label>
    </div>
    {locked && <p className="context-note">当前持有任务，模型、思考程度和工作方式暂不可更改；名称与分工仍可保存。</p>}
    <div className="agent-editor-actions"><label className="workflow-check"><input type="checkbox" checked={isLeader ? false : Boolean(agent.hidden)} disabled={pending || isLeader} onChange={event => onVisibility(event.target.checked)} />隐藏聊天</label>{!isLeader && <button className="button secondary" type="button" disabled={pending} onClick={onLead}>设为监工</button>}<button className="button secondary" type="button" disabled={pending || removeLocked(agent, state)} title="运行中或仍持有真实任务时不能移除；历史记录保留。" onClick={onRemove}><Trash2 size={12} />移除</button><button className="button primary" type="submit" disabled={pending || !dirty || !form.name.trim()}>保存</button></div>
    </div>}
  </form>;
}
function NewAgentEditor({ catalog, count, pending, onAdd, onCancel }: { catalog: Partial<Record<Provider, ModelCatalog>>; count: number; pending: boolean; onAdd: (form: AgentForm) => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<AgentForm>({ name: 'DeepSeek ' + (count + 1), provider: 'deepseek', modelId: 'default', role: '工作者', reasoningEffort: 'auto', accessMode: 'workspace-write', hidden: false });
  const edit = (fields: Partial<AgentForm>) => setForm(old => ({ ...old, ...fields }));
  return <form className="agent-editor" onSubmit={event => { event.preventDefault(); onAdd({ ...form, name: form.name.trim(), role: form.role.trim() }); }}>
    <div className="agent-editor-heading"><Plus size={17} /><strong>新增智能体</strong></div>
    <div className="agent-form">
      <label>名称<input aria-label="新增智能体名称" value={form.name} maxLength={80} disabled={pending} onChange={event => edit({ name: event.target.value })} /></label>
      <label>分工<input aria-label="新增智能体分工" value={form.role} maxLength={160} disabled={pending} onChange={event => edit({ role: event.target.value })} /></label>
      <label>提供方<select aria-label="新增智能体提供方" value={form.provider} disabled={pending} onChange={event => edit({ provider: event.target.value as Provider, modelId: 'default', reasoningEffort: 'auto' })}><option value="codex">Codex</option><option value="deepseek">DeepSeek Harness</option></select></label>
      <label>模型<ModelSelect catalog={catalog[form.provider]} value={form.modelId} disabled={pending} label="新增智能体模型" onChange={value => edit({ modelId: value, reasoningEffort: 'auto' })} /></label>
      <label>思考程度<ThinkingSelect catalog={catalog[form.provider]} modelId={form.modelId} value={form.reasoningEffort} disabled={pending} label="新增智能体思考程度" onChange={value => edit({ reasoningEffort: value })} /></label>
      <label>工作方式<select aria-label="新增智能体工作方式" value={form.accessMode} disabled={pending} onChange={event => edit({ accessMode: event.target.value as AgentForm['accessMode'] })}><option value="read-only">只读分析 · 可并行</option><option value="workspace-write">修改文件 · 独占目录</option></select></label>
    </div>
    <div className="agent-editor-actions"><label className="workflow-check"><input type="checkbox" checked={form.hidden} disabled={pending} onChange={event => edit({ hidden: event.target.checked })} />加入后隐藏聊天</label><button className="button secondary" type="button" disabled={pending} onClick={onCancel}>取消</button><button className="button primary" type="submit" disabled={pending || count >= 8 || !form.name.trim()}>加入团队</button></div>
  </form>;
}
function BudgetField({ label, value, used, max = 100, disabled, onSave }: { label: string; value: number; used?: number; max?: number; disabled: boolean; onSave: (value: number) => Promise<boolean> }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label className="workflow-field inline">{label}<input type="number" aria-label={label} min={1} max={max} value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} onBlur={async () => { const number = Number(draft); if (!Number.isInteger(number) || number < 1 || number > max) { setDraft(String(value)); return; } if (number !== value && !await onSave(number)) setDraft(String(value)); }} />{used !== undefined && <small>自动已用 {used} 次</small>}</label>;
}

type ChatPaneProps = { agent: Agent; state: State; selectedConversation?: string; connected: boolean; pending: boolean; showWorkflow: boolean; providerReady?: boolean; models: ModelCatalog | null; embedded: boolean; input: string; onInput: (text: string) => void; onSent: (text: string) => void; onSend: (text: string) => Promise<boolean>; onNew: () => void; onCancel: () => void; onHistory: () => void; onReturn: () => void; onModel: (model: string) => void; onEffort: (effort: string) => void; onSettings: () => void };
function ChatPane({ agent, state, selectedConversation, connected, pending, showWorkflow, providerReady, models, embedded, input, onInput, onSent, onSend, onNew, onCancel, onHistory, onReturn, onModel, onEffort, onSettings }: ChatPaneProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const session = state.chatSessions?.[agent.id];
  const currentId = selectedConversation || session?.id;
  const archived = Boolean(selectedConversation && selectedConversation !== session?.id);
  const workflowMessageIds = currentWorkflowMessageIds(state);
  const messages = state.messages.filter(message => message.agentId === agent.id && (currentId && message.conversationId === currentId || !archived && showWorkflow && workflowMessageIds.has(message.id)));
  const isLeader = agent.id === state.leaderId;
  const running = agentBusy(agent, state) || state.collaborationMode === 'cooperative' && isLeader && state.phase === 'running';
  const ready = state.mode === 'demo' || Boolean(providerReady);
  const locked = configLocked(agent, state);
  useEffect(() => { if (follow.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }, [state.revision, currentId]);
  useEffect(() => { follow.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight }); }, [currentId]);
  async function send() { const original = input; const text = original.trim(); if (!text || pending || running || archived) return; if (await onSend(text)) { onSent(original); follow.current = true; } }
  return <section className={'chat-pane ' + agent.provider} aria-label={agent.name + ' 对话'}>
    <header className="pane-header"><div className="pane-identity"><ProviderIcon provider={agent.provider} /><div className="pane-title"><strong>{agent.name}<small>{isLeader ? '监工' : '工作者'}</small><small title={workModeNote(agent)}>{workMode(agent) === 'read-only' ? '配置只读' : '配置可写'}</small></strong><div className="model-controls"><ModelSelect catalog={models} value={agent.modelId || 'default'} disabled={pending || locked} label={agent.name + ' 模型'} onChange={onModel} /><ThinkingSelect catalog={models} modelId={agent.modelId || 'default'} value={agent.reasoningEffort || 'auto'} disabled={pending || locked} label={agent.name + ' 思考程度'} onChange={onEffort} /></div></div></div><div className="pane-actions"><button className="icon-button" title={agent.name + ' 历史对话'} onClick={onHistory}><History size={16} /></button><button className="icon-button" title={agent.name + ' 新建对话'} disabled={pending} onClick={onNew}><MessageSquarePlus size={17} /></button></div></header>
    <div className="chat-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90; }}>
      {messages.length ? messages.map(message => <ChatMessage key={message.id} message={message} name={agent.name} />) : <div className="chat-empty"><div className="chat-empty-icon"><ProviderIcon provider={agent.provider} /></div><h1>和 {agent.name} 开始对话</h1><p>{embedded ? '宿主对话保持原样，这里是选中的工作者。' : '选择模型与思考程度，直接提问或提交任务。'}</p></div>}
    </div>
    {session?.lastError && !archived && <div className="error-note" role="alert">{session.lastError}</div>}
    {archived ? <div className="history-notice"><span>正在查看历史对话</span><button className="button secondary" onClick={onReturn}>返回当前对话</button></div> : <div className="chat-composer"><div className="chat-input-wrap"><textarea className="chat-input" aria-label={'发送给 ' + agent.name} placeholder={state.collaborationMode === 'cooperative' && isLeader ? '告诉监工要共同完成的目标…' : '发消息给 ' + agent.name + '…'} value={input} disabled={!connected || !ready} onChange={event => onInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} /><div className="composer-footer"><span className="composer-note">{state.mode === 'demo' ? '演示模式 · 不消耗额度' : !ready ? '尚未连接模型' : running ? '正在处理 · 可停止或预写下一条消息' : 'Enter 发送 · Shift + Enter 换行'}</span>{running ? <button className="stop-button" title={'停止 ' + agent.name + ' 当前工作'} disabled={pending} onClick={onCancel}><Square size={14} fill="currentColor" /></button> : <button className="send-button" title={'发送给 ' + agent.name} disabled={pending || !input.trim() || !connected || !ready} onClick={send}>{pending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={18} />}</button>}</div></div>{state.mode === 'live' && !ready && <button className="connect-prompt" onClick={onSettings}>配置 {providerName(agent.provider)} 连接</button>}</div>}
  </section>;
}
function ChatMessage({ message, name }: { message: Message; name: string }) {
  if (message.kind === 'tool') return <details className="tool-message"><summary>工具活动</summary><pre>{message.text}</pre></details>;
  return <article className={'chat-message ' + message.role}><div className="message-label">{message.role === 'user' ? '你' : message.role === 'system' ? '对话提示' : name}{message.status === 'streaming' && <Loader2 size={11} className="spin" />}{message.status === 'cancelled' && <small>已停止</small>}</div><div className="message-body">{message.text || (message.status === 'streaming' ? '正在回复…' : '')}</div></article>;
}
