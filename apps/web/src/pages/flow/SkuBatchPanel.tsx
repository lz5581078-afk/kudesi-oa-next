import { Fragment,useCallback, useEffect, useMemo,useRef, useState } from 'react';
import { FLOW_ACTION_LABEL } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { ReasonDialog } from '../../resources/RecordForm';
import { RunDetail } from './RunDetail';
import {SkuDraftAddDialog,SkuDraftEditor,SkuDraftSharedSettings} from './SkuApplicationDraftPanels';
import { SkuPreview,SKU_TEMPLATE,SkuWarehouseFields, skuBatchApi, type BatchBoard, type BatchOutcome } from './SkuApply';
import {flowApi,newRequestKey, fmtTime } from './flowApi';

const RUN_WORD: Record<string, string> = { draft:'待提交',running: '办理中', completed: '已完成', cancelled: '已废除', rejected: '被拒绝' };
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
  const [editingDraft,setEditingDraft]=useState<number|null>(null),[addingDraft,setAddingDraft]=useState(false),[deletingDraft,setDeletingDraft]=useState<{id:number;revision:number;name:string}|null>(null),[deletingApplication,setDeletingApplication]=useState(false),[draftPreview,setDraftPreview]=useState<number|null>(null),[draftPreviewVersion,setDraftPreviewVersion]=useState(0),[draftBusy,setDraftBusy]=useState(false),[loading,setLoading]=useState(true);
  const draftGuard=useRef<((next:()=>void)=>void)|null>(null),requestSequence=useRef(0),submitRequest=useRef({signature:'',key:newRequestKey()});
  const requestClose=useCallback(()=>{if(draftGuard.current)draftGuard.current(onClose);else onClose();},[onClose]);
  const leaveReady=useCallback((guard:((next:()=>void)=>void)|null)=>{draftGuard.current=guard;},[]);


  const load = useCallback(() => {
    const request=++requestSequence.current;setLoading(true);
    skuBatchApi.board(batchKey).then((b) => {if(request===requestSequence.current){setBoard(b);setError('');}}).catch((e) => {if(request===requestSequence.current)setError(e instanceof ApiError ? e.message : '加载失败');}).finally(()=>{if(request===requestSequence.current)setLoading(false);});
  }, [batchKey]);
  useEffect(()=>{load();return()=>{requestSequence.current++;};},[load]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !dlg && !openRun&&!addingDraft&&!deletingDraft&&!deletingApplication) requestClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [dlg, openRun, addingDraft,deletingDraft,deletingApplication,requestClose]);

  const hold = board?.me.holdStepKey ?? null;
  // 你名下可批量办理的规格：停在你手里的那一步；申请人则是被退回等你修改的规格
  const handleable = useMemo(() => (board?.items ?? []).filter((i) => (i.mine && i.stepKey === hold) || i.canResubmit || i.canEditDraft), [board, hold]);
  const mineIds = useMemo(() => handleable.filter((i) => i.mine && !!hold && i.stepKey === hold).map((i) => i.runId), [handleable, hold]);
  const selected = (board?.items ?? []).filter((i) => sel.has(i.runId));
  const toggle = (id: number) => setSel((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allMine = handleable.length > 0 && handleable.every((i) => sel.has(i.runId));
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

  const draftRows=board?.items.filter(item=>item.canEditDraft)??[],selectedDrafts=draftRows.filter(item=>sel.has(item.runId)),draftIndex=draftRows.findIndex(item=>item.runId===editingDraft),header=board?.applicationHeader;
  const expected=[...new Map((board?.items??[]).map(item=>[item.runId,{id:item.runId,revision:item.revision}])).values()];
  const canEditShared=!!header?.canAdd&&(board?.items??[]).filter(item=>!['cancelled','rejected'].includes(item.runStatus)).every(item=>item.canEditDraft||item.canResubmit);
  const working=busy||draftBusy||loading;
  const changeDraft=(id:number|null)=>{const next=()=>setEditingDraft(id);if(draftGuard.current)draftGuard.current(next);else next();};
  async function submitDrafts(){
    const signature=JSON.stringify(selectedDrafts.map(item=>[item.runId,item.revision]).sort(([a],[b])=>a-b));if(signature!==submitRequest.current.signature)submitRequest.current={signature,key:newRequestKey()};setDraftBusy(true);setError('');
    try{const out=await flowApi.submitApplicationDrafts(SKU_TEMPLATE,batchKey,{requestKey:submitRequest.current.key,items:selectedDrafts.map(item=>({id:item.runId,revision:item.revision}))});setOutcome({text:`提交：成功 ${out.ok} 个${out.failed?`，失败 ${out.failed} 个`:''}`,failed:out.results.filter(item=>!item.ok)});setSel(new Set(out.results.filter(item=>!item.ok).map(item=>item.runId)));setEditingDraft(null);load();onChanged();}catch(error){setError(error instanceof ApiError?error.message:'提交申请失败');}finally{setDraftBusy(false);}
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card sku-batch-panel" role="dialog" aria-label={header?`SKU申请 · ${header.title}`:'申请汇总'} style={{ width: 'min(960px, 100%)' }}>
        <div className="modal-head between">
          <div>
            <strong>{board?.batchName || '申请汇总'}</strong>
            {board && <div className="muted">发起人 {board.requesterName} · 共 {board.total} 个规格 · 办理中 {board.counts.running} · 已完成 {board.counts.completed} · 已结束 {board.counts.ended}{board.counts.returned > 0 && <> · <span className="late-text">被退回 {board.counts.returned}</span></>}</div>}
          </div>
          <div className="row-actions">
            <button type="button" className="secondary-button small" onClick={load}>刷新</button>
            <button type="button" className="icon-button" aria-label="关闭" onClick={requestClose}>✕</button>
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
          {header&&<>
            <div className="sku-application-detail-toolbar"><button type="button" className="secondary-button" disabled={working} onClick={requestClose}>返回申请列表</button><span>{board?.total??0} 个规格 · {board?.counts.completed??0} 已验证</span>{header.canAdd&&<button type="button" disabled={working} onClick={()=>setAddingDraft(true)}>添加规格</button>}{header.canAdd&&(board?.items??[]).every(item=>item.canEditDraft)&&<button type="button" disabled={working} onClick={()=>setDeletingApplication(true)}>删除申请</button>}</div>
            <SkuDraftSharedSettings key={header.batchKey} header={header} expected={expected} editable={canEditShared} onSaved={()=>{load();onChanged();}}/>
          </>}
          {board && handleable.length > 0 && (
            <div className="batch-bar" role="toolbar" aria-label="批量办理">
              <label className="check"><input type="checkbox" checked={allMine} onChange={() => setSel(allMine ? new Set() : new Set(handleable.map((i) => i.runId)))} /> 全选我名下的（{handleable.length}）</label>
              <span className="muted">已选 {sel.size} 个</span>
              {selectedDrafts.length>0&&<button type="button" className="primary-button" disabled={working} onClick={()=>{if(draftGuard.current)draftGuard.current(()=>void submitDrafts());else void submitDrafts();}}>提交所选（{selectedDrafts.length}）</button>}
              {mineIds.length > 0 && <>
                <button type="button" className="primary-button" disabled={working || !items.length} onClick={() => (isWarehouse || isReview ? setDlg('pass') : void run(() => skuBatchApi.act({ ref: batchKey, action: 'pass', items }), '批量通过'))}>批量通过</button>
                <button type="button" className="secondary-button" disabled={working || !items.length} onClick={() => setDlg('return')}>批量退回</button>
                {board.me.canReturnAll && <button type="button" className="secondary-button" disabled={working} onClick={() => setDlg('returnAll')}>整单退回（全部 {board.me.holdCount} 个）</button>}
                <button type="button" className="secondary-button" disabled={working || !items.length} onClick={() => setDlg('reject')}>拒绝</button>
                <button type="button" className="secondary-button" disabled={working || !items.length} onClick={() => setDlg('cancel')}>废除</button>
              </>}
              {board.items.some((i) => i.canResubmit && sel.has(i.runId)) && (
                <button type="button" className="primary-button" disabled={working} onClick={() => void run(() => skuBatchApi.act({ ref: batchKey, action: 'resubmit', items: selected.filter((i) => i.canResubmit).map((i) => ({ runId: i.runId, revision: i.revision })) }), '原样重新提交')}>原样重新提交</button>
              )}
            </div>
          )}
          {board && (
            <div className="table-scroll"><table className="data-table stack-mobile">
              <thead><tr><th /><th>规格</th><th>当前</th><th>办理人</th><th>截止</th><th /></tr></thead>
              <tbody>
                {board.items.length===0&&<tr><td colSpan={6} className="muted">尚无规格</td></tr>}
                {board.items.map((i) => {
                  const can = handleable.some((h) => h.runId === i.runId);
                  return (
                    <Fragment key={`${i.runId}-${i.specIndex}`}><tr className={i.overdue ? 'late' : undefined}>
                      <td>{can && i.specIndex === 0 && <input type="checkbox" aria-label={`选择 ${i.specName}`} checked={sel.has(i.runId)} onChange={() => toggle(i.runId)} />}</td>
                      <td className="cell-title"><strong>{i.specName}</strong>{i.specCount > 1 && <span className="sub-line">同一条流程含 {i.specCount} 个规格，一起办理</span>}
                        {i.enteredVia === 'return' && i.runStatus === 'running' && <span className="sub-line late-text"><span className="pill warn">被退回</span> {i.returnedBy ? `${i.returnedBy}：` : ''}{i.returnReason}</span>}</td>
                      <td data-label="当前">{i.runStatus === 'running' ? i.stepName : RUN_WORD[i.runStatus] ?? i.runStatus}</td>
                      <td data-label="办理人">{i.runStatus === 'running' ? i.recipients.join('、') : ''}{i.mine && <span className="pill">我</span>}</td>
                      <td data-label="截止">{i.dueAt && i.runStatus === 'running' ? fmtTime(i.dueAt) : '—'}</td>
                      <td className="row-actions">{i.canEditDraft?<><button type="button" className="secondary-button small" disabled={working} onClick={()=>changeDraft(editingDraft===i.runId?null:i.runId)}>运营配置</button><button type="button" className="secondary-button small" disabled={working} onClick={()=>setDeletingDraft({id:i.runId,revision:i.revision,name:i.specName})}>删除未提交规格</button></>:<button type="button" className="secondary-button small" onClick={() => setOpenRun(i.runId)}>{i.canResubmit ? '修改并重新提交' : '查看'}</button>}</td>
                    </tr>{editingDraft===i.runId&&<tr className="sku-draft-inline-row"><td colSpan={6}><SkuDraftEditor key={i.runId} id={i.runId} onLeaveReady={leaveReady} onClose={()=>setEditingDraft(null)} onSaved={check=>{setEditingDraft(null);setSel(new Set([i.runId]));if(check){setDraftPreview(i.runId);setDraftPreviewVersion(version=>version+1);}load();onChanged();}} onPrevious={draftIndex>0?()=>setEditingDraft(draftRows[draftIndex-1].runId):undefined} onNext={draftIndex>=0&&draftIndex<draftRows.length-1?()=>setEditingDraft(draftRows[draftIndex+1].runId):undefined}/></td></tr>}</Fragment>
                  );
                })}
              </tbody>
            </table></div>
          )}
          {draftPreview&&<section className="sku-draft-validation"><h3>本次处理结果</h3><SkuPreview runId={draftPreview} refreshKey={draftPreviewVersion}/></section>}
          {board && board.history.length > 0 && (
            <details>
              <summary>办理历史（{board.history.length}）</summary>
              <ul className="event-list">
                {board.history.map((h) => <li key={h.id} className="log-item"><strong>{FLOW_ACTION_LABEL[h.action as keyof typeof FLOW_ACTION_LABEL] ?? h.action}</strong> · {h.actorName} · {h.specNames.join('、')} · <span className="muted">{fmtTime(h.createdAt)}</span>{h.note && <div>“{h.note}”</div>}</li>)}
              </ul>
            </details>
          )}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={requestClose}>关闭</button></div>
      </div>

      {addingDraft&&header&&<SkuDraftAddDialog header={header} onClose={()=>setAddingDraft(false)} onAdded={()=>{setAddingDraft(false);load();onChanged();}}/>}
      {deletingDraft&&<ReasonDialog title="删除未提交规格" hint={`仅删除「${deletingDraft.name}」，不会影响本申请已验证的规格。`} confirmLabel="确认删除" danger onClose={()=>setDeletingDraft(null)} onConfirm={async reason=>{await flowApi.removeApplicationDraft(deletingDraft.id,deletingDraft.revision,reason);if(editingDraft===deletingDraft.id)setEditingDraft(null);setSel(current=>new Set([...current].filter(id=>id!==deletingDraft.id)));setDeletingDraft(null);load();onChanged();}}/>}
      {deletingApplication&&header&&<ReasonDialog title="删除SKU申请" hint={`确定删除申请「${header.title}」及其 ${board?.total??0} 个未提交规格？删除后无法恢复。`} confirmLabel="确认删除" danger onClose={()=>setDeletingApplication(false)} onConfirm={async reason=>{await flowApi.removeApplicationDraftBatch(SKU_TEMPLATE,batchKey,{headerVersion:header.headerVersion,expected,reason});onChanged();onClose();}}/>}
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
              <button type="submit" className="primary-button" disabled={working || (isReview && !confirmed)}>确认通过</button>
            </div>
          </form>
        </div>
      )}
      {openRun && <RunDetail id={openRun} onClose={() => setOpenRun(null)} onChanged={() => { load(); onChanged(); }} />}
    </div>
  );
}
