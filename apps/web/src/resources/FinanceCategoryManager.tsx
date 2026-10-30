import { ChevronRight, FolderTree, GripVertical, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ARCHIVE_TYPE_CODE, getResourceDef, resourcePermission, permissionOwner, createChecker } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { ReasonDialog } from './TreeManage';
import './financeCategoryManager.css';

/** 财务档案的分类设置：逐级选中、独立编辑层、同级排序。所有写入仍走资料权限和校验。 */
export function FinanceCategoryManager({ target, archiveType, rootId, selectedId, maxDepth = 3, counts = {}, onPick, onChanged, onClose }: {
  target: string; archiveType?: string; rootId?: number; selectedId?: number; maxDepth?: number;
  counts?: Record<number, number>; onPick?: (id: number) => void; onChanged: () => void; onClose: () => void;
}) {
  const { user } = useAuth();
  const can = (action: Parameters<typeof resourcePermission>[1]) => !!user && createChecker(user.permissions)(resourcePermission(permissionOwner(target), action));
  const def = getResourceDef(target)!;
  const codeKey = def.fields.some(f => f.key === 'code') ? 'code' : def.fields.some(f => f.key === 'categoryCode') ? 'categoryCode' : '';
  const [family, setFamily] = useState(archiveType ?? '');
  const prefixFamily = ['original_purchase','supplier_oem'].includes(family) ? 'purchased' : family;
  const [prefix, setPrefix] = useState(''), [prefixEdit, setPrefixEdit] = useState(false), [prefixReady,setPrefixReady] = useState(false), [savedPrefix,setSavedPrefix]=useState('');
  const [allRows, setAllRows] = useState<ResourceDto[]>([]);
  const [selected, setSelected] = useState(selectedId ?? rootId ?? 0);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ id?: number; parentId: number; name: string; code: string } | null>(null);
  const [deleting, setDeleting] = useState<ResourceDto | null>(null), [drag, setDrag] = useState<number | null>(null);
  const load = async () => {
    const all: ResourceDto[] = [];
    for (let page = 1; ; page++) {
      const res = await resourceApi.list(target, { page, pageSize: 200, showHidden: true, ...(archiveType ? { tab: archiveType } : {}) });
      all.push(...res.items);
      if (all.length >= res.total || !res.items.length) break;
    }
    setAllRows(all.sort((a, b) => Number(a.data.sort ?? 0) - Number(b.data.sort ?? 0) || a.id - b.id));
  };
  useEffect(() => { let alive = true; setLoading(true); load().catch(e => alive && setError(e instanceof Error ? e.message : '分类加载失败')).finally(() => alive && setLoading(false)); return () => { alive = false; }; }, [target, archiveType]); // eslint-disable-line react-hooks/exhaustive-deps
  const allById = new Map(allRows.map(r=>[r.id,r]));
  const rows = allRows.filter(r => (target !== 'finance-categories' || !family || r.data.archiveType === family) && (!rootId || (()=>{const seen=new Set<number>();for(let current:ResourceDto|undefined=r;current&&!seen.has(current.id);current=allById.get(Number(current.data.parentId))){if(current.id===rootId)return true;seen.add(current.id);}return false;})()));
  useEffect(() => {
    if(target !== 'finance-categories' || !prefixFamily || prefixFamily === 'bundle') return;
    let alive=true; setPrefixReady(false); setPrefixEdit(false);
    const automatic=ARCHIVE_TYPE_CODE[prefixFamily] || prefixFamily.toUpperCase().slice(0,8);setPrefix(automatic);setSavedPrefix(automatic);
    resourceApi.list('finance-archive-prefixes',{fieldKey:'archiveType',fieldValue:prefixFamily,pageSize:200}).then(r=>{const configured=r.items.find(x=>x.type==='finance-archive-prefixes'&&x.data.archiveType===prefixFamily);if(alive){if(configured){setPrefix(String(configured.data.code));setSavedPrefix(String(configured.data.code));}setPrefixReady(true);}}).catch(()=>{if(alive)setError('类型编号读取失败，请关闭后重试。');});
    return()=>{alive=false;};
  },[target,prefixFamily]);
  const byId = useMemo(() => new Map(rows.map(r => [r.id, r])), [rows]);
  const children = (id: number) => rows.filter(r => Number(r.data.parentId ?? 0) === id);
  const path = (id: number) => {
    const result: ResourceDto[] = [], seen = new Set<number>();
    for (let r = byId.get(id); r && !seen.has(r.id); r = byId.get(Number(r.data.parentId))) { seen.add(r.id); result.unshift(r); }
    return result;
  };
  const archiveNoun = ({raw:'原料',self_made:'自产成品',purchased:'外购成品',original_purchase:'原装采购成品',supplier_oem:'供应商 OEM 成品',package:'产品包装',oem_package:'OEM包装',shipping_material:'发货物料',bundle:'组合编码'} as Record<string,string>)[family] || ({'finance-supplier-categories':'供应商','finance-customer-categories':'客户','finance-fee-categories':'费用项'} as Record<string,string>)[target] || '商品';
  const categoryTitle = target === 'finance-categories' ? `${archiveNoun}分类` : rootId && byId.get(rootId) ? `${byId.get(rootId)!.title}分类` : def.label;
  const selectedPath = path(selected).filter(r => r.id !== rootId);
  const roots = children(rootId ?? 0);
  const actualDepth = Math.max(1, ...rows.map(r => path(r.id).length - (rootId ? 1 : 0)));
  const columnCount = target === 'finance-fee-categories' ? Math.min(10,Math.max(maxDepth,actualDepth + 1)) : Math.max(maxDepth,actualDepth);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); await load(); onChanged(); } catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  };
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!draft || busy) return;
    if (!draft.name.trim()) return setError('请填写分类名称。');
    if (children(draft.parentId).some(r => r.id !== draft.id && r.title.trim() === draft.name.trim())) return setError('同一上级分类下已存在同名分类。');
    const payload = { ...(draft.id && ['finance-supplier-categories','finance-customer-categories'].includes(target) && byId.get(draft.id)?.data.parentId ? { parentId: draft.parentId } : {}), name: draft.name.trim(), ...(codeKey ? { [codeKey]: draft.code.trim() } : {}), ...(!draft.id ? { ...(family ? { archiveType: family } : {}), ...(draft.parentId ? { parentId: draft.parentId } : {}), sort: Math.max(0, ...children(draft.parentId).map(r => Number(r.data.sort ?? 0))) + 10 } : {}) };
    await run(async () => { if (draft.id) await resourceApi.update(target, draft.id, payload); else await resourceApi.create(target, payload); setDraft(null); });
  }
  async function reorder(sourceId: number, beforeId: number) {
    const source = byId.get(sourceId), before = byId.get(beforeId);
    if (!source || !before || source.id === before.id || Number(source.data.parentId ?? 0) !== Number(before.data.parentId ?? 0)) return;
    const siblings = children(Number(source.data.parentId ?? 0)).filter(r => r.id !== sourceId);
    siblings.splice(siblings.findIndex(r => r.id === beforeId), 0, source);
    await run(async () => { await resourceApi.reorderCategories(target,siblings.map(r=>r.id)); });
  }
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key!=='Escape'||e.defaultPrevented||busy||deleting)return;e.preventDefault();if(draft){setDraft(null);setError('');}else if(prefixEdit){setPrefix(savedPrefix);setPrefixEdit(false);}else onClose();};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[busy,deleting,draft,prefixEdit,savedPrefix,onClose]);
  const levelNames = ['一级分类', '二级分类', '三级分类', '四级分类','五级分类','六级分类','七级分类','八级分类','九级分类','十级分类'];
  return <div className="modal-backdrop fcm-backdrop">
    <section className="fcm" role="dialog" aria-modal="true" aria-label={`管理${categoryTitle}`}>
      <header className="fcm-head"><span className="fcm-title-icon"><FolderTree size={22}/></span><div><span>{target === 'finance-categories' ? '商品档案' : '财务基础资料'} · 分类设置</span><h2>管理{categoryTitle}</h2><p>按一级、二级、三级逐层维护，{archiveNoun}归入最末级分类。</p></div><div className="fcm-summary"><span><b>{roots.length}</b> 个一级分类</span><span><b>{rows.length}</b> 个分类节点</span></div><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></header>
      {target === 'finance-categories' && !archiveType && <label className="fcm-family">所属档案类型<select value={family} onChange={e => { setFamily(e.target.value); setSelected(0); setDraft(null); }}><option value="">请选择档案类型</option>{[...new Set(allRows.map(r => String(r.data.archiveType)))].map(t => <option key={t} value={t}>{({raw:'原料',self_made:'自产成品',purchased:'外购成品',original_purchase:'原装采购',supplier_oem:'供应商 OEM',package:'产品包装',oem_package:'OEM 包装',shipping_material:'发货物料',bundle:'组合分类'} as Record<string,string>)[t] ?? t}</option>)}</select></label>}
      {target === 'finance-categories' && prefixFamily && prefixFamily !== 'bundle' && <div className="fcm-prefix"><div><span>{archiveNoun}档案标识</span>{prefixEdit ? <input aria-label="顶级分类编号" value={prefix} maxLength={8} onChange={e=>setPrefix(e.target.value.toUpperCase())}/> : <strong>{prefix}</strong>}</div>{can('edit') && (prefixEdit ? <button type="button" className="primary-button" disabled={busy||!prefix.trim()} onClick={()=>void run(async()=>{const saved=await resourceApi.saveArchivePrefix(prefixFamily,prefix);setPrefix(String(saved.data.code));setSavedPrefix(String(saved.data.code));setPrefixEdit(false);})}>保存编号</button> : <button type="button" className="secondary-button" disabled={busy||!prefixReady} onClick={()=>setPrefixEdit(true)}>修改顶级编号</button>)}<small>用于后续自动编号，已有商品编码保持不变。</small></div>}
      {loading && <p role="status">正在加载分类…</p>}
      {error && <p role="alert" className="notice error">{error}</p>}
      <div className="fcm-columns" style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(230px, 1fr))` }}>
        {Array.from({ length: columnCount }, (_, level) => {
          const parent = level === 0 ? undefined : selectedPath[level - 1], parentId = parent?.id ?? rootId ?? 0, enabled = level === 0 || !!parent;
          return <section key={level} className="fcm-column" aria-label={levelNames[level]}><header><strong><i>{level + 1}</i>{levelNames[level]}</strong>{enabled && can('create') && (target !== 'finance-categories' || !!family) && <button type="button" disabled={busy} onClick={() => setDraft({ parentId, name: '', code: '' })}>新增</button>}</header>
            {!enabled ? <div className="fcm-empty"><FolderTree size={29}/><strong>请先选择上一级分类</strong><span>选择后将在这里显示下级分类</span></div> : children(parentId).length === 0 ? <div className="fcm-empty"><FolderTree size={29}/><strong>暂无{levelNames[level]}</strong><span>点击右上角“新增”开始创建</span></div> : children(parentId).map(r => <div key={r.id} className={`fcm-row${selectedPath[level]?.id === r.id ? ' selected' : ''}`} draggable={can('edit') && !busy} onDragStart={() => setDrag(r.id)} onDragOver={e => { if (drag && Number(byId.get(drag)?.data.parentId ?? 0) === parentId) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (drag) void reorder(drag, r.id); setDrag(null); }} onDragEnd={() => setDrag(null)}>
              <button type="button" className="fcm-node" onClick={() => { setSelected(r.id); onPick?.(r.id); }}><strong>{r.title}{codeKey && <code>{String(r.data[codeKey] ?? '')}</code>}</strong><small>{counts[r.id] ?? 0} 条资料 · {children(r.id).length} 个下级</small><ChevronRight size={15}/></button>
              <div className="fcm-actions"><span className="fcm-grip" title="拖动调整同级顺序"><GripVertical size={14}/></span>{can('edit') && <button type="button" aria-label={`编辑${r.title}`} disabled={busy} onClick={() => setDraft({ id: r.id, parentId, name: r.title, code: String(r.data[codeKey] ?? '') })}><Pencil size={13}/></button>}{can('delete') && <button type="button" className="danger" aria-label={`删除${r.title}`} disabled={busy || children(r.id).length > 0 || (counts[r.id] ?? 0) > 0} title="含下级分类或资料的分类不能删除" onClick={() => setDeleting(r)}><Trash2 size={13}/></button>}</div>
            </div>)}
          </section>;
        })}
      </div><footer><span>使用提示：选择分类可查看下一级；含下级分类或资料的分类不能删除。</span><span>{target === 'finance-fee-categories' ? '支持多级分类' : `最多${columnCount}级分类`}</span></footer>
    </section>
    {draft && <div className="modal-backdrop fcm-editor-backdrop"><form className="fcm-editor" role="dialog" aria-label={draft.id ? '编辑分类' : '新增分类'} onSubmit={save}><header><h3>{draft.id ? '编辑分类' : `新增${levelNames[path(draft.parentId).length - (rootId ? 1 : 0)] ?? '分类'}`}</h3><p>{draft.id ? '修改名称或分类标识，不改变分类所在层级。' : draft.parentId ? `上级分类：${path(draft.parentId).map(r => r.title).join(' / ')}` : '该分类将直接显示在一级分类中。'}</p></header>{draft.id && ['finance-supplier-categories','finance-customer-categories'].includes(target) && !!byId.get(draft.id)?.data.parentId && <label>上级分类<select value={draft.parentId} onChange={e => setDraft({ ...draft, parentId:Number(e.target.value) })}>{rows.filter(r => path(r.id)[0]?.id === path(draft.id!)[0]?.id && !path(r.id).some(p => p.id === draft.id)).map(r => <option key={r.id} value={r.id}>{path(r.id).map(p => p.title).join(' / ')}</option>)}</select></label>}<label>分类名称 <b className="req">必填</b><input autoFocus value={draft.name} maxLength={60} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>{codeKey && <label>分类标识<input value={draft.code} maxLength={codeKey === 'code' ? 8 : 12} placeholder="不填则自动生成" onChange={e => setDraft({ ...draft, code: e.target.value })} /></label>}<div className="fcm-preview">保存后的分类路径<strong>{[...path(draft.parentId).map(r => r.title), draft.name.trim() || '待填写分类名称'].join(' / ')}</strong></div>{error && <p role="alert" className="notice error">{error}</p>}<footer><button type="button" className="secondary-button" disabled={busy} onClick={() => { setDraft(null); setError(''); }}>取消</button><button className="primary-button" disabled={busy}>{busy ? '保存中…' : draft.id ? '保存修改' : '确认创建'}</button></footer></form></div>}
    {deleting && <ReasonDialog title={`删除「${deleting.title}」`} hint="含下级分类或资料的分类不能删除。" confirmLabel="确认删除" onClose={() => setDeleting(null)} onSubmit={async reason => { await resourceApi.remove(target, deleting.id, reason); if (selected === deleting.id) setSelected(Number(deleting.data.parentId) || 0); setDeleting(null); await load(); onChanged(); }} />}
  </div>;
}
