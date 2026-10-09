import { useEffect, useRef, useState } from 'react';
import { Check, FileText, Loader2, RefreshCw, X } from 'lucide-react';
import type { Agent, GoalBriefFields, GoalDraft, State } from './types';

export const goalFieldLimits: Record<keyof GoalBriefFields, number> = { objective: 3000, deliverables: 3000, acceptance: 3000, constraints: 2000, questions: 1000 };
const fieldDefinitions: { key: keyof GoalBriefFields; label: string; required?: boolean; example: string; help: string }[] = [
  { key: 'objective', label: '目标', required: true, example: '例如：修复现有项目中的一个具体问题，让指定操作能够完成。', help: '说明要解决什么问题、为谁解决。不要只写“完善一下”。' },
  { key: 'deliverables', label: '交付物', required: true, example: '例如：可运行的修改、使用说明，以及本次检查结果。', help: '完成后要得到什么文件、功能或结论？可以逐行列出。' },
  { key: 'acceptance', label: '验收标准', required: true, example: '例如：按给定步骤能够完成操作；异常输入有提示；现有检查通过。', help: '写可观察、可复现的检查，避免仅写“专业、完整、无错误”。' },
  { key: 'constraints', label: '约束', example: '例如：只分析不修改；只改指定目录；不安装新依赖。', help: '填写允许修改的范围、已有材料、费用或其他限制；没有可留空。' },
  { key: 'questions', label: '待决定的问题', example: '例如：尚未确定输出格式，需先与我确认。', help: '可以先保存问题。在问题解决并清空此项之前，不会开始执行。' },
];
const effortNames: Record<string, string> = { none: '关闭', off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' };
export function copyGoalFields(source?: GoalBriefFields): GoalBriefFields {
  return { objective: source?.objective ?? '', deliverables: source?.deliverables ?? '', acceptance: source?.acceptance ?? '', constraints: source?.constraints ?? '', questions: source?.questions ?? '' };
}
export function goalBriefProblems(fields: GoalBriefFields): string[] {
  const problems = fieldDefinitions.filter(field => field.required && !fields[field.key].trim()).map(field => '请填写' + field.label);
  for (const field of fieldDefinitions) if (fields[field.key].length > goalFieldLimits[field.key]) problems.push(field.label + '超过 ' + goalFieldLimits[field.key] + ' 字限制');
  if (Object.values(fields).reduce((sum, value) => sum + value.length, 0) > 12000) problems.push('任务委托书总长度不能超过 12000 字');
  if (fields.questions.trim()) problems.push('待决定的问题尚未解决；解决后请清空并重新保存');
  return problems;
}
type PreviewContext = { stateId: string; mode: State['mode']; leaderId: string; leaderName: string; provider: Agent['provider']; model: string; effort: string; workspace: string };
function previewContext(state: State, leader: Agent, workspace: string): PreviewContext {
  return { stateId: state.id, mode: state.mode, leaderId: leader.id, leaderName: leader.name, provider: leader.provider, model: leader.modelId || 'default', effort: leader.reasoningEffort || 'auto', workspace };
}
function matchingContext(left: PreviewContext, right: PreviewContext): boolean {
  return left.stateId === right.stateId && left.mode === right.mode && left.leaderId === right.leaderId && left.provider === right.provider && left.model === right.model && left.effort === right.effort && left.workspace === right.workspace;
}
type Props = {
  open: boolean; state: State; leader: Agent; workspace: string; pending: boolean; requestError: string;
  seed?: { text: string; sequence: number };
  onClose: () => void;
  onSave: (brief: GoalBriefFields, expectedRevision: number) => Promise<GoalDraft | null>;
  onConfirm: (revision: number, expectedMode: State['mode'], expectedLeaderId: string, expectedLeaderConfig: { provider: Agent['provider']; modelId: string; reasoningEffort: string }) => Promise<boolean>;
  onReload: () => Promise<GoalDraft | undefined | null>;
};

export default function GoalBriefEditor({ open, state, leader, workspace, pending, requestError, seed, onClose, onSave, onConfirm, onReload }: Props) {
  const [fields, setFields] = useState<GoalBriefFields>(() => copyGoalFields(state.goalDraft));
  const [baseRevision, setBaseRevision] = useState(state.goalDraft?.revision ?? 0);
  const [saved, setSaved] = useState<GoalDraft | undefined>(state.goalDraft);
  const [stage, setStage] = useState<'edit' | 'preview'>('edit');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const [notice, setNotice] = useState('');
  const [objectiveChanged, setObjectiveChanged] = useState(false);
  const [context, setContext] = useState<PreviewContext | undefined>();
  const [backup, setBackup] = useState<GoalBriefFields | undefined>();
  const hasOpened = useRef(false);
  const lastSeed = useRef<number | undefined>(undefined);
  const editGeneration = useRef(0);
  const latestSeed = useRef(seed?.sequence);
  latestSeed.current = seed?.sequence;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) body.current?.scrollTo({ top: 0 }); }, [open, stage]);
  useEffect(() => {
    if (!open) return;
    const first = !hasOpened.current;
    hasOpened.current = true;
    const current = first ? copyGoalFields(state.goalDraft) : fields;
    if (first) { setFields(current); setBaseRevision(state.goalDraft?.revision ?? 0); setSaved(state.goalDraft); }
    if (seed && seed.sequence !== lastSeed.current) {
      lastSeed.current = seed.sequence;
      editGeneration.current += 1;
      setObjectiveChanged(Boolean(current.objective.trim() && current.objective.trim() !== seed.text.trim()));
      setFields({ ...current, objective: seed.text }); setDirty(true); setStage('edit'); setLocalError('');
      setNotice('已把聊天输入带入目标。保存草稿不会调用模型，确认之前不会派单。');
    }
  }, [open, seed?.sequence]);

  const currentRevision = state.goalDraft?.revision ?? 0;
  const revisionChanged = currentRevision !== baseRevision;
  const savedChanged = Boolean(saved && (state.goalDraft?.revision !== saved.revision || JSON.stringify(copyGoalFields(state.goalDraft)) !== JSON.stringify(copyGoalFields(saved))));
  const changedContext = Boolean(context && !matchingContext(context, previewContext(state, leader, workspace)));
  const tooLong = Object.entries(fields).some(([key, value]) => value.length > goalFieldLimits[key as keyof GoalBriefFields]) || Object.values(fields).reduce((sum, value) => sum + value.length, 0) > 12000;
  const previewProblems = saved ? goalBriefProblems(saved) : ['请先保存任务委托书'];
  const executions = state.executionSummary;
  const activeExecution = state.phase === 'running' || state.agents.some(agent => agent.status !== 'idle') || Object.values(state.chatSessions || {}).some(session => session.status === 'running') || Boolean(executions && executions.readers + executions.writers + (executions.retiringReaders || 0) + (executions.retiringWriters || 0) > 0);
  const confirmed = Boolean(saved && state.activeBrief?.revision === saved.revision);
  const locked = busy || pending;
  const confirmDisabled = locked || !saved || !context || dirty || savedChanged || changedContext || previewProblems.length > 0 || state.collaborationMode !== 'cooperative' || activeExecution || !context.workspace.trim() || confirmed;

  async function save() {
    if (locked || tooLong) return;
    const generation = editGeneration.current;
    const seedSequence = latestSeed.current;
    setBusy(true); setLocalError('');
    try {
      const result = await onSave(copyGoalFields(fields), baseRevision);
      if (!result) { setLocalError('未能确认保存结果，本地编辑已保留。请刷新状态或重新载入保存版核对。'); return; }
      setBaseRevision(result.revision); setSaved(result);
      if (generation !== editGeneration.current || seedSequence !== latestSeed.current) {
        setDirty(true); setStage('edit'); setNotice('之前的草稿已保存。当前新输入仍保留在本地，需重新保存并预览。'); return;
      }
      setFields(copyGoalFields(result)); setDirty(false); setObjectiveChanged(false);
      setContext(previewContext(state, leader, workspace)); setStage('preview'); setNotice('已保存版本 ' + result.revision + '。请核对下方内容；保存本身没有派单。');
    } finally { setBusy(false); }
  }
  async function reload() {
    if (locked) return;
    const generation = editGeneration.current;
    const seedSequence = latestSeed.current;
    setBusy(true); setLocalError('');
    try {
      const result = await onReload();
      if (result === null) { setLocalError('无法重新载入，当前编辑已保留。'); return; }
      setBaseRevision(result?.revision ?? 0); setSaved(result);
      if (generation !== editGeneration.current || seedSequence !== latestSeed.current) {
        setDirty(true); setStage('edit'); setNotice('已读取保存版。等待期间的新输入没有被覆盖，请复核后保存。'); return;
      }
      if (dirty) setBackup(copyGoalFields(fields));
      editGeneration.current += 1;
      setFields(copyGoalFields(result)); setDirty(false); setObjectiveChanged(false); setStage('edit'); setContext(undefined);
      setNotice(dirty ? '已载入保存版。此前本地编辑仍保留，可以恢复后再复核。' : '已载入最新保存版。');
    } finally { setBusy(false); }
  }
  function viewSaved() {
    if (!saved || locked) return;
    setContext(previewContext(state, leader, workspace)); setStage('preview'); setLocalError('');
  }
  async function refreshStatus() {
    if (locked) return;
    setBusy(true); setLocalError('');
    try {
      const result = await onReload();
      if (result === null) setLocalError('未能刷新状态，本地编辑已保留。');
      else setNotice('已刷新保存与确认状态。本地编辑保持不变，请核对当前版本。');
    } finally { setBusy(false); }
  }
  async function confirm() {
    if (confirmDisabled || !saved || !context) return;
    const generation = editGeneration.current;
    const seedSequence = latestSeed.current;
    setBusy(true); setLocalError('');
    try {
      if (await onConfirm(saved.revision, context.mode, context.leaderId, { provider: context.provider, modelId: context.model, reasoningEffort: context.effort })) {
        if (generation === editGeneration.current && seedSequence === latestSeed.current) onClose();
        else { setDirty(true); setStage('edit'); setNotice('此前的保存版已确认。当前新目标仍保留为本地草稿，没有再次派单。'); }
      }
      else setLocalError('未能确认启动结果，请刷新状态后核对；任务书与编辑已保留，勿重复新建目标。');
    } finally { setBusy(false); }
  }
  if (!open) return null;
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal goal-modal" role="dialog" aria-modal="true" aria-labelledby="goal-brief-title">
      <div className="modal-heading"><h2 id="goal-brief-title"><FileText size={18} />任务委托书</h2><button className="icon-button" type="button" title="关闭并保留草稿" onClick={onClose}><X size={18} /></button></div>
      <div className="goal-steps" role="tablist" aria-label="委托书步骤"><button type="button" role="tab" aria-selected={stage === 'edit'} className={stage === 'edit' ? 'selected' : ''} disabled={locked} onClick={() => setStage('edit')}>1 填写草稿</button><button type="button" role="tab" aria-selected={stage === 'preview'} className={stage === 'preview' ? 'selected' : ''} disabled={locked || !saved} onClick={viewSaved}>2 预览保存版</button></div>
      <div className="goal-body" ref={body}>
        {(localError || requestError) && <div className="goal-notice error" role="alert">{localError && <span>{localError}</span>}{requestError && <small>{requestError}</small>}</div>}
        {notice && <p className="goal-notice" role="status">{notice}</p>}
        {objectiveChanged && <p className="goal-notice warning">目标已更改，请复核其余交付物、验收标准和约束；重新保存后才能确认。</p>}
        {(revisionChanged || savedChanged) && <div className="goal-notice warning"><p>保存版已在其他窗口更新。当前编辑没有被覆盖，请重新载入后核对。</p><button className="button secondary" type="button" disabled={locked} onClick={reload}><RefreshCw size={13} />重新载入保存版</button></div>}
        {backup && <div className="goal-notice"><span>此前的本地编辑仍可恢复。</span><button className="button secondary" type="button" disabled={locked} onClick={() => { editGeneration.current += 1; setFields(copyGoalFields(backup)); setDirty(true); setStage('edit'); setBackup(undefined); setNotice('已恢复本地编辑。请对照最新保存版复核，保存后才可确认。'); }}>恢复本地编辑</button></div>}
        {stage === 'edit' ? <>
          <p className="goal-introduction">先写清要交付什么、怎样算完成。带 * 的字段在确认前必填，草稿可不完整保存。这里不会调用模型；需要讨论时，可先在原生主聊天澄清，再把结论填入。</p>
          <form id="goal-brief-form" className="goal-fields" onSubmit={event => { event.preventDefault(); save(); }}>
            {fieldDefinitions.map(field => <label className="goal-field" key={field.key}><span className="goal-field-heading"><strong>{field.label}{field.required ? ' *' : '（可选）'}</strong><small className={fields[field.key].length > goalFieldLimits[field.key] ? 'over-limit' : ''}>{fields[field.key].length}/{goalFieldLimits[field.key]}</small></span><textarea aria-label={'委托书' + field.label} aria-required={field.required || undefined} value={fields[field.key]} rows={field.key === 'constraints' || field.key === 'questions' ? 2 : 3} placeholder={field.example} disabled={locked} onChange={event => { editGeneration.current += 1; const value = event.target.value; if (field.key === 'objective' && saved?.objective.trim() && value.trim() !== saved.objective.trim()) setObjectiveChanged(true); setFields(old => ({ ...old, [field.key]: value })); setDirty(true); setLocalError(''); }} /><small className="goal-field-help">{field.help}</small></label>)}
          </form>
          {tooLong && <p className="goal-notice error" role="alert">内容超出长度限制，请先缩短。不会自动截断你的文字。</p>}
        </> : saved && context ? <>
          <div className="goal-version">保存版 {saved.revision}{confirmed ? ' · 已确认' : ' · 待确认'}{dirty ? ' · 本地还有未保存编辑' : ''}</div>
          <dl className="goal-context"><div><dt>运行模式</dt><dd>{context.mode === 'demo' ? '演示 · 不调用模型' : '真实 · 可能消耗订阅及 API 用量'}</dd></div><div><dt>监工</dt><dd>{context.leaderName} · {context.provider === 'codex' ? 'Codex' : 'DeepSeek'}<br />模型：{context.model === 'default' ? '当前默认模型' : context.model}；思考：{context.effort === 'auto' ? '跟随默认配置' : effortNames[context.effort] || context.effort}</dd></div><div><dt>实际工作目录</dt><dd>{context.workspace || '尚未读取，请更新预览'}<small>以本地服务配置为准，不自动跟随原生项目切换。</small></dd></div><div><dt>自动调用预算</dt><dd>Codex {state.settings.maxProviderCalls?.codex ?? 12} 次；DeepSeek {state.settings.maxProviderCalls?.deepseek ?? 16} 次<small>仅为自动协作调用上限，不是订阅额度百分比。</small></dd></div></dl>
          {changedContext && <div className="goal-notice warning"><p>模式、监工配置或工作目录已变化。请更新预览后再确认。</p><button className="button secondary" type="button" disabled={locked} onClick={() => setContext(previewContext(state, leader, workspace))}><RefreshCw size={13} />更新运行预览</button></div>}
          {fieldDefinitions.map(field => <section className="goal-preview-field" key={field.key}><h3>{field.label}</h3><p>{saved[field.key] || '未填写'}</p></section>)}
          {previewProblems.length > 0 && <div className="goal-notice warning"><strong>还不能开始</strong><ul>{previewProblems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}
          {dirty && <p className="goal-notice warning">存在未保存的本地编辑。请返回填写步骤保存，或重新载入保存版；确认不会使用未保存内容。</p>}
          {state.collaborationMode !== 'cooperative' && <p className="goal-notice warning">请关闭表单并切换「合作」，再回来确认。草稿会保留。</p>}
          {activeExecution && !confirmed && <p className="goal-notice warning">已有执行正在运行或清理。可先保存新草稿，等待完成或停止后再确认；保存不会改动当前工作。</p>}
          {confirmed && <p className="goal-notice">这个版本已经确认，不会再次派单。继续或暂停现有工作请使用状态条。</p>}
        </> : <p className="goal-introduction">请先保存草稿，再预览确认。</p>}
      </div>
      <div className="goal-toolbar"><span>{stage === 'edit' ? '保存不会执行；关闭保留本地编辑' : '仅确认此保存版，不使用未保存内容'}</span><button className="button secondary" type="button" disabled={locked} onClick={refreshStatus}><RefreshCw size={13} />刷新状态</button><button className="button secondary" type="button" onClick={onClose}>关闭</button>{stage === 'edit' ? <button className="button primary" type="submit" form="goal-brief-form" disabled={locked || tooLong}>{locked ? <Loader2 size={14} className="spin" /> : <FileText size={14} />}保存并预览</button> : <button className="button primary" type="button" disabled={confirmDisabled} onClick={confirm}>{locked ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{confirmed ? '已确认' : '确认并开始协作'}</button>}</div>
    </section>
  </div>;
}
