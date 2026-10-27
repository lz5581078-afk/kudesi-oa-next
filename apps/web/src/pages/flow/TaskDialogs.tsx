import { useState } from 'react';
import { DEFAULT_FEEDBACK_PRESET, TASK_FEEDBACK_PRESETS, validateFeedback } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { flowApi } from './flowApi';

const today = () => new Date().toISOString().slice(0, 10);

/** 提交任务：按反馈模板填内容；没有模板就写一句完成情况。也可以“异常提交”（没办成/发现问题，必须写说明）。 */
export function SubmitTaskDialog({ task, onClose, onDone }: {
  task: { id: number; title: string; feedbackPreset?: string | null; completionStandard?: string | null; requiresReview?: boolean | number };
  onClose: () => void; onDone: (status?: string) => void;
}) {
  const preset = task.feedbackPreset ? TASK_FEEDBACK_PRESETS[task.feedbackPreset] : null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [abnormal, setAbnormal] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const review = !!task.requiresReview;
  async function submit() {
    setError('');
    const payload: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim()) payload[k] = v.trim();
    if (abnormal && !note.trim()) return setError('异常提交要写清楚是什么问题');
    if (preset && !abnormal) { const errs = validateFeedback(task.feedbackPreset ?? DEFAULT_FEEDBACK_PRESET, payload); if (errs.length) return setError(errs.join('；')); }
    if (!preset && !abnormal && !note.trim()) return setError('请写一句完成情况');
    setBusy(true);
    try { const r = await flowApi.completeTask(task.id, note.trim() || undefined, { payload: preset ? payload : undefined, abnormal: abnormal || undefined }); onDone(r.status); }
    catch (e) { setError(e instanceof ApiError ? e.message : '提交失败'); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="提交任务" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="modal-head"><strong>提交任务：{task.title}</strong></div>
        <div className="modal-body">
          {task.completionStandard && <p className="muted">完成标准：{task.completionStandard}</p>}
          {review && <p className="muted">这条任务需要监督人复核，提交后进入“待复核”，通过才算完成。</p>}
          {preset && !abnormal && <fieldset className="plain-fieldset"><legend>{preset.name}</legend>
            {preset.fields.map((f) => (
              <label key={f.key}>{f.label}
                {f.type === 'select'
                  ? <select value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}><option value="">（请选择）</option>{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                  : <input type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' || f.type === 'amount' ? 'decimal' : undefined} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}
              </label>
            ))}
          </fieldset>}
          <label>{abnormal ? '异常说明 *' : preset ? '备注（选填）' : '完成情况 *'}<textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <label className="check-line"><input type="checkbox" checked={abnormal} onChange={(e) => setAbnormal(e.target.checked)} /> 异常提交（没办成或发现问题，交给监督人处理）</label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{abnormal ? '异常提交' : review ? '提交复核' : '完成'}</button></div>
      </form>
    </div>
  );
}

/** 申请延期：写新的截止日期和原因，监督人（没有就是指派人）同意后生效。 */
export function DelayDialog({ task, onClose, onDone }: { task: { id: number; title: string }; onClose: () => void; onDone: () => void }) {
  const [dueDate, setDueDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="申请延期" onSubmit={async (e) => {
        e.preventDefault();
        if (!dueDate) return setError('请选择新的截止日期');
        if (!reason.trim()) return setError('请写明延期原因');
        setBusy(true);
        try { await flowApi.delayTask(task.id, dueDate, reason.trim()); onDone(); } catch (err) { setError(err instanceof ApiError ? err.message : '提交失败'); setBusy(false); }
      }}>
        <div className="modal-head"><strong>申请延期：{task.title}</strong></div>
        <div className="modal-body">
          <label>新的截止日期 *<input type="date" min={today()} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
          <label>延期原因 *<textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>提交申请</button></div>
      </form>
    </div>
  );
}
