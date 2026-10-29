import { useCallback, useEffect, useMemo, useState } from 'react';
import { FLOW_ACTION_LABEL } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { ReasonDialog } from '../../resources/RecordForm';
import { RunDetail } from './RunDetail';
import { SkuWarehouseFields, skuBatchApi, type BatchBoard, type BatchOutcome } from './SkuApply';
import { fmtTime } from './flowApi';

const RUN_WORD: Record<string, string> = { running: '办理中', completed: '已完成', cancelled: '已废除', rejected: '被拒绝' };
type Dlg = null | 'return' | 'returnAll' | 'reject' | 'cancel' | 'pass';

/**
 * SKU 申请汇总：一张申请单一个入口，里面每个规格一行。
 * 办理人可以勾选规格批量通过 / 批量退回 / 整单退回 / 废除 / 拒绝；申请人在这里看到被退回的规格和原因，修改后重新提交。
 * 每个规格仍是独立的流程，所有动作都走流程引擎（办理资格、版本号、校验、审计都和单条办理一样）。
 */
export function SkuBatchPanel({ batchKey, onClose, onChanged }: { batchKey: string; onClose: () => void; onChanged: () => void }) {
  const [board, setBoard] = useState<BatchBoard | null>(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [dlg, setDlg] = useState<Dlg>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; failed: BatchOutcome['results'] } | null>(null);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [whForm, setWhForm] = useState<Record<string, unknown>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [sync, setSync] = useState(false);

  const load = useCallback(() => {
    skuBatchApi.board(batchKey).then((b) => { setBoard(b); setError(''); }).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [batchKey]);
  useEffect(load, [load]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !dlg && !openRun) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [dlg, openRun, onClose]);

  const hold = board?.me.holdStepKey ?? null;
  // 你名下可批量办理的规格：停在你手里的那一步；申请人则是被退回等你修改的规格
  const handleable = useMemo(() => (board?.items ?? []).filter((i) => (i.mine && i.stepKey === hold) || i.canResubmit), [board, hold]);
  const mineIds = useMemo(() => handleable.filter((i) => i.mine).map((i) => i.runId), [handleable]);
  const selected = (board?.items ?? []).filter((i) => sel.has(i.runId));
  const toggle = (id: number) => setSel((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allMine = mineIds.length > 0 && mineIds.every((id) => sel.has(id));
  const items = selected.filter((i) => i.mine).map((i) => ({ runId: i.runId, revision: i.revision, stepId: i.stepId ?? undefined }));

  async function run(fn: () => Promise<BatchOutcome>, word: string) {
    setBusy(true);
    setError('');
    try {
      const r = await fn();
      setOutcome({ text: `${word}：成功 ${r.ok} 个${r.failed ? `，失败 ${r.failed} 个` : ''}`, failed: r.results.filter((x) => !x.ok) });
      setSel(new Set());
      setDlg(null);
      load();
      onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : '操作失败'); } finally { setBusy(false); }
  }
  const nameOf = (id: number) => board?.items.find((i) => i.runId === id)?.specName ?? `#${id}`;
  const isWarehouse = hold === 'warehouse';
  const isReview = hold === 'review';

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card sku-batch-panel" role="dialog" aria-label="申请汇总" style={{ width: 'min(960px, 100%)' }}>
        <div className="modal-head between">
          <div>
            <strong>{board?.batchName || '申请汇总'}</strong>
            {board && <div className="muted">发起人 {board.requesterName} · 共 {board.total} 个规格 · 办理中 {board.counts.running} · 已完成 {board.counts.completed} · 已结束 {board.counts.ended}{board.counts.returned > 0 && <> · <span className="late-text">被退回 {board.counts.returned}</span></>}</div>}
          </div>
          <div className="row-actions">
            <button type="button" className="secondary-button small" onClick={load}>刷新</button>
            <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          {outcome && (
            <div role="status" className={`notice ${outcome.failed.length ? 'error' : 'ok-notice'} toast-line`}>
              <span>{outcome.text}{outcome.failed.map((f) => <span key={f.runId} className="sub-line">· {nameOf(f.runId)}：{f.message}</span>)}</span>
              <button type="button" aria-label="关闭提示" onClick={() => setOutcome(null)}>✕</button>
            </div>
          )}
          {!board && !error && <p className="muted">加载中…</p>}
          {board && handleable.length > 0 && (
            <div className="batch-bar" role="toolbar" aria-label="批量办理">
              <label className="check"><input type="checkbox" checked={allMine} onChange={() => setSel(allMine ? new Set() : new Set(handleable.map((i) => i.runId)))} /> 全选我名下的（{handleable.length}）</label>
              <span className="muted">已选 {sel.size} 个</span>
              {mineIds.length > 0 && <>
                <button type="button" className="primary-button" disabled={busy || !items.length} onClick={() => (isWarehouse || isReview ? setDlg('pass') : void run(() => skuBatchApi.act({ ref: batchKey, action: 'pass', items }), '批量通过'))}>批量通过</button>
                <button type="button" className="secondary-button" disabled={busy || !items.length} onClick={() => setDlg('return')}>批量退回</button>
                {board.me.canReturnAll && <button type="button" className="secondary-button" disabled={busy} onClick={() => setDlg('returnAll')}>整单退回（全部 {board.me.holdCount} 个）</button>}
                <button type="button" className="secondary-button" disabled={busy || !items.length} onClick={() => setDlg('reject')}>拒绝</button>
                <button type="button" className="secondary-button" disabled={busy || !items.length} onClick={() => setDlg('cancel')}>废除</button>
              </>}
              {board.items.some((i) => i.canResubmit && sel.has(i.runId)) && (
                <button type="button" className="primary-button" disabled={busy} onClick={() => void run(() => skuBatchApi.act({ ref: batchKey, action: 'resubmit', items: selected.filter((i) => i.canResubmit).map((i) => ({ runId: i.runId, revision: i.revision })) }), '原样重新提交')}>原样重新提交</button>
              )}
            </div>
          )}
          {board && (
            <div className="table-scroll"><table className="data-table stack-mobile">
              <thead><tr><th /><th>规格</th><th>当前</th><th>办理人</th><th>截止</th><th /></tr></thead>
              <tbody>
                {board.items.map((i) => {
                  const can = handleable.some((h) => h.runId === i.runId);
                  return (
                    <tr key={`${i.runId}-${i.specIndex}`} className={i.overdue ? 'late' : undefined}>
                      <td>{can && i.specIndex === 0 && <input type="checkbox" aria-label={`选择 ${i.specName}`} checked={sel.has(i.runId)} onChange={() => toggle(i.runId)} />}</td>
                      <td className="cell-title"><strong>{i.specName}</strong>{i.specCount > 1 && <span className="sub-line">同一条流程含 {i.specCount} 个规格，一起办理</span>}
                        {i.enteredVia === 'return' && i.runStatus === 'running' && <span className="sub-line late-text"><span className="pill warn">被退回</span> {i.returnedBy ? `${i.returnedBy}：` : ''}{i.returnReason}</span>}</td>
                      <td data-label="当前">{i.runStatus === 'running' ? i.stepName : RUN_WORD[i.runStatus] ?? i.runStatus}</td>
                      <td data-label="办理人">{i.runStatus === 'running' ? i.recipients.join('、') : ''}{i.mine && <span className="pill">我</span>}</td>
                      <td data-label="截止">{i.dueAt && i.runStatus === 'running' ? fmtTime(i.dueAt) : '—'}</td>
                      <td className="row-actions"><button type="button" className="secondary-button small" onClick={() => setOpenRun(i.runId)}>{i.canResubmit ? '修改并重新提交' : '查看'}</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
          {board && board.history.length > 0 && (
            <details>
              <summary>办理历史（{board.history.length}）</summary>
              <ul className="event-list">
                {board.history.map((h) => <li key={h.id} className="log-item"><strong>{FLOW_ACTION_LABEL[h.action as keyof typeof FLOW_ACTION_LABEL] ?? h.action}</strong> · {h.actorName} · {h.specNames.join('、')} · <span className="muted">{fmtTime(h.createdAt)}</span>{h.note && <div>“{h.note}”</div>}</li>)}
              </ul>
            </details>
          )}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
      </div>

      {dlg === 'return' && <ReasonDialog title={`批量退回 ${items.length} 个规格`} hint="退回原因必填，申请人会收到一条汇总通知。" confirmLabel="退回" suggestions={['资料有误', '数量不对', '请补充说明']} onClose={() => setDlg(null)} onConfirm={(reason) => run(() => skuBatchApi.act({ ref: batchKey, action: 'return', items, comment: reason }), '批量退回')} />}
      {dlg === 'reject' && <ReasonDialog title={`拒绝 ${items.length} 个规格`} hint="拒绝后这些规格的流程结束。" confirmLabel="拒绝" danger suggestions={['不符合要求', '重复申请']} onClose={() => setDlg(null)} onConfirm={(reason) => run(() => skuBatchApi.act({ ref: batchKey, action: 'reject', items, comment: reason }), '批量拒绝')} />}
      {dlg === 'cancel' && <ReasonDialog title={`废除 ${items.length} 个规格`} hint="废除后这些规格的流程结束。" confirmLabel="废除" danger suggestions={['不再需要', '重复申请']} onClose={() => setDlg(null)} onConfirm={(reason) => run(() => skuBatchApi.act({ ref: batchKey, action: 'cancel', items, comment: reason }), '批量废除')} />}
      {dlg === 'returnAll' && board && <ReasonDialog title={`整单退回（${board.me.holdCount} 个规格）`} hint="这一步申请单里的全部规格一起退回，要么全退要么都不退；退回原因必填。" confirmLabel="整单退回" suggestions={['资料有误', '请补充说明']} onClose={() => setDlg(null)}
        onConfirm={async (reason) => { setBusy(true); try { const r = await skuBatchApi.returnAll({ ref: batchKey, items: board.items.filter((i) => i.mine && i.stepKey === hold).map((i) => ({ runId: i.runId, revision: i.revision, stepId: i.stepId ?? undefined })), reason }); setOutcome({ text: `整单退回：${r.count} 个规格已退回`, failed: [] }); setSel(new Set()); setDlg(null); load(); onChanged(); } finally { setBusy(false); } }} />}
      {dlg === 'pass' && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal card" role="dialog" aria-label="批量通过" style={{ width: 'min(900px, 100%)' }} onSubmit={(e) => { e.preventDefault(); void run(() => skuBatchApi.act({ ref: batchKey, action: 'pass', items, form: isWarehouse ? { config: [whForm.config ? (whForm.config as unknown[])[0] : undefined] } : { confirmed, ...(sync ? { syncToJst: true } : {}) } }), '批量通过'); }}>
            <div className="modal-head"><strong>批量通过 {items.length} 个规格</strong></div>
            <div className="modal-body">
              {isWarehouse && (<>
                <p className="muted">下面填一份发货组成，会套用到选中的全部规格（旧系统的“批量套用发货组成”）。每个规格各自仍会单独校验。</p>
                <SkuWarehouseFields specs={[{ name: `所选 ${items.length} 个规格`, main: [], gift: [] }] as never} values={whForm} onChange={(k, v) => setWhForm({ ...whForm, [k]: v })} />
              </>)}
              {isReview && (<>
                <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> 我已核对这些规格的物料、重量和将生成的组合编码</label>
                <label className="check"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 通过后加入聚水潭同步队列（需要同步维护权限；只入队，不会立刻发送）</label>
              </>)}
            </div>
            <div className="modal-foot">
              <button type="button" className="secondary-button" onClick={() => setDlg(null)}>取消</button>
              <button type="submit" className="primary-button" disabled={busy || (isReview && !confirmed)}>确认通过</button>
            </div>
          </form>
        </div>
      )}
      {openRun && <RunDetail id={openRun} onClose={() => setOpenRun(null)} onChanged={() => { load(); onChanged(); }} />}
    </div>
  );
}
