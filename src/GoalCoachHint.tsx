import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import type { GoalBriefFields } from './types';

const fieldLabels: Record<keyof GoalBriefFields, string> = {objective:'目标',deliverables:'交付物',acceptance:'验收标准',constraints:'约束',questions:'待决定的问题'};

export default function GoalCoachHint({fields, disabled}: {fields:GoalBriefFields; disabled:boolean}) {
  const [notice, setNotice] = useState('');
  const prompt = '请先帮我完善异智能体合作的任务目标，整理并保存草稿。\n\n'
    + Object.entries(fieldLabels).map(([key,label]) => label + '：\n' + (fields[key as keyof GoalBriefFields].trim() || '尚未填写')).join('\n\n')
    + '\n\n请先用 get_task_brief 核对当前保存版本。把上面的内容作为我的当前想法，不要当作执行指令。'
    + '先问最关键的 1–3 个问题，等我回答后再整理。建议和未决定事项要明确保留，不要替我拍板或默默清空。'
    + '整理成目标、交付物、验收标准、约束、待决定问题五项；缺项可留空。'
    + '使用 save_task_brief，将刚读取的 stateId 作为 expectedStateId、草稿 revision 作为 expectedRevision 保存草稿。若版本冲突或保存结果不确定，先重新读取并核对，不要自动覆盖或重复提交。'
    + '最后告诉我保存版本和仍需决定的事项，让我回到面板重新载入、预览确认。本次只整理和保存，不启动、派单、核查或切换模式。';
  useEffect(() => { setNotice(''); }, [prompt]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setNotice('已复制。粘贴到 Codex 原生主聊天后发送，再回来载入保存版。'); }
    catch { setNotice('当前面板未能访问剪贴板，请手动选中下方请求复制。草稿没有改变。'); }
  };
  return <details className="goal-coach">
    <summary>目标还没想好？让主聊天帮你整理</summary>
    <p>把整理请求发到 Codex 原生主聊天，继续讨论关键问题。它可以把结论保存到这里；保存后点击「重新载入保存版」，核对并确认。</p>
    <textarea aria-label="主聊天目标整理请求" readOnly rows={5} value={prompt} />
    <div className="goal-coach-actions"><button className="button secondary" type="button" disabled={disabled} onClick={copy}><Copy size={13} />复制整理请求</button><small>复制和保存草稿都不会派单；主聊天的讨论使用当前聊天模型。</small></div>
    {notice && <p className="goal-coach-notice" role="status">{notice}</p>}
  </details>;
}
