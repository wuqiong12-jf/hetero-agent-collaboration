import { useEffect, useId, useRef, useState } from 'react';

type Props = { id?: string; label: string; value: number; used?: number; min?: number; max?: number; disabled: boolean; onSave: (value: number, expectedValue: number) => Promise<boolean> };

export default function BudgetField({ id, label, value, used, min = 1, max = 100, disabled, onSave }: Props) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const noticeId = `${inputId}-notice`;
  const field = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState({ text: String(value), base: value });
  const [failure, setFailure] = useState('');
  const dirty = edit.text !== String(edit.base);
  const conflict = dirty && value !== edit.base;
  useEffect(() => {
    if (!saving) setEdit(old => old.text === String(old.base) ? { text: String(value), base: value } : old);
  }, [value, saving]);

  async function save() {
    if (disabled || inFlight.current || !dirty || conflict) return;
    const number = Number(edit.text);
    if (!edit.text.trim() || !Number.isInteger(number) || number < min || number > max) {
      setFailure(`请输入 ${min}–${max} 的整数，输入尚未保存。`); return;
    }
    if (number === edit.base) { setEdit({ text: String(number), base: number }); setFailure(''); return; }
    inFlight.current = true; setSaving(true); setFailure('');
    try {
      if (await onSave(number, edit.base)) setEdit({ text: String(number), base: number });
      else setFailure('保存未完成，输入已保留。可重试或采用最新值。');
    } catch { setFailure('保存未完成，输入已保留。可重试或采用最新值。'); }
    finally { inFlight.current = false; setSaving(false); }
  }
  const discard = () => { setEdit({ text: String(value), base: value }); setFailure(''); };
  return <div className="budget-field" ref={field}>
    <label className="workflow-field inline" htmlFor={inputId}>{label}<input id={inputId} type="number" aria-label={label} aria-describedby={conflict || failure ? noticeId : undefined} aria-invalid={Boolean(failure && !conflict)} min={min} max={max} value={edit.text} disabled={disabled || saving}
      onChange={event => { setEdit(old => ({ ...old, text: event.target.value })); setFailure(''); }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save(); } }}
      onBlur={event => { if (!field.current?.contains(event.relatedTarget)) void save(); }} />{used !== undefined && <small>自动已用 {used} 次</small>}</label>
    {(conflict || failure) && <div id={noticeId} className="budget-notice" role="status"><span>{conflict ? `此项已在其它窗口更新为 ${value}。你的输入 ${edit.text || '（空）'} 已保留，尚未覆盖最新值。` : failure}</span><div>
      {!conflict && <button type="button" className="button secondary" disabled={disabled || saving} onClick={() => void save()}>重试保存</button>}
      <button type="button" className="button secondary" disabled={disabled || saving} onClick={discard}>采用最新值</button>
    </div></div>}
  </div>;
}
