import type { RecoveryIssue, RecoverySettingKey, RecoveryStep, State, TaskStatus } from './types';

const statusLabels: Record<TaskStatus, string> = { accepted: '已通过', reviewing: '待核查', queued: '待执行', rejected: '待返工', running: '执行中', cancelled: '已取消' };
const progressOrder: TaskStatus[] = ['accepted', 'reviewing', 'queued', 'rejected', 'running', 'cancelled'];
const actionLabels: Record<RecoveryStep['nextAction'], string> = { accepted: '保留已通过结果', cancelled: '保留取消状态', 'wait-running': '等待当前执行结束', 'wait-dependencies': '等待前置任务通过', 'review-output': '核查已有交付', 'run-worker': '交给工作者执行' };

type Props = {
  state: State;
  pending: boolean;
  connected: boolean;
  channelReason: string;
  reviewReason: (taskId: string) => string;
  onReview: (taskId: string) => void;
  onSetting: (settingKey: RecoverySettingKey | 'autoReview') => void;
  onRetrySave: () => void;
  onGoal: () => void;
  onTeam: () => void;
  onCooperation: () => void;
};

export default function RecoveryPanel({ state, pending, connected, channelReason, reviewReason, onReview, onSetting, onRetrySave, onGoal, onTeam, onCooperation }: Props) {
  const summary = state.recovery?.summary;
  if (!summary) return <section className="recovery-panel" aria-label="恢复与进度"><strong>恢复信息待同步</strong><p className="context-note">本地服务尚未提供当前目标的恢复摘要。同步后才能确认继续条件。</p></section>;
  const total = progressOrder.reduce((count, key) => count + summary.progress[key], 0);
  const upcoming = summary.steps.filter(step => !['accepted', 'cancelled'].includes(step.status));
  const lastAcceptedDate = summary.lastAccepted ? new Date(summary.lastAccepted.at) : null;
  const lastAcceptedAt = lastAcceptedDate && !Number.isNaN(lastAcceptedDate.getTime()) ? ' · ' + lastAcceptedDate.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const issue = (item: RecoveryIssue, key: string) => <div className="recovery-issue" key={key}>
    <strong>{item.title}</strong><p>{item.detail}</p>
    {item.settingKey && <button className="button secondary" type="button" onClick={() => onSetting(item.settingKey!)}>查看对应预算设置</button>}
    {item.action === 'retry-save' && <><button className="button secondary" type="button" disabled={pending || !connected} onClick={onRetrySave}>重试保存</button><small>只保存当前状态，保持暂停。</small></>}
    {item.action === 'goal' && <button className="button secondary" type="button" onClick={onGoal}>编写任务委托书</button>}
    {item.action === 'team' && <button className="button secondary" type="button" onClick={onTeam}>查看团队设置</button>}
    {item.action === 'cooperation' && <button className="button secondary" type="button" disabled={pending || !connected} onClick={onCooperation}>切换为合作</button>}
    {item.action === 'manual-review' && <button className="button secondary" type="button" onClick={() => onSetting('autoReview')}>查看自动核查设置</button>}
  </div>;
  const stepCard = (step: RecoveryStep, allowReview: boolean) => {
    const task = state.tasks.find(item => item.id === step.taskId);
    const reason = reviewReason(step.taskId);
    return <article className="recovery-step" key={step.taskId}>
      <div className="recovery-step-heading"><strong>{step.title}</strong><span>{statusLabels[step.status]}</span></div>
      <p>{actionLabels[step.nextAction]}{step.interrupted ? ' · 曾启动过，再次派单可能重做' : ''}</p>
      <small>工作者已启动 {step.attempt} 次 · 核查已启动 {step.reviewAttempts} 次 · {step.hasOutput ? '已有交付输出' : '尚无交付输出'}</small>
      {step.issues.map((item, index) => issue(item, step.taskId + ':' + index))}
      {allowReview && step.nextAction === 'review-output' && !task?.reviewError && <div className="recovery-review-actions"><button className="button secondary" type="button" disabled={Boolean(reason)} title={reason || '复用当前交付，只启动核查'} onClick={() => onReview(step.taskId)}>核查已有交付</button>{reason && <small>{reason}</small>}</div>}
    </article>;
  };
  return <section className="recovery-panel" aria-label="恢复与进度">
    <div className="recovery-heading"><strong>当前目标进度</strong><span>{summary.progress.accepted}/{total} 项已通过</span></div>
    <div className="recovery-progress" aria-label="任务状态数量">{progressOrder.map(key => <div key={key}><strong>{summary.progress[key]}</strong><span>{statusLabels[key]}</span></div>)}</div>
    <p className="recovery-last">最近通过：{summary.lastAccepted ? summary.lastAccepted.title + lastAcceptedAt : '当前目标尚无通过记录'}</p>
    {summary.globalIssues.map((item, index) => issue(item, 'global:' + index))}
    {summary.lastError && <details className="recovery-details"><summary>上次停止提示</summary><p className="context-note">{summary.lastError}</p><small>这是上次记录的提示；当前条件以本次结构化诊断为准。</small></details>}
    {upcoming.length > 0 ? <div className="recovery-upcoming"><strong>接下来</strong>{upcoming.slice(0, 3).map(step => stepCard(step, true))}{upcoming.length > 3 && <small>还有 {upcoming.length - 3} 项，展开任务明细查看。</small>}</div> : <p className="context-note">{total ? '当前目标没有待执行或待核查的任务。' : '当前目标尚未拆分任务；继续后由监工规划。'}</p>}
    <details className="recovery-details"><summary>任务明细 · {total} 项</summary><div>{summary.steps.map(step => stepCard(step, !upcoming.slice(0, 3).some(item => item.taskId === step.taskId)))}</div></details>
    <p className="context-note">继续会保留已通过结果；待核查任务复用已有输出；曾启动后回到待执行的任务可能重做。恢复按任务状态继续，不保证从执行中断的代码位置续跑。人工核查通过后，开启「核查后继续分工」时可继续执行下游任务。</p>
    {summary.resume.allowed ? <p className="recovery-readiness">{channelReason || (summary.resume.needsCapabilityCheck ? '结构条件允许继续；真实执行前仍会确认所需模型渠道。' : '结构条件允许继续。')}</p> : <p className="recovery-readiness">当前结构条件未允许继续，请先处理上面的提示。</p>}
  </section>;
}
