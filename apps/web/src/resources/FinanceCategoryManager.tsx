import { bundleCategoryDisplayName } from './productCategoryFamily';
import {applyExpenseSortOrder} from '@kudesi/shared';
import {useExpenseSortPreference} from './ExpenseSortPreference';
import {FeeCategoryEditor} from './FeeCategoryEditor';
import {FeeCategoryManagerView} from './FeeCategoryManagerView';
import { Check, ChevronRight, FolderTree, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ARCHIVE_TYPE_CODE, getResourceDef, resourcePermission, permissionOwner, createChecker } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { ReasonDialog } from './TreeManage';
import { ReasonDialog as MessageConfirm } from './ResourceConfirmDialog';
import './financeCategoryManager.css';
import {financeDictionaryApi,type DictionaryPreview,type DictionaryUsage} from './financeDictionaryApi';
import {CodeCategorySync} from './CodeCategorySync';
import { matchesProductCategoryFamily } from './productCategoryFamily';
import {loadResourceDirectory} from './resourceDirectory';

/** 分类窗口须脱离目录的滚动和层叠范围，也可能从另一张表单内打开。 */
export function FinanceCategoryManager(props: Parameters<typeof FinanceCategoryManagerContent>[0]) {
  return createPortal(
    <div className="fcm-portal" onSubmit={event => event.stopPropagation()}>
      <FinanceCategoryManagerContent {...props} />
    </div>,
    document.body,
  );
}

/** 财务档案的分类设置：逐级选中、独立编辑层、同级排序。所有写入仍走资料权限和校验。 */
function FinanceCategoryManagerContent({ target, archiveType, rootId, selectedId, editorOnlyParentId, maxDepth = 3, counts = {}, directCounts = {}, context, presentation, locked = false, allowDelete = true, guardDeleteReferences = true, confirmation = 'reason', onPick, onChanged, onClose }: {
  directCounts?:Record<number,number>;
  editorOnlyParentId?:number;
  target: string; archiveType?: string; rootId?: number; selectedId?: number; maxDepth?: number;
  counts?: Record<number, number>; onPick?: (id: number) => void; onChanged: () => void; onClose: () => void;
  context?: { field: string; value: number | string; label: string; text: string };
  presentation?: { kicker: string; description: string; unit: string; footer: string };
  locked?: boolean; allowDelete?: boolean; guardDeleteReferences?: boolean; confirmation?: 'reason' | 'message';
}) {
  const { user } = useAuth();
  const expenseSort=useExpenseSortPreference();
  const can = (action: Parameters<typeof resourcePermission>[1]) => !!user && createChecker(user.permissions)(resourcePermission(permissionOwner(target), action));
  const def = getResourceDef(target)!;
  const codeMode=target==='finance-code-dictionaries'&&context?.field==='kind'&&context.value==='product_category'||target==='finance-categories'&&archiveType==='bundle';
  const codeLabel=archiveType==='bundle'?'商品组合编码':'商品编码';
  const sortField = def.categoryOrder?.sortField ?? 'sort';
  const scope = JSON.stringify([user?.companyId, user?.id, user?.permissions, target, archiveType, rootId, context?.field, context?.value,editorOnlyParentId]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const mounted = useRef(false), request = useRef(0), working = useRef(false);
  const sameScope = () => mounted.current && scopeRef.current === scope;
  const codeKey = def.fields.some(f => f.key === 'code') ? 'code' : def.fields.some(f => f.key === 'categoryCode') ? 'categoryCode' : '';
  const [family, setFamily] = useState(archiveType ?? '');
  const prefixFamily = ['original_purchase','supplier_oem'].includes(family) ? 'purchased' : family;
  const [prefix, setPrefix] = useState(''), [prefixEdit, setPrefixEdit] = useState(false), [prefixReady,setPrefixReady] = useState(false), [savedPrefix,setSavedPrefix]=useState('');
  const [rowState, setRowState] = useState<{ scope: string; rows: ResourceDto[] }>({ scope, rows: [] });
  const allRows = rowState.scope === scope ? rowState.rows : [];
  const [selected, setSelected] = useState(selectedId ?? rootId ?? 0);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ id?: number; parentId: number; name: string; code: string } | null>(null);
  const dictionaryMode=target==='finance-code-dictionaries'&&context?.value==='product_category';
  const [dictionaryUsage,setDictionaryUsage]=useState<Record<number,DictionaryUsage>>({}),[dictionaryPreview,setDictionaryPreview]=useState<DictionaryPreview|null>(null),[suggesting,setSuggesting]=useState(false);
  const codeGeneration=useRef(0);
  const dictionaryLocked=dictionaryMode&&!!draft?.id&&(!dictionaryUsage[draft.id]||dictionaryUsage[draft.id].codeLocked);
  useEffect(()=>{let live=true;setDictionaryUsage({});if(dictionaryMode)void financeDictionaryApi.context('product_category').then(value=>{if(live)setDictionaryUsage(Object.fromEntries(value.rows.map(row=>[row.id,row.usage])));}).catch(error=>{if(live)setError(error instanceof Error?error.message:'引用资料读取失败');});return()=>{live=false;};},[dictionaryMode,scope,rowState]);
  useEffect(()=>{let live=true;const generation=codeGeneration.current;setDictionaryPreview(null);setSuggesting(false);if(!dictionaryMode||!draft?.name.trim())return;setSuggesting(true);const timer=setTimeout(()=>{void financeDictionaryApi.preview('product_category',draft.name,draft.id,draft.parentId||undefined).then(value=>{if(!live||!sameScope())return;setDictionaryPreview(value);if(!dictionaryLocked&&generation===codeGeneration.current&&(!draft.id||draft.name!==String(allRows.find(row=>row.id===draft.id)?.data.name||allRows.find(row=>row.id===draft.id)?.title||'')))setDraft(current=>current?{...current,code:value.code}:current);}).catch(error=>{if(live&&sameScope())setError(error instanceof Error?error.message:'编码建议读取失败');}).finally(()=>{if(live)setSuggesting(false);});},140);return()=>{live=false;clearTimeout(timer);};},[dictionaryMode,draft?.name,draft?.id,draft?.parentId,dictionaryLocked,scope]);
  const [deleting, setDeleting] = useState<ResourceDto | null>(null), [drag, setDrag] = useState<number | null>(null);
  const load = useCallback(async () => {
    const serial = ++request.current;
    const current = () => mounted.current && scopeRef.current === scope && serial === request.current;
    const all=await loadResourceDirectory(target,current,sortField,{includeInactive:true,preserveOrder:true,scopedQuery:{...(archiveType?{tab:archiveType}:{}),...(context?{fieldKey:context.field,fieldValue:context.value}:{})}});if(!all)return;
    if (current()) setRowState({ scope, rows: all.sort((a, b) => Number(a.data[sortField] ?? 0) - Number(b.data[sortField] ?? 0) || (def.categoryOrder ? a.title.localeCompare(b.title, 'zh-CN') : 0) || a.id - b.id) });
  }, [scope, target, archiveType, context?.field, context?.value, sortField, def.categoryOrder]);
  useEffect(() => {
    mounted.current = true; working.current = false; setLoading(true); setError(''); setBusy(false); setDraft(editorOnlyParentId!==undefined?{parentId:editorOnlyParentId,name:'',code:''}:null); setDeleting(null); setDrag(null); setSelected(selectedId ?? rootId ?? 0);
    void load().catch(e => { if (scopeRef.current === scope && mounted.current) setError(e instanceof Error ? e.message : '分类加载失败'); }).finally(() => { if (scopeRef.current === scope && mounted.current) setLoading(false); });
    return () => { mounted.current = false; request.current++; };
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const allById = new Map(allRows.map(r=>[r.id,r]));
  const rows = allRows.filter(r => (!def.categoryOrder || r.status === 'active') && (!context || r.data[context.field] === context.value) && (target !== 'finance-categories' || !family || matchesProductCategoryFamily(family,r.data)) && (!rootId || (()=>{const seen=new Set<number>();for(let current:ResourceDto|undefined=r;current&&!seen.has(current.id);current=allById.get(Number(current.data.parentId))){if(current.id===rootId)return true;seen.add(current.id);}return false;})()));
  useEffect(() => {
    if(target !== 'finance-categories' || !prefixFamily || prefixFamily === 'bundle') return;
    let alive=true; setPrefixReady(false); setPrefixEdit(false);
    const automatic=ARCHIVE_TYPE_CODE[prefixFamily] || prefixFamily.toUpperCase().slice(0,8);setPrefix(automatic);setSavedPrefix(automatic);
    resourceApi.list('finance-archive-prefixes',{fieldKey:'archiveType',fieldValue:prefixFamily,pageSize:200}).then(r=>{const configured=r.items.find(x=>x.type==='finance-archive-prefixes'&&x.data.archiveType===prefixFamily);if(alive){if(configured){setPrefix(String(configured.data.code));setSavedPrefix(String(configured.data.code));}setPrefixReady(true);}}).catch(()=>{if(alive)setError('类型编号读取失败，请关闭后重试。');});
    return()=>{alive=false;};
  },[target,prefixFamily,scope]);
  const byId = useMemo(() => new Map(rows.map(r => [r.id, r])), [rows]);
  const children = (id:number)=>{const values=rows.filter(r=>Number(r.data.parentId??0)===id);return target==='finance-fee-categories'&&expenseSort?applyExpenseSortOrder(values,expenseSort.value.categoryOrders[String(id||'root')]):values;};
  const path = (id: number) => {
    const result: ResourceDto[] = [], seen = new Set<number>();
    for (let r = byId.get(id); r && !seen.has(r.id); r = byId.get(Number(r.data.parentId))) { seen.add(r.id); result.unshift(r); }
    return result;
  };
  const archiveNoun = ({raw:'原料',self_made:'自产成品',purchased:'外购成品',original_purchase:'原装采购成品',supplier_oem:'供应商 OEM 成品',package:'产品包装',oem_package:'OEM包装',shipping_material:'发货物料',bundle:'组合编码'} as Record<string,string>)[family] || ({'finance-supplier-categories':'供应商','finance-customer-categories':'客户','finance-fee-categories':'费用项'} as Record<string,string>)[target] || '商品';
  const categoryTitle = codeMode ? `${codeLabel}分类` : target === 'finance-categories' ? `${archiveNoun}分类` : rootId && byId.get(rootId) ? `${byId.get(rootId)!.title}分类` : def.label;
  const categoryName = (row:ResourceDto) => archiveType==='bundle' ? bundleCategoryDisplayName(row.title) : row.title;
  const selectedPath = path(selected).filter(r => r.id !== rootId);
  const roots = children(rootId ?? 0);
  const actualDepth = Math.max(1, ...rows.map(r => path(r.id).length - (rootId ? 1 : 0)));
  const columnCount = target === 'finance-fee-categories' ? Math.min(10,Math.max(maxDepth,actualDepth + 1)) : Math.max(maxDepth,actualDepth);
  const reading = loading || rowState.scope !== scope;
  const countOf = (row: ResourceDto, seen = new Set<number>()): number | undefined => {
    if (seen.has(row.id)) return undefined;
    seen.add(row.id);
    const value = def.categoryOrder?.countField ? row.data[def.categoryOrder.countField] : counts[row.id] ?? 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
    if (!codeMode) return value;
    let total = value;
    for (const child of children(row.id)) {
      const childCount = countOf(child, seen);
      if (childCount === undefined || !Number.isSafeInteger(total + childCount)) return undefined;
      total += childCount;
    }
    return total;
  };
  const deleteDisabled = (row: ResourceDto) => busy || locked || !allowDelete || guardDeleteReferences && (children(row.id).length > 0 || countOf(row) === undefined || countOf(row)! > 0);
  const run = async (action: () => Promise<void>) => {
    if (working.current || !sameScope()) return;
    working.current = true; setBusy(true); setError('');
    let saved = false;
    try { await action(); if (!sameScope()) return; saved = true; await load(); } catch (e) { if (sameScope()) setError(e instanceof ApiError || e instanceof Error ? e.message : '操作失败'); } finally { if (sameScope()) { working.current = false; setBusy(false); if (saved) onChanged(); } }
    return saved;
  };
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!draft || busy || locked || !sameScope() || editorOnlyParentId!==undefined&&reading) return;
    if (!draft.name.trim()) return setError('请填写分类名称。');
    if(dictionaryMode){if(suggesting)return setError('正在生成编码，请稍候。');if(dictionaryPreview?.nameConflict)return setError('同一公司内分类名称不能重复。');if(dictionaryLocked&&draft.code!==String(allRows.find(row=>row.id===draft.id)?.data.code||''))return setError('该分类已有引用，不能修改编码。');}
    if (children(draft.parentId).some(r => r.id !== draft.id && categoryName(r).trim() === draft.name.trim())) return setError('同一上级分类下已存在同名分类。');
    const payload = { ...(draft.id && ['finance-supplier-categories','finance-customer-categories'].includes(target) && byId.get(draft.id)?.data.parentId ? { parentId: draft.parentId } : {}), name: draft.name.trim(), ...(codeKey ? { [codeKey]: draft.code.trim() } : {}), ...(!draft.id ? { ...(context ? { [context.field]: context.value } : {}), ...(family ? { archiveType: family } : {}), ...(draft.parentId ? { parentId: draft.parentId } : {}), [sortField]: def.categoryOrder ? 0 : Math.max(0, ...children(draft.parentId).map(r => Number(r.data[sortField] ?? 0))) + 10 } : {}) };
    const saved=await run(async () => { const saved = draft.id ? await resourceApi.update(target, draft.id, payload) : await resourceApi.create(target, payload); if (sameScope()) { setDraft(null); if (def.categoryOrder) { setSelected(saved.id); setRowState(current => current.scope !== scope ? current : { scope, rows: [...current.rows.filter(row => row.id !== saved.id), saved].sort((a,b) => Number(a.data[sortField] ?? 0) - Number(b.data[sortField] ?? 0) || a.title.localeCompare(b.title, 'zh-CN') || a.id-b.id) }); } } });
    if(saved&&(editorOnlyParentId!==undefined||target==='finance-fee-categories')&&sameScope())onClose();
  }
  async function reorder(sourceId: number, beforeId: number) {
    if (locked || !can('edit') || !sameScope()) return;
    const source = byId.get(sourceId), before = byId.get(beforeId);
    if (!source || !before || source.id === before.id || Number(source.data.parentId ?? 0) !== Number(before.data.parentId ?? 0)) return;
    const siblings = children(Number(source.data.parentId ?? 0)).filter(r => r.id !== sourceId);
    siblings.splice(siblings.findIndex(r => r.id === beforeId), 0, source);
    await run(async () => { await resourceApi.reorderCategories(target,siblings.map(r=>r.id)); });
  }
  async function deleteConfirmed(reason: string) {
    if (!deleting || locked || !allowDelete || !sameScope()) return;
    await resourceApi.remove(target, deleting.id, reason || '分类管理确认删除分类');
    if (!sameScope()) return;
    if (selected === deleting.id) setSelected(Number(deleting.data.parentId) || 0);
    if (draft?.id === deleting.id) setDraft(null);
    setDeleting(null); setRowState(current => current.scope !== scope ? current : { scope, rows: current.rows.filter(row => row.id !== deleting.id) });
    try { await load(); } catch (error) { if(sameScope())setError(error instanceof Error ? error.message : '分类刷新失败'); } if (sameScope()) onChanged();
  }
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key!=='Escape'||e.defaultPrevented||busy||deleting)return;e.preventDefault();if(draft){if(editorOnlyParentId!==undefined||target==='finance-fee-categories')onClose();else{setDraft(null);setError('');}}else if(prefixEdit){setPrefix(savedPrefix);setPrefixEdit(false);}else onClose();};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[busy,deleting,draft,prefixEdit,savedPrefix,onClose,editorOnlyParentId]);
  const levelNames = ['一级分类', '二级分类', '三级分类', '四级分类','五级分类','六级分类','七级分类','八级分类','九级分类','十级分类'];
  const editorLevel = draft ? path(draft.parentId).length - (rootId ? 1 : 0) + 1 : 1;
  const editorTitle = draft?.id ? '编辑分类' : `新增${levelNames[editorLevel - 1] ?? '分类'}`;
  const editorDescription = draft?.id ? '修改名称或分类标识，不改变分类所在层级。' : draft?.parentId ? `上级分类：${path(draft.parentId).map(categoryName).join(' / ')}` : '该分类将直接显示在一级分类中。';
  const feeEditor=draft&&target==='finance-fee-categories'?<FeeCategoryEditor editing={!!draft.id} name={draft.name} busy={busy} loading={reading} error={error} onName={name=>{setDraft({...draft,name});setError('');}} onSubmit={save} onClose={onClose}/>:null;
  if(editorOnlyParentId!==undefined)return feeEditor;
  if(target==='finance-fee-categories')return <>{feeEditor||<FeeCategoryManagerView title={`管理${categoryTitle}`} rows={rows} rootId={rootId} selected={selected} counts={directCounts} order={expenseSort?.value.categoryOrders} onMove={expenseSort?(parent,source,dest)=>expenseSort.move('categoryOrders',String(parent||'root'),children(parent).map(row=>row.id),source,dest):undefined} reading={reading} busy={busy} error={error} canCreate={can('create')&&!locked} canEdit={can('edit')&&!locked} canDelete={can('delete')&&!locked&&allowDelete} onSelect={id=>{setSelected(id);onPick?.(id);}} onAdd={parentId=>{setError('');setDraft({parentId,name:'',code:''});}} onEdit={row=>{setError('');setDraft({id:row.id,parentId:Number(row.data.parentId)||0,name:row.title,code:''});}} onDelete={setDeleting} onClose={onClose}/>} {deleting&&<MessageConfirm title="确认删除" hint="删除后不会在当前列表继续显示。" presentation="finance-delete" subject={deleting.title} confirmationText="请确认是否删除这条分类。" confirmLabel="确认删除" danger requireReason={false} onClose={()=>setDeleting(null)} onConfirm={deleteConfirmed}/>}</>;
  return <div className={`modal-backdrop fcm-backdrop${context ? ' fcm-scoped-backdrop' : ''}${codeMode?' fcm-code-backdrop':''}`}>
    <section className={`fcm${context ? ' fcm-scoped' : ''}${codeMode?' fcm-code':''}`} role="dialog" aria-modal="true" aria-label={`管理${categoryTitle}`}>
      <header className="fcm-head"><span className="fcm-title-icon"><FolderTree size={22}/></span><div><span>{codeMode?`${codeLabel} · 分类设置`:presentation?.kicker ?? `${target === 'finance-categories' ? '商品档案' : '财务基础资料'} · 分类设置`}</span><h2>管理{categoryTitle}</h2><p>{codeMode?'两套编码分类分别维护，同一公司内分类名称不能重复。':presentation?.description ?? `按一级、二级、三级逐层维护，${archiveNoun}归入最末级分类。`}</p></div><div className="fcm-summary"><span><b>{context && reading ? '—' : roots.length}</b> 个一级分类</span><span><b>{context && reading ? '—' : rows.length}</b> 个分类节点</span></div><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></header>
      {codeMode&&<CodeCategorySync scope={archiveType==='bundle'?'bundle':'product'}/>}
      {target === 'finance-categories' && !archiveType && <label className="fcm-family">所属档案类型<select value={family} disabled={busy} onChange={e => { setFamily(e.target.value); setSelected(0); setDraft(null); }}><option value="">请选择档案类型</option>{[...new Set(allRows.map(r => String(r.data.archiveType)))].map(t => <option key={t} value={t}>{({raw:'原料',self_made:'自产成品',purchased:'外购成品',original_purchase:'原装采购',supplier_oem:'供应商 OEM',package:'产品包装',oem_package:'OEM 包装',shipping_material:'发货物料',bundle:'组合分类'} as Record<string,string>)[t] ?? t}</option>)}</select></label>}
      {target === 'finance-categories' && prefixFamily && prefixFamily !== 'bundle' && <div className="fcm-prefix"><div><span>{archiveNoun}档案标识</span>{prefixEdit ? <input aria-label="顶级分类编号" value={prefix} maxLength={8} onChange={e=>setPrefix(e.target.value.toUpperCase())}/> : <strong>{prefix}</strong>}</div>{can('edit') && (prefixEdit ? <button type="button" className="primary-button" disabled={busy||!prefix.trim()} onClick={()=>void run(async()=>{const saved=await resourceApi.saveArchivePrefix(prefixFamily,prefix);if(sameScope()){setPrefix(String(saved.data.code));setSavedPrefix(String(saved.data.code));setPrefixEdit(false);}})}>保存编号</button> : <button type="button" className="secondary-button" disabled={busy||!prefixReady} onClick={()=>setPrefixEdit(true)}>修改顶级编号</button>)}<small>用于后续自动编号，已有商品编码保持不变。</small></div>}
      {context && !codeMode && <div className="fcm-context"><label><span>{context.label}</span><input aria-label={context.label} readOnly value={context.text}/></label></div>}
      {reading && <p role="status">正在加载分类…</p>}
      {error && <p role="alert" className="notice error">{error}</p>}
      <div className="fcm-content"><div className="fcm-columns" aria-busy={reading} style={{ gridTemplateColumns: context ? undefined : `repeat(${columnCount}, minmax(230px, 1fr))`, '--fcm-levels': columnCount } as CSSProperties}>
        {Array.from({ length: columnCount }, (_, level) => {
          const parent = level === 0 ? undefined : selectedPath[level - 1], parentId = parent?.id ?? rootId ?? 0, enabled = level === 0 || !!parent;
          return <section key={level} className="fcm-column" aria-label={levelNames[level]}><header><strong><i>{level + 1}</i>{levelNames[level]}</strong>{enabled && can('create') && !locked && (!def.categoryOrder || level < maxDepth) && (target !== 'finance-categories' || !!family) && <button type="button" disabled={busy || reading} onClick={() => setDraft({ parentId, name: '', code: '' })}>{context && <Plus size={13}/>}新增</button>}</header>
            <div className="fcm-list">{context && reading ? null : !enabled ? <div className="fcm-empty"><FolderTree size={29}/><strong>请先选择{codeMode?levelNames[level-1]:'上一级分类'}</strong><span>选择后将在这里显示下级分类</span></div> : children(parentId).length === 0 ? <div className="fcm-empty"><FolderTree size={29}/><strong>暂无{levelNames[level]}</strong><span>点击右上角“新增”开始创建</span></div> : children(parentId).map(r => <div key={r.id} className={`fcm-row${selectedPath[level]?.id === r.id ? ' selected' : ''}`} draggable={can('edit') && !busy && !locked} onDragStart={() => setDrag(r.id)} onDragOver={e => { if (drag && Number(byId.get(drag)?.data.parentId ?? 0) === parentId) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (drag) void reorder(drag, r.id); setDrag(null); }} onDragEnd={() => setDrag(null)}>
              <button type="button" className="fcm-node" onClick={() => { setSelected(r.id); onPick?.(r.id); }}><strong>{presentation ? <span>{categoryName(r)}</span> : categoryName(r)}{codeKey && <code>{String(r.data[codeKey] ?? '')}</code>}</strong><small>{countOf(r) ?? '—'} {codeMode?'条资料':presentation?.unit ?? '条资料'}{codeMode || !presentation || level < columnCount - 1 ? ` · ${children(r.id).length} 个下级` : ''}</small>{(codeMode || presentation) && level === columnCount - 1 ? <Check size={15}/> : <ChevronRight size={15}/>}</button>
              <div className="fcm-actions"><span className="fcm-grip" title="拖动调整同级顺序"><GripVertical size={14}/></span>{can('edit') && !locked && <button type="button" aria-label={`编辑${categoryName(r)}`} disabled={busy} onClick={() => setDraft({ id: r.id, parentId, name: categoryName(r), code: String(r.data[codeKey] ?? '') })}><Pencil size={13}/></button>}{can('delete') && !locked && <button type="button" className="danger" aria-label={`删除${categoryName(r)}`} disabled={deleteDisabled(r)} title="含下级分类或资料的分类不能删除" onClick={() => setDeleting(r)}><Trash2 size={13}/></button>}</div>
            </div>)}</div>
            {codeMode&&level===columnCount-1?<p className="fcm-level-limit">四级为最深层级；任意没有下级的分类都可归入商品编码。</p>:presentation && level === columnCount - 1 && enabled && <p className="fcm-level-limit">{levelNames[level].replace('分类','')}为最末级，{presentation.unit.replace(/^个/,'')}可归入该级分类。</p>}
          </section>;
        })}
      </div></div><footer><span>{codeMode?<><strong>使用提示：</strong>选择分类可查看下一级；可编辑、删除或拖动同级分类排序。含下级或已关联资料的分类不能删除。</>:presentation ? <><strong>使用提示：</strong>{presentation.footer}</> : '使用提示：选择分类可查看下一级；含下级分类或资料的分类不能删除。'}</span><span>{codeMode?'最多四级分类':target === 'finance-fee-categories' ? '支持多级分类' : presentation ? `最多${levelNames[columnCount - 1] ?? `${columnCount}级分类`}` : `最多${columnCount}级分类`}</span></footer>
    </section>
    {feeEditor}
    {draft && target!=='finance-fee-categories' && <div className="modal-backdrop fcm-editor-backdrop" onMouseDown={event => { if(context && !busy && event.target === event.currentTarget){setDraft(null);setError('');} }}><form className={`fcm-editor${context ? ' fcm-editor-scoped' : ''}`} role="dialog" aria-label={draft.id ? '编辑分类' : context ? editorTitle : '新增分类'} onSubmit={save}><header>{context ? <><span className="fcm-editor-icon"><FolderTree size={22}/></span><div><span>{draft.id ? `第 ${editorLevel} 级分类` : '创建新分类'}</span><h3>{editorTitle}</h3><p>{editorDescription}</p></div><button type="button" className="fcm-editor-close" aria-label="关闭" disabled={busy} onClick={() => {setDraft(null);setError('');}}>×</button></> : <><h3>{editorTitle}</h3><p>{editorDescription}</p></>}</header>{draft.id && ['finance-supplier-categories','finance-customer-categories'].includes(target) && !!byId.get(draft.id)?.data.parentId && <label>上级分类<select value={draft.parentId} onChange={e => setDraft({ ...draft, parentId:Number(e.target.value) })}>{rows.filter(r => path(r.id)[0]?.id === path(draft.id!)[0]?.id && !path(r.id).some(p => p.id === draft.id)).map(r => <option key={r.id} value={r.id}>{path(r.id).map(p => p.title).join(' / ')}</option>)}</select></label>}<label>分类名称 <b className="req">必填</b><input autoFocus value={draft.name} placeholder={context ? ['例如：包装','例如：装袋','例如：小袋装袋'][editorLevel - 1] : undefined} maxLength={archiveType==='bundle' ? 157 : def.categoryOrder ? def.fields.find(field => field.key === def.titleField)?.maxLength : 60} onChange={e => {codeGeneration.current++;setDraft({ ...draft, name: e.target.value,...(dictionaryMode&&!dictionaryLocked?{code:''}:{}) });}} /></label>{codeKey && <label>{target==='finance-labor-categories'?<span>分类标识 <small style={{fontSize:11,fontWeight:400,color:'#7a8799'}}>用于归档目录识别</small></span>:'分类标识'}<input value={draft.code} maxLength={def.categoryOrder ? def.fields.find(field => field.key === codeKey)?.maxLength : codeKey === 'code' ? 8 : 12} placeholder={context ? '不填则根据分类名称自动生成' : '不填则自动生成'} disabled={dictionaryLocked} onChange={e => {codeGeneration.current++;setDraft({ ...draft, code: def.categoryOrder ? e.target.value.toUpperCase() : e.target.value });}} /></label>}{dictionaryMode&&dictionaryPreview&&<p className="dictionary-code-suggestion">系统建议：{dictionaryPreview.code}</p>}{dictionaryLocked&&<p>{!draft.id||!dictionaryUsage[draft.id]?.known?'引用情况尚待核对，暂不能修改编码。':'该分类已有引用，不能修改编码。'}</p>}<div className="fcm-preview">保存后的分类路径<strong>{[...path(draft.parentId).map(categoryName), draft.name.trim() || '待填写分类名称'].join(' / ')}</strong></div>{error && <p role="alert" className="notice error">{error}</p>}<footer>{context && draft.id && can('delete') && byId.get(draft.id) && <button type="button" className="danger fcm-editor-delete" disabled={deleteDisabled(byId.get(draft.id)!)} onClick={() => setDeleting(byId.get(draft.id!)!)}>删除分类</button>}<button type="button" className="secondary-button" disabled={busy} onClick={() => { setDraft(null); setError(''); }}>取消</button><button className="primary-button" disabled={busy || suggesting || !!context && !draft.name.trim()}>{busy ? '保存中…' : draft.id ? '保存修改' : '确认创建'}</button></footer></form></div>}
    {deleting && (confirmation === 'message' ? <MessageConfirm title="请确认操作" hint={`确认删除${def.label}“${deleting.title}”吗？`} confirmLabel="确认" danger requireReason={false} onClose={() => setDeleting(null)} onConfirm={deleteConfirmed}/> : <ReasonDialog title={`删除「${deleting.title}」`} hint="含下级分类或资料的分类不能删除。" confirmLabel="确认删除" onClose={() => setDeleting(null)} onSubmit={deleteConfirmed}/>)}

  </div>;
}
