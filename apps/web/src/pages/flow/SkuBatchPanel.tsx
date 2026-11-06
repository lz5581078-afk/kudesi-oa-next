import {X} from 'lucide-react';
import { Fragment,useCallback, useEffect, useMemo,useRef, useState } from 'react';
import { FLOW_ACTION_LABEL } from '@kudesi/shared';
import {useAuth} from '../../auth/AuthContext';
import {SkuApplicationDetailView,type ApplicationItem} from './SkuApplicationDetailView';
import type {RunDetailDto,FlowConfirmation} from './flowApi';
import { ApiError } from '../../api/client';
import { ReasonDialog } from '../../resources/RecordForm';
import { RunDetail } from './RunDetail';
import {SkuCheckResults,type SkuCheckEntry} from './SkuCheckResults';
import {SkuStepEditor} from './SkuStepEditor';
import {SkuQuantitySeriesDialog,SkuBulkReuseDialog} from './SkuBatchTools';
import {SkuDraftEditor,SkuDraftSharedSettings,SkuApplicationDeleteDialog} from './SkuApplicationDraftPanels';
import { SkuPreview,skuApi,SKU_TEMPLATE,SkuWarehouseFields, skuBatchApi, type BatchBoard, type BatchOutcome,type SkuPreviewDto } from './SkuApply';
import {SkuActionDialog,type SkuSourceAction} from './SkuActionDialog';
import {flowApi,newRequestKey, fmtTime } from './flowApi';

const RUN_WORD: Record<string, string> = { draft:'待提交',running: '办理中', completed: '已完成', cancelled: '已废除', rejected: '被拒绝' };
type Dlg = null | 'return' | 'returnAll' | 'reject' | 'cancel' | 'pass';

/**
 * SKU 申请汇总：一张申请单一个入口，里面每个规格一行。
 * 办理人可以勾选规格批量通过 / 批量退回 / 整单退回 / 废除 / 拒绝；申请人在这里看到被退回的规格和原因，修改后重新提交。
 * 每个规格仍是独立的流程，所有动作都走流程引擎（办理资格、版本号、校验、审计都和单条办理一样）。
 */
type SkuBatchPanelProps={onBack?:()=>void;sourceLayout?:boolean;batchKey:string;onClose:()=>void;onChanged:()=>void};
export function SkuBatchPanel(props:SkuBatchPanelProps){const {user}=useAuth();const identity=JSON.stringify([user?.companyId,user?.id,user?.permissions?.isCompanyAdmin,[...(user?.permissions?.allow??[])].sort(),[...(user?.permissions?.deny??[])].sort()]);return <SkuBatchWorkspace key={identity} {...props}/>;}
function SkuBatchWorkspace({batchKey,onClose,onChanged,sourceLayout:preferredSource,onBack}:SkuBatchPanelProps){
  const [board, setBoard] = useState<BatchBoard | null>(null);
  const sourceLayout=preferredSource??!!(board?.applicationHeader||board?.workflowSteps?.length);
  const {can}=useAuth();const [details,setDetails]=useState<Record<number,RunDetailDto>>({}),[names,setNames]=useState<Record<number,string>>({}),[platformNames,setPlatformNames]=useState<Record<number,string>>({}),[checked,setChecked]=useState<Set<number>>(new Set());
  const [checks,setChecks]=useState<Record<number,SkuCheckEntry>>({});
  const [error, setError] = useState('');
  useEffect(()=>{if(!sourceLayout)return;let alive=true;skuApi.meta().then(meta=>{if(alive)setPlatformNames(Object.fromEntries(meta.platforms.map(row=>[row.id,row.name])));}).catch(()=>undefined);return()=>{alive=false;};},[sourceLayout]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [dlg, setDlg] = useState<Dlg>(null);
  const [sourceAction,setSourceAction]=useState<SkuSourceAction|null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; failed: BatchOutcome['results'] } | null>(null);
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [sourceStage,setSourceStage]=useState('');
  const [tool,setTool]=useState<'series'|'reuse'|null>(null),[toolDetails,setToolDetails]=useState<RunDetailDto[]>([]),[toolPreviews,setToolPreviews]=useState<Record<number,SkuPreviewDto>>({});
  const [whForm, setWhForm] = useState<Record<string, unknown>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [sync, setSync] = useState(false);
  const [editingDraft,setEditingDraft]=useState<number|null>(null),[copyingDraft,setCopyingDraft]=useState<{id:number;revision:number;name:string}|null>(null),[deletingDraft,setDeletingDraft]=useState<{id:number;revision:number;name:string}|null>(null),[deletingApplication,setDeletingApplication]=useState(false),[draftPreview,setDraftPreview]=useState<number|null>(null),[draftPreviewVersion,setDraftPreviewVersion]=useState(0),[draftBusy,setDraftBusy]=useState(false),[loading,setLoading]=useState(true);
  const draftGuard=useRef<((next:()=>void)=>void)|null>(null),requestSequence=useRef(0),submitRequest=useRef({signature:'',key:newRequestKey()}),addRequest=useRef({signature:'',key:newRequestKey()});
  const requestClose=useCallback(()=>{if(draftGuard.current)draftGuard.current(onClose);else onClose();},[onClose]);
  const requestBack=()=>{const back=onBack??onClose;if(draftGuard.current)draftGuard.current(back);else back();};
  const leaveReady=useCallback((guard:((next:()=>void)=>void)|null)=>{draftGuard.current=guard;},[]);


  const load = useCallback(() => {
    const request=++requestSequence.current;setLoading(true);setChecked(new Set());setChecks({});
    skuBatchApi.board(batchKey).then((b) => {if(request===requestSequence.current){setBoard(b);setError('');if(sourceLayout){Promise.allSettled([...new Set(b.items.map(item=>item.runId))].map(id=>flowApi.run(id))).then(async settled=>{if(request!==requestSequence.current)return;const rows=settled.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);setDetails(Object.fromEntries(rows.map(row=>[row.id,row])));const result:Record<number,string>={};for(const row of rows){const ids=[...new Set((row.payload.specs as Array<{main:Array<{baseCodeId:number}>;gift:Array<{baseCodeId:number}>}>|undefined)?.flatMap(spec=>[...spec.main,...spec.gift].map(line=>line.baseCodeId))??[])];for(let offset=0;offset<ids.length;offset+=200){const got=await skuApi.names(ids.slice(offset,offset+200),row.id);for(const item of got.items)result[item.id]=item.name||item.code;}}if(rows[0]){const meta=await skuApi.meta(rows[0].id);if(request===requestSequence.current)setPlatformNames(Object.fromEntries(meta.platforms.map(row=>[row.id,row.name])));}if(request===requestSequence.current)setNames(result);}).catch(()=>undefined);}}}).catch((e) => {if(request===requestSequence.current)setError(e instanceof ApiError ? e.message : '加载失败');}).finally(()=>{if(request===requestSequence.current)setLoading(false);});
  }, [batchKey,sourceLayout]);
  useEffect(()=>{load();return()=>{requestSequence.current++;};},[load]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !dlg && !openRun&&!copyingDraft&&!deletingDraft&&!deletingApplication) requestClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [dlg, openRun, copyingDraft,deletingDraft,deletingApplication,requestClose]);

  const hold = board?.me.holdStepKey ?? null;
  // 你名下可批量办理的规格：停在你手里的那一步；申请人则是被退回等你修改的规格
  const handleable = useMemo(() => (board?.items ?? []).filter((i) => (i.mine && i.stepKey === hold) || i.canResubmit || i.canEditDraft), [board, hold]);
  const mineIds = useMemo(() => handleable.filter((i) => i.mine && !!hold && i.stepKey === hold).map((i) => i.runId), [handleable, hold]);
  // Historical applications may have several spec rows sharing one run and one transition.
  const selected = [...new Map((board?.items ?? []).filter(item=>sel.has(item.runId)).map(item=>[item.runId,item])).values()];
  const toggle = (id: number) => setSel((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allMine = handleable.length > 0 && handleable.every((i) => sel.has(i.runId));
  const confirmationFor=(id:number)=>{const entry=checks[id];return entry?.result?.generatedDuplicates?.length&&entry.confirmation?entry.confirmation:undefined;};
  const canProceed=(item:ApplicationItem)=>{const entry=checks[item.runId];return checked.has(item.runId)&&entry?.revision===item.revision&&(!entry.result?.generatedDuplicates?.length||!!entry.confirmation?.confirmed&&!!entry.confirmation.reason.trim()&&entry.confirmation.token===entry.result.duplicateToken);};
  const items = selected.filter((i) => i.mine).map((i) => ({ runId: i.runId, revision: i.revision, stepId: i.stepId ?? undefined,...(sourceLayout&&confirmationFor(i.runId)?{confirmation:confirmationFor(i.runId)}:{}) }));

  async function run(fn: () => Promise<BatchOutcome>, word: string) {
    setBusy(true);
    setError('');
    try {
      const r = await fn();
      setOutcome({ text: `${word}：成功 ${r.ok} 个${r.failed ? `，失败 ${r.failed} 个` : ''}`, failed: r.results.filter((x) => !x.ok) });
      setSel(sourceLayout?new Set(r.results.filter(row=>!row.ok).map(row=>row.runId)):new Set());
      setDlg(null);
      setSourceAction(null);
      load();
      onChanged();
    } catch (e) { setError(e instanceof ApiError ? e.message : '操作失败'); } finally { setBusy(false); }
  }
  const nameOf = (id: number) => board?.items.find((i) => i.runId === id)?.specName ?? `#${id}`;
  const isWarehouse = hold === 'warehouse';
  const isReview = hold === 'review';

  const draftRows=board?.items.filter(item=>item.canEditDraft||(sourceLayout&&board.applicationHeader&&item.canResubmit))??[],selectedDrafts=draftRows.filter(item=>item.canEditDraft&&sel.has(item.runId)),draftIndex=draftRows.findIndex(item=>item.runId===editingDraft),header=board?.applicationHeader;
  const expected=[...new Map((board?.items??[]).map(item=>[item.runId,{id:item.runId,revision:item.revision}])).values()];
  const canEditShared=!!header?.canAdd&&(board?.items??[]).filter(item=>!['cancelled','rejected'].includes(item.runStatus)).every(item=>item.canEditDraft||item.canResubmit);
  const working=busy||draftBusy||loading;
  const legacyEditor=!header&&!!board?.items.some(item=>item.runId===openRun&&(item.canResubmit||item.mine));
  const changeDraft=(id:number|null)=>{const next=()=>setEditingDraft(id);if(draftGuard.current)draftGuard.current(next);else next();};
  async function addDraft(source?:{id:number;revision:number;name:string}){
    if(!header||working)return;const names=new Set((board?.items??[]).map(item=>item.specName.trim().toLocaleLowerCase())),base=source?`${source.name} 副本`:`规格 ${(board?.items.length??0)+1}`;let name=base,index=2;while(names.has(name.toLocaleLowerCase()))name=`${base} ${index++}`;
    const signature=JSON.stringify([header.headerVersion,source?.id,source?.revision,name]);if(signature!==addRequest.current.signature)addRequest.current={signature,key:newRequestKey()};setDraftBusy(true);setError('');
    try{const result=await flowApi.addApplicationDrafts(SKU_TEMPLATE,batchKey,{headerVersion:header.headerVersion,requestKey:addRequest.current.key,payloads:[{specs:[{name}]}],...(source?{copySource:{id:source.id,revision:source.revision}}:{})});setCopyingDraft(null);setEditingDraft(result.runs[0]?.id??null);load();onChanged();}catch(error){setError(error instanceof ApiError?error.message:'添加规格失败');}finally{setDraftBusy(false);}
  }
  async function submitDrafts(comment?:string){
    const signature=JSON.stringify(selectedDrafts.map(item=>[item.runId,item.revision]).sort(([a],[b])=>a-b));if(signature!==submitRequest.current.signature)submitRequest.current={signature,key:newRequestKey()};setDraftBusy(true);setError('');
    try{const out=await flowApi.submitApplicationDrafts(SKU_TEMPLATE,batchKey,{requestKey:submitRequest.current.key,...(comment?{comment}:{}),items:selectedDrafts.map(item=>({id:item.runId,revision:item.revision,...(sourceLayout&&confirmationFor(item.runId)?{confirmation:confirmationFor(item.runId)}:{})}))});if(sourceLayout){const returned=selected.filter(item=>item.canResubmit);if(returned.length){const extra=await skuBatchApi.act({ref:batchKey,action:'resubmit',...(comment?{comment}:{}),items:returned.map(item=>({runId:item.runId,revision:item.revision,...(sourceLayout&&confirmationFor(item.runId)?{confirmation:confirmationFor(item.runId)}:{})}))});out.results.push(...extra.results);out.ok+=extra.ok;out.failed+=extra.failed;}}setOutcome({text:`提交：成功 ${out.ok} 个${out.failed?`，失败 ${out.failed} 个`:''}`,failed:out.results.filter(item=>!item.ok)});setSel(new Set(out.results.filter(item=>!item.ok).map(item=>item.runId)));setEditingDraft(null);setSourceAction(null);load();onChanged();}catch(error){setError(error instanceof ApiError?error.message:'提交申请失败');}finally{setDraftBusy(false);}
  }
  async function checkRows(rows:Array<{runId:number;revision:number}>){setDraftBusy(true);setError('');const done=new Set<number>(),entries:Record<number,SkuCheckEntry>={};const failures:BatchOutcome['results']=[];for(const item of rows){try{const result=await skuApi.preview(item.runId,item.revision);entries[item.runId]={revision:item.revision,result,...(result.planError?{error:result.planError}:{})};if(result.planError)failures.push({runId:item.runId,ok:false,message:result.planError});else done.add(item.runId);}catch(error){const message=error instanceof ApiError?error.message:'校验失败';entries[item.runId]={revision:item.revision,result:null,error:message};failures.push({runId:item.runId,ok:false,message});}}setChecked(done);setChecks(entries);setOutcome({text:`查重与校验：成功 ${done.size} 个${failures.length?`，失败 ${failures.length} 个`:''}`,failed:failures});setDraftPreview(rows[0]?.runId??null);setDraftPreviewVersion(value=>value+1);setDraftBusy(false);}
  const checkSelected=()=>checkRows(selected);
  async function checkSaved(id:number){try{const detail=await flowApi.run(id);await checkRows([{runId:id,revision:detail.revision}]);}catch(error){setError(error instanceof ApiError?error.message:'校验读取失败');}}
  const inlineEditor=(item:ApplicationItem)=>editingDraft===item.runId?<SkuDraftEditor sourceLayout={sourceLayout} position={draftIndex} total={draftRows.length} key={item.runId} id={item.runId} onLeaveReady={leaveReady} onClose={()=>setEditingDraft(null)} onSaved={check=>{setEditingDraft(null);setChecked(new Set());setSel(new Set([item.runId]));if(check)void checkSaved(item.runId);load();onChanged();}} onPrevious={draftIndex>0?()=>setEditingDraft(draftRows[draftIndex-1].runId):undefined} onNext={draftIndex>=0&&draftIndex<draftRows.length-1?()=>setEditingDraft(draftRows[draftIndex+1].runId):undefined}/>:null;
  const workflow=header?.steps??board?.workflowSteps??[],sourceCurrent=selected[0]?.stepKey??sourceStage,currentStep=workflow.find(step=>step.key===sourceCurrent);
  const sourceType=selected[0]?.stepType??currentStep?.type,sourceSales=sourceType==='submit',sourceWarehouse=sourceCurrent==='warehouse'||sourceType==='execute',sourceReview=sourceCurrent==='review'||sourceType==='finance';
  const sameStage=selected.length>0&&selected.every(item=>item.stepKey===selected[0].stepKey&&(item.mine||item.canEditDraft||item.canResubmit));
  async function openTool(kind:'series'|'reuse'){setDraftBusy(true);setError('');try{const loaded=await Promise.all(selected.map(item=>flowApi.run(item.runId)));if(loaded.some(detail=>detail.revision!==selected.find(item=>item.runId===detail.id)?.revision))throw new ApiError(409,'规格已变化，请刷新后重试');setToolDetails(loaded);if(kind==='reuse'){const previews=await Promise.all(loaded.map(async detail=>[detail.id,await skuApi.preview(detail.id)] as const));setToolPreviews(Object.fromEntries(previews));}setTool(kind);}catch(error){setError(error instanceof ApiError?error.message:'规格读取失败');}finally{setDraftBusy(false);}}
  function finishTool(results:BatchOutcome['results']){setTool(null);setChecked(new Set());setOutcome({text:`处理完成：成功 ${results.filter(row=>row.ok).length} 个，失败 ${results.filter(row=>!row.ok).length} 个`,failed:results.filter(row=>!row.ok)});setSel(new Set(results.filter(row=>!row.ok).map(row=>row.runId)));load();onChanged();}
  const sourceActions=<>{sourceSales&&<button type="button" className="primary-button" disabled={working||!sameStage||selected.some(item=>!canProceed(item))} onClick={()=>setSourceAction('submit')}>通过 · 提交{workflow.find(step=>step.type==='execute')?.name||'下一节点'}</button>}{(sourceWarehouse||sourceReview)&&<button type="button" className="primary-button" disabled={working||!sameStage||!selected.length||selected.some(item=>!canProceed(item))} onClick={()=>setSourceAction(sourceReview?'approve':'submit')}>{sourceReview?'通过 · 审核':`通过 · 提交${workflow.find(step=>step.type==='finance')?.name||'下一节点'}`}</button>}{(sourceSales||sourceWarehouse||sourceReview)&&<><button type="button" disabled={working||!sameStage||!selected.length} onClick={()=>setSourceAction('cancel')}>废除</button><button type="button" disabled={working||!sameStage||!selected.length||sourceSales} onClick={()=>setSourceAction('return')}>退回上一步</button><button type="button" disabled={working||!sameStage||!selected.length} onClick={()=>setSourceAction('reject')}>拒绝</button></>}{sourceSales&&header?.canAdd&&<button type="button" disabled={working||selected.length!==1} onClick={()=>void openTool('series')}>批量生成规格</button>}{board?.me.canReturnAll&&<button type="button" disabled={working} onClick={()=>setDlg('returnAll')}>整单退回（全部 {board.me.holdCount} 个）</button>}{sourceWarehouse&&<button type="button" disabled={working||!sameStage||items.length<2} onClick={()=>void openTool('reuse')}>批量套用发货组成</button>}{selected.length>0&&<span>{!sameStage?'请选择同一节点的规格':selected.every(canProceed)?'校验通过，可提交':`待校验 ${selected.length} 项`}</span>}</>;

  return (
    <div className={`modal-backdrop${sourceLayout?' sku-application-backdrop':''}`} role="presentation">
      <div className={`modal card sku-batch-panel${sourceLayout?' sku-reference-detail':''}`} role="dialog" aria-label={header?`SKU申请 · ${header.title}`:'申请汇总'} style={sourceLayout?undefined:{ width: 'min(960px, 100%)' }}>
        <div className="modal-head between">
          {sourceLayout?<h2>SKU申请 · {board?.batchName||'正在读取…'}</h2>:<div>
            <strong>{board?.batchName || '申请汇总'}</strong>
            {board && <div className="muted">发起人 {board.requesterName} · 共 {board.total} 个规格 · 办理中 {board.counts.running} · 已完成 {board.counts.completed} · 已结束 {board.counts.ended}{board.counts.returned > 0 && <> · <span className="late-text">被退回 {board.counts.returned}</span></>}</div>}
          </div>}
          <div className="row-actions">
            {!sourceLayout&&<button type="button" className="secondary-button small" onClick={load}>刷新</button>}
            <button type="button" className="icon-button" aria-label="关闭" onClick={requestClose}><X size={19}/></button>
          </div>
        </div>
        <div className="modal-body">
          {error&&!sourceAction && <div role="alert" className="notice error">{error}</div>}
          {outcome && !sourceLayout && (
            <div role="status" className={`notice ${outcome.failed.length ? 'error' : 'ok-notice'} toast-line`}>
              <span>{outcome.text}{outcome.failed.map((f) => <span key={f.runId} className="sub-line">· {nameOf(f.runId)}：{f.message}</span>)}</span>
              <button type="button" aria-label="关闭提示" onClick={() => setOutcome(null)}>✕</button>
            </div>
          )}
          {!board && !error && <p className="muted">加载中…</p>}
          {sourceLayout&&board?<SkuApplicationDetailView onStageChange={setSourceStage} board={board} details={details} names={names} platformNames={platformNames} canCost={can('product.cost.view')} selected={sel} working={working} onBack={requestBack} onRefresh={load} onDeleteApplication={()=>{if(draftGuard.current)draftGuard.current(()=>setDeletingApplication(true));else setDeletingApplication(true);}} onAdd={()=>{if(draftGuard.current)draftGuard.current(()=>void addDraft());else void addDraft();}} onToggle={toggle} onToggleAll={rows=>setSel(rows.every(item=>sel.has(item.runId))?new Set():new Set(rows.map(item=>item.runId)))} onClearSelection={()=>{setSel(new Set());setChecked(new Set());}} onCheck={()=>void checkSelected()} onEdit={item=>item.canEditDraft||header&&item.canResubmit?changeDraft(item.runId):setOpenRun(item.runId)} onCopy={item=>setCopyingDraft({id:item.runId,revision:item.revision,name:item.specName})} onDelete={item=>setDeletingDraft({id:item.runId,revision:item.revision,name:item.specName})} common={header&&<SkuDraftSharedSettings sourceLayout runId={board.items.find(item=>item.mine)?.runId??board.items[0]?.runId} key={header.batchKey} header={header} expected={expected} editable={canEditShared} onSaved={()=>{setChecked(new Set());load();onChanged();}}/>} actions={sourceActions} editor={inlineEditor} results={<><SkuCheckResults entries={checks} names={Object.fromEntries(board.items.map(item=>[item.runId,item.specName]))} busy={working} onConfirmation={(id,confirmation)=>setChecks(current=>({...current,[id]:{...current[id],confirmation}}))}/>{!Object.keys(checks).length&&outcome&&<section className="sku-reference-check-results" role="status"><h3>{outcome.text}</h3>{outcome.failed.map(row=><p key={row.runId}>{nameOf(row.runId)}：{row.message}</p>)}</section>}</>}/>:<>
          {header&&<>
            <div className="sku-application-detail-toolbar"><button type="button" className="secondary-button" disabled={working} onClick={requestClose}>返回申请列表</button><span>{board?.total??0} 个规格 · {board?.counts.completed??0} 已验证</span>{header.canAdd&&<button type="button" disabled={working} onClick={()=>{if(draftGuard.current)draftGuard.current(()=>void addDraft());else void addDraft();}}>添加规格</button>}{(header.canDelete===true||(header.canDelete===undefined&&header.canAdd&&(board?.items??[]).every(item=>item.canEditDraft)))&&<button type="button" disabled={working} onClick={()=>setDeletingApplication(true)}>删除申请</button>}</div>
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
                      <td className="row-actions">{i.canEditDraft?<><button type="button" className="secondary-button small" disabled={working} onClick={()=>changeDraft(editingDraft===i.runId?null:i.runId)}>运营配置</button><button type="button" className="secondary-button small" disabled={working} onClick={()=>setCopyingDraft({id:i.runId,revision:i.revision,name:i.specName})}>复制当前未完成规格</button><button type="button" className="secondary-button small" disabled={working} onClick={()=>setDeletingDraft({id:i.runId,revision:i.revision,name:i.specName})}>删除未提交规格</button></>:<button type="button" className="secondary-button small" onClick={() => setOpenRun(i.runId)}>{i.canResubmit ? '修改并重新提交' : '查看'}</button>}{!i.canEditDraft&&i.canResubmit&&header?.canAdd&&<button type="button" className="secondary-button small" disabled={working} onClick={()=>setCopyingDraft({id:i.runId,revision:i.revision,name:i.specName})}>复制当前未完成规格</button>}</td>
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
          </>}
        </div>
        {!sourceLayout&&<div className="modal-foot"><button type="button" className="secondary-button" onClick={requestClose}>关闭</button></div>}
      </div>

      {sourceLayout&&sourceAction&&<SkuActionDialog error={error} action={sourceAction} count={selected.length} busy={working} onClose={()=>setSourceAction(null)} onConfirm={async(comment)=>{
        if(sourceAction==='submit'&&sourceSales){if(selectedDrafts.length){await submitDrafts(comment);return;}await run(()=>skuBatchApi.act({ref:batchKey,action:'resubmit',items:selected.map(item=>({runId:item.runId,revision:item.revision,...(confirmationFor(item.runId)?{confirmation:confirmationFor(item.runId)}:{})})),comment}),'提交');}
        else{const action=sourceAction==='submit'||sourceAction==='approve'?'pass':sourceAction;await run(()=>skuBatchApi.act({ref:batchKey,action,items:selected.map(item=>({runId:item.runId,revision:item.revision,stepId:item.stepId??undefined,...(confirmationFor(item.runId)?{confirmation:confirmationFor(item.runId)}:{})})),comment,...(action==='pass'?(sourceWarehouse?{forms:Object.fromEntries(selected.map(item=>[String(item.runId),(Object.keys(details[item.runId]?.stepDraft?.form??{}).length?details[item.runId]?.stepDraft?.form:details[item.runId]?.initialForm??details[item.runId]?.steps.filter(step=>step.key===sourceCurrent&&step.form).at(-1)?.form)??{}]))}:{form:{confirmed:true}}):{})}),sourceAction==='approve'?'审核并更新成本表':sourceAction==='submit'?'提交':sourceAction==='cancel'?'废除':sourceAction==='reject'?'拒绝':'退回');}
      }}/>}
      {copyingDraft&&<div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="复制未完成规格" className="modal card small"><header className="modal-head"><h2>复制未完成规格</h2></header><div className="modal-body"><p>将「{copyingDraft.name}」复制为新草稿，用于申请另一种规格。新草稿需要重新核对后提交。</p>{error&&<p role="alert">{error}</p>}</div><footer className="modal-foot"><button type="button" disabled={draftBusy} onClick={()=>setCopyingDraft(null)}>取消</button><button type="button" className="primary-button" disabled={working} onClick={()=>{const source=copyingDraft;if(draftGuard.current)draftGuard.current(()=>void addDraft(source));else void addDraft(source);}}>确认复制</button></footer></section></div>}
      {deletingDraft&&<ReasonDialog title="删除未提交规格" hint={`仅删除「${deletingDraft.name}」，不会影响本申请已验证的规格。`} confirmLabel="确认删除" danger onClose={()=>setDeletingDraft(null)} onConfirm={async reason=>{await flowApi.removeApplicationDraft(deletingDraft.id,deletingDraft.revision,reason);if(editingDraft===deletingDraft.id)setEditingDraft(null);setSel(current=>new Set([...current].filter(id=>id!==deletingDraft.id)));setDeletingDraft(null);load();onChanged();}}/>}
      {deletingApplication&&header&&<SkuApplicationDeleteDialog batchKey={batchKey} title={header.title} onClose={()=>setDeletingApplication(false)} onDeleted={()=>{onChanged();(onBack??onClose)();}}/>}
      {dlg === 'return' && <ReasonDialog title={`批量退回 ${items.length} 个规格`} hint="退回原因必填，申请人会收到一条汇总通知。" confirmLabel="退回" suggestions={['资料有误', '数量不对', '请补充说明']} onClose={() => setDlg(null)} onConfirm={(reason) => run(() => skuBatchApi.act({ ref: batchKey, action: 'return', items, comment: reason }), '批量退回')} />}
      {dlg === 'reject' && <ReasonDialog title={`拒绝 ${items.length} 个规格`} hint="拒绝后这些规格的流程结束。" confirmLabel="拒绝" danger suggestions={['不符合要求', '重复申请']} onClose={() => setDlg(null)} onConfirm={(reason) => run(() => skuBatchApi.act({ ref: batchKey, action: 'reject', items, comment: reason }), '批量拒绝')} />}
      {dlg === 'cancel' && <ReasonDialog title={`废除 ${items.length} 个规格`} hint="废除后这些规格的流程结束。" confirmLabel="废除" danger suggestions={['不再需要', '重复申请']} onClose={() => setDlg(null)} onConfirm={(reason) => run(() => skuBatchApi.act({ ref: batchKey, action: 'cancel', items, comment: reason }), '批量废除')} />}
      {dlg === 'returnAll' && board && <ReasonDialog title={`整单退回（${board.me.holdCount} 个规格）`} hint="这一步申请单里的全部规格一起退回，要么全退要么都不退；退回原因必填。" confirmLabel="整单退回" suggestions={['资料有误', '请补充说明']} onClose={() => setDlg(null)}
        onConfirm={async (reason) => { setBusy(true); try { const r = await skuBatchApi.returnAll({ ref: batchKey, items: [...new Map(board.items.filter(i=>i.mine&&i.stepKey===hold).map(i=>[i.runId,{runId:i.runId,revision:i.revision,stepId:i.stepId??undefined}])).values()], reason }); setOutcome({ text: `整单退回：${r.count} 个规格已退回`, failed: [] }); setSel(new Set()); setDlg(null); load(); onChanged(); } finally { setBusy(false); } }} />}
      {dlg === 'pass' && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal card" role="dialog" aria-label="批量通过" style={{ width: 'min(900px, 100%)' }} onSubmit={(e) => { e.preventDefault(); void run(() => skuBatchApi.act({ ref: batchKey, action: 'pass', items, ...(sourceLayout&&isWarehouse?{forms:Object.fromEntries(items.map(item=>[String(item.runId),(Object.keys(details[item.runId]?.stepDraft?.form??{}).length?details[item.runId]?.stepDraft?.form:details[item.runId]?.initialForm??details[item.runId]?.steps.filter(step=>step.key===sourceCurrent&&step.form).at(-1)?.form)??{}]))}:{form: isWarehouse ? { config: [whForm.config ? (whForm.config as unknown[])[0] : undefined] } : { confirmed, ...(sync ? { syncToJst: true } : {}) } }) }), '批量通过'); }}>
            <div className="modal-head"><strong>批量通过 {items.length} 个规格</strong></div>
            <div className="modal-body">
              {isWarehouse && !sourceLayout && (<>
                <p className="muted">下面填一份发货组成，会套用到选中的全部规格（旧系统的“批量套用发货组成”）。每个规格各自仍会单独校验。</p>
                <SkuWarehouseFields sourceQuantity={sourceLayout} specs={[{ name: `所选 ${items.length} 个规格`, main: [], gift: [] }] as never} values={whForm} onChange={(k, v) => setWhForm({ ...whForm, [k]: v })} />
              </>)}
              {isWarehouse&&sourceLayout&&<p>将提交所选规格已保存的发货组成。每个规格仍按当前资料逐项校验。</p>}
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
      {tool==='series'&&header&&toolDetails[0]&&<SkuQuantitySeriesDialog header={header} detail={toolDetails[0]} onClose={()=>setTool(null)} onDone={finishTool}/>}
      {tool==='reuse'&&toolDetails.length>1&&<SkuBulkReuseDialog items={toolDetails} previews={toolPreviews} onClose={()=>setTool(null)} onDone={finishTool}/>}
      {openRun&&sourceLayout&&!legacyEditor&&<SkuStepEditor key={openRun} id={openRun} onLeaveReady={leaveReady} onClose={()=>setOpenRun(null)} onSaved={check=>{const id=openRun;setOpenRun(null);setChecked(new Set());setSel(new Set([id]));load();onChanged();if(check)void checkSaved(id);}}/>}
      {openRun && (!sourceLayout||legacyEditor) && <RunDetail id={openRun} onClose={() => setOpenRun(null)} onChanged={() => { load(); onChanged(); }} />}
    </div>
  );
}
