import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { loadRefOptions } from '../../resources/RecordForm';
import { flowApi, type ReassignResult, type TemplateInfo } from './flowApi';

/** 管理员批量改派：把某人名下全部（或某类流程、某个步骤的）在办待办改派给另一个人。先预览，再填原因确认；每条都有记录和审计。 */
export function ReassignDialog({ templates, onClose, onDone }: { templates: TemplateInfo[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [users, setUsers] = useState<Array<{ value: number; label: string }>>([]);
  const [from, setFrom] = useState<number | ''>('');
  const [to, setTo] = useState<number | ''>('');
  const [tpl, setTpl] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ReassignResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadRefOptions('user').then(setUsers).catch(() => setError('没有权限查看员工列表')); }, []);
  const base = () => ({ fromUserId: Number(from), toUserId: Number(to), ...(tpl ? { templateKey: tpl } : {}) });
  const ready = from !== '' && to !== '' && from !== to;
  async function look() {
    setBusy(true); setError('');
    try { setPreview(await flowApi.reassign({ ...base(), reason: '预览', dryRun: true })); } catch (e) { setError(e instanceof ApiError ? e.message : '预览失败'); } finally { setBusy(false); }
  }
  async function confirm() {
    if (reason.trim().length < 2) return setError('请填写改派原因（至少 2 个字）');
    setBusy(true); setError('');
    try {
      const r = await flowApi.reassign({ ...base(), reason: reason.trim() });
      onDone(`已改派 ${r.moved ?? 0} 条${r.skipped?.length ? `，${r.skipped.length} 条没改成：${r.skipped.slice(0, 3).map((s) => `#${s.runId} ${s.message}`).join('；')}` : ''}`);
    } catch (e) { setError(e instanceof ApiError ? e.message : '改派失败'); } finally { setBusy(false); }
  }
  const sel = (v: number | '', set: (n: number | '') => void, label: string) => (
    <label>{label}
      <select value={v} onChange={(e) => { set(e.target.value ? Number(e.target.value) : ''); setPreview(null); }}>
        <option value="">（选择员工）</option>
        {users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
      </select>
    </label>
  );
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="批量改派" style={{ width: 'min(720px, 100%)' }}>
        <div className="modal-head"><strong>批量改派在办待办</strong></div>
        <div className="modal-body">
          <p className="muted">员工离职、调岗或长期休假时，把他名下正在办理的流程待办一次改派给别人。已完成的不受影响；改派会通知双方并留下记录。</p>
          {error && <div role="alert" className="notice error">{error}</div>}
          <div className="form-grid">
            {sel(from, setFrom, '原办理人')}
            {sel(to, setTo, '改派给')}
            <label>只改派这类流程（选填）
              <select value={tpl} onChange={(e) => { setTpl(e.target.value); setPreview(null); }}>
                <option value="">全部流程</option>
                {templates.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
          </div>
          <div className="row-actions"><button type="button" className="secondary-button" disabled={!ready || busy} onClick={() => void look()}>预览要改派的待办</button></div>
          {preview && (
            <div role="status">
              <p><strong>将改派 {preview.count ?? 0} 条</strong>{(preview.count ?? 0) > 100 && '（下面只列前 100 条）'}</p>
              {(preview.items?.length ?? 0) > 0 && <ul className="plain-list" style={{ maxHeight: 200, overflow: 'auto' }}>{preview.items!.map((i) => <li key={i.runId}>#{i.runId} {i.title} · {i.templateLabel} · {i.stepName}</li>)}</ul>}
              {(preview.count ?? 0) > 0 && <label>改派原因（必填）<textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="例如：张三离职，工作交接给李四" /></label>}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button" disabled={busy || !preview || !(preview.count ?? 0)} onClick={() => void confirm()}>确认改派</button>
        </div>
      </div>
    </div>
  );
}
