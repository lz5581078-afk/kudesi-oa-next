import { useCallback, useEffect, useState } from 'react';
import { FLOW_ACTION_LABEL, PURCHASE_TEMPLATE, RUN_STATUS_LABEL, STEP_TYPE_LABEL } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { ReasonDialog, loadRefOptions } from '../../resources/RecordForm';
import { FlowFieldsForm, FlowValues } from './FlowFields';
import { RUN_TONE, flowApi, fmtTime, type RunDetailDto } from './flowApi';
import { copyText, dwell } from './flowUi';
import { PurchasePanel } from './PurchasePanel';
import { SKU_TEMPLATE, SkuPreview } from './SkuApply';

type Dialog = null | 'return' | 'cancel' | 'reject' | 'withdraw' | 'transfer';

/** 流程详情：表单内容、办理时间线、当前能做的操作。操作按钮完全由服务端返回的 me 决定。 */
export function RunDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const [run, setRun] = useState<RunDetailDto | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [comment, setComment] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<Array<{ value: number; label: string }>>([]);
  const [toUser, setToUser] = useState<number | ''>('');
  const [toReason, setToReason] = useState('');

  const [msg, setMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const reload = useCallback(() => {
    setRefreshing(true);
    flowApi.run(id).then((r) => { setRun(r); setError(''); }).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')).finally(() => setRefreshing(false));
  }, [id]);
  useEffect(reload, [reload]);
  // 按 Esc 关闭（有子弹窗时先关子弹窗）
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !dialog && !editing) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [dialog, editing, onClose]);
  async function copyLink() {
    const url = `${window.location.origin}${window.location.pathname}?run=${id}`;
    setMsg((await copyText(url)) ? '链接已复制，发给同事即可打开（对方要有权限查看）' : `复制失败，请手动复制：${url}`);
  }
  useEffect(() => { if (dialog === 'transfer') loadRefOptions('user').then(setUsers).catch(() => undefined); }, [dialog]);

  async function act(fn: () => Promise<RunDetailDto>) {
    setBusy(true);
    setError('');
    try {
      const next = await fn();
      setRun(next);
      setForm({});
      setComment('');
      setDialog(null);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  if (!run) return <div className="modal-backdrop"><div className="modal card"><div className="modal-body">{error ? <div role="alert" className="notice error">{error}</div> : '加载中…'}<button type="button" className="secondary-button" onClick={onClose}>关闭</button></div></div></div>;
  const rev = run.revision;
  const stepId = run.activeStep?.id ?? 0;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="流程详情" style={{ width: 'min(900px, 100%)' }}>
        <div className="modal-head between">
          <div>
            <strong>{run.title}</strong>{' '}
            <span className={`pill ${RUN_TONE[run.status] ?? ''}`}>{RUN_STATUS_LABEL[run.status as keyof typeof RUN_STATUS_LABEL]}</span>
            <div className="muted">{run.templateLabel} · 发起人 {run.requesterName} · {fmtTime(run.createdAt)} · 编号 #{run.id}</div>
          </div>
          <div className="row-actions">
            <button type="button" className="secondary-button small" onClick={() => void copyLink()}>复制链接</button>
            <button type="button" className="secondary-button small" disabled={refreshing} onClick={reload}>刷新</button>
            <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          {msg && <div role="status" className="notice ok-notice toast-line"><span>{msg}</span><button type="button" aria-label="关闭提示" onClick={() => setMsg('')}>✕</button></div>}
          {run.status !== 'running' && (
            <div className={`result-banner ${run.status === 'completed' ? 'ok' : run.status === 'rejected' ? 'bad' : 'muted'}`} role="status">
              流程{RUN_STATUS_LABEL[run.status as keyof typeof RUN_STATUS_LABEL]}{run.finishedAt && ` · ${fmtTime(run.finishedAt)}`}
            </div>
          )}
          <ol className="step-progress" aria-label="办理进度">
            {run.steps.map((s) => <li key={s.id} className={s.status === 'active' ? 'active' : s.status === 'done' ? 'done' : s.status === 'transferred' ? 'done' : 'bad'}>{s.name}</li>)}
          </ol>
          <section>
            <h3 className="section-title">申请内容</h3>
            {editing ? (
              <>
                <FlowFieldsForm fields={run.fields} templateKey={run.templateKey} values={editing} labels={run.refLabels} onChange={(k, v) => setEditing({ ...editing, [k]: v })} />
                <div className="row-actions">
                  <button type="button" className="primary-button" disabled={busy} onClick={() => act(() => flowApi.resubmit(run.id, { revision: rev, payload: editing }))}>重新提交</button>
                  <button type="button" className="secondary-button" onClick={() => setEditing(null)}>取消修改</button>
                </div>
              </>
            ) : <FlowValues fields={run.fields} values={run.payload} labels={run.refLabels} />}
            {run.templateKey === SKU_TEMPLATE && !editing && <SkuPreview runId={run.id} refreshKey={run.revision} />}
            {run.templateKey === PURCHASE_TEMPLATE && !editing && <PurchasePanel runId={run.id} refreshKey={run.revision} onChanged={() => { reload(); onChanged(); }} />}
            {(run.links.docNo || run.links.borrowRecordId) && (
              <p className="muted">
                {run.links.docNo && <>已生成并过账单据 <span className="mono">{run.links.docNo}</span>（在“财务 → 经营历程”查看）。 </>}
                {run.links.borrowRecordId && <>已登记借用记录（在“资料 → 营业执照”详情里查看）。</>}
              </p>
            )}
          </section>

          {run.activeStep && (
            <section>
              <h3 className="section-title">当前步骤：{run.activeStep.name}（{STEP_TYPE_LABEL[run.activeStep.type as keyof typeof STEP_TYPE_LABEL]}）</h3>
              <p className="muted">
                办理人：{run.activeStep.recipients.map((r) => r.name).join('、')}
                {run.activeStep.recipients.length > 1 && '（任一人办理即可）'}
                {run.activeStep.dueAt && <> · 截止 {fmtTime(run.activeStep.dueAt)}</>}
                {run.activeStep.enteredVia === 'return' && ' · 被退回'}
                {run.steps.find((x) => x.id === run.activeStep!.id)?.enteredAt && <> · 已停留 {dwell(run.steps.find((x) => x.id === run.activeStep!.id)!.enteredAt)}</>}
              </p>
              {run.me.canPass && (
                <>
                  {run.me.stepFields.length > 0 && <FlowFieldsForm fields={run.me.stepFields} templateKey={run.templateKey} context={run.payload} stepKey={run.activeStep.key} runId={run.id} refreshKey={run.revision} values={form} onChange={(k, v) => setForm((cur) => ({ ...cur, [k]: v }))} />}
                  {run.templateKey !== PURCHASE_TEMPLATE && <label>意见（选填）<textarea rows={2} value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} /></label>}
                </>
              )}
              <div className="row-actions">
                {run.me.canPass && <button type="button" className="primary-button" disabled={busy} onClick={() => act(() => flowApi.pass(run.id, { revision: rev, stepId, form, comment: comment || undefined }))}>办理通过</button>}
                {run.me.canResubmit && <button type="button" className="primary-button" onClick={() => setEditing({ ...run.payload })}>修改后重新提交</button>}
                {run.me.canReturn && <button type="button" className="secondary-button" onClick={() => setDialog('return')}>退回上一步</button>}
                {run.me.canReject && <button type="button" className="secondary-button" onClick={() => setDialog('reject')}>拒绝</button>}
                {run.me.canCancel && <button type="button" className="secondary-button" onClick={() => setDialog('cancel')}>废除</button>}
                {run.me.canWithdraw && <button type="button" className="secondary-button" onClick={() => setDialog('withdraw')}>撤回申请</button>}
                {run.me.canTransfer && <button type="button" className="secondary-button" onClick={() => setDialog('transfer')}>转交他人</button>}
              </div>
              {!run.me.canPass && !run.me.canReturn && !run.me.canCancel && !run.me.canReject && !run.me.canWithdraw && !run.me.canTransfer && !run.me.canResubmit && (
                <p className="muted">现在轮到上面的办理人处理，你暂时没有可办理的操作。</p>
              )}
              {run.me.cancelBlockedReason && <p className="muted">不能废除/拒绝：{run.me.cancelBlockedReason}</p>}
              {run.me.returnBlockedReason && <p className="muted">不能退回：{run.me.returnBlockedReason}</p>}
            </section>
          )}

          <section>
            <h3 className="section-title">办理记录</h3>
            <ol className="timeline">
              {run.steps.map((s) => (
                <li key={s.id} className={s.status === 'active' ? 'active' : s.status === 'done' ? 'done' : 'bad'}>
                  <strong>{s.name}</strong> <span className="muted">· {s.status === 'active' ? '办理中' : s.action ? FLOW_ACTION_LABEL[s.action] : ''}</span>
                  <div className="muted">
                    {s.status === 'active' ? `办理人：${s.recipients.join('、')}` : `${s.handledByName ?? ''} · ${fmtTime(s.finishedAt)}`}
                    {s.dueAt && s.status === 'active' && <> · 截止 {fmtTime(s.dueAt)}</>}
                  </div>
                  {s.comment && <div>“{s.comment}”</div>}
                  {s.form && Object.keys(s.form).length > 0 && (
                    <FlowValues fields={(run.stepFields[s.key] ?? []).filter((f) => s.form![f.key] !== undefined)} values={s.form} labels={s.formRefLabels} />
                  )}
                </li>
              ))}
            </ol>
            {run.ccs.length > 0 && <p className="muted">抄送：{run.ccs.map((c) => c.name).join('、')}</p>}
          </section>

          {run.events.length > 0 && (
            <details>
              <summary>全部操作记录（{run.events.length}）</summary>
              <ul className="event-list">
                {run.events.map((ev) => (
                  <li key={ev.id} className="log-item"><strong>{FLOW_ACTION_LABEL[ev.action]}</strong> · {ev.actorName} · <span className="muted">{fmtTime(ev.createdAt)}</span>{ev.note && <div>“{ev.note}”</div>}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
      </div>

      {dialog === 'return' && <ReasonDialog title="退回上一步" confirmLabel="退回" onClose={() => setDialog(null)} onConfirm={(reason) => act(() => flowApi.back(run.id, { revision: rev, stepId, reason }))} />}
      {dialog === 'reject' && <ReasonDialog title="拒绝申请" hint="拒绝后流程结束。" confirmLabel="拒绝" danger onClose={() => setDialog(null)} onConfirm={(reason) => act(() => flowApi.reject(run.id, { revision: rev, stepId, reason }))} />}
      {dialog === 'cancel' && <ReasonDialog title="废除流程" hint="废除后流程结束。" confirmLabel="废除" danger onClose={() => setDialog(null)} onConfirm={(reason) => act(() => flowApi.cancel(run.id, { revision: rev, stepId, reason }))} />}
      {dialog === 'withdraw' && <ReasonDialog title="撤回申请" confirmLabel="撤回" danger onClose={() => setDialog(null)} onConfirm={(reason) => act(() => flowApi.withdraw(run.id, { revision: rev, reason }))} />}
      {dialog === 'transfer' && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal card small" role="dialog" aria-label="转交他人" onSubmit={(e) => { e.preventDefault(); if (!toUser || toReason.trim().length < 2) return setError('请选择转交给谁，并写原因'); void act(() => flowApi.transfer(run.id, { revision: rev, toUserId: Number(toUser), reason: toReason.trim() })); }}>
            <div className="modal-head"><strong>转交他人</strong></div>
            <div className="modal-body">
              <label>转交给
                <select value={toUser} onChange={(e) => setToUser(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">（选择员工）</option>
                  {users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                </select>
              </label>
              <label>原因<textarea rows={3} value={toReason} maxLength={500} onChange={(e) => setToReason(e.target.value)} /></label>
            </div>
            <div className="modal-foot">
              <button type="button" className="secondary-button" onClick={() => setDialog(null)}>取消</button>
              <button type="submit" className="primary-button" disabled={busy}>转交</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

