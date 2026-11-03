import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getResourceDef, unitYuanText } from '@kudesi/shared';
import { BriefcaseBusiness, CalendarDays, CircleDollarSign, Copy, Database, FolderTree, Plus, Search } from 'lucide-react';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { ReasonDialog, RecordForm, clearRefCache } from '../../../resources/RecordForm';
import { useResourceCan } from '../../../resources/RecordDetail';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { CategoryTree, buildCategoryTree, findNode, subtreeIds } from './CategoryTree';
import { CopyVersionDialog } from './CopyVersionDialog';
import { FinanceCategoryManager } from '../../../resources/FinanceCategoryManager';
import './labor-page.css';

const err = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

/** 人力成本表：成本版本 → 项目归档分类树 → 工作项目；工作分类和计价单位可自己维护。 */
export function LaborCostPage() {
  const can = useResourceCan('finance-labor-costs');
  const { can: has, user } = useAuth();
  const scopeKey = JSON.stringify([user?.companyId, user?.id]);
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const mounted = useRef(false), versionRequest = useRef(0);
  const canSeeCost = has('product.cost.view');
  const [versions, setVersions] = useState<ResourceDto[] | null>(null);
  const [versionId, setVersionId] = useState<number | null>(null);
  const [cats, setCats] = useState<ResourceDto[]>([]);
  const [items, setItems] = useState<ResourceDto[]>([]);
  const [selectedCat, setSelectedCat] = useState<number | null>(null);
  const [keyword, setKeyword] = useState('');
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copying, setCopying] = useState(false);
  const [managing,setManaging] = useState(false);
  const request = useRef(0);
  const versionRef = useRef(versionId); versionRef.current = versionId;
  const [versionForm, setVersionForm] = useState<{ record: ResourceDto | null } | null>(null);
  const [itemForm, setItemForm] = useState<{ record: ResourceDto | null; initial?: Record<string, unknown> } | null>(null);
  const [reason, setReason] = useState<{ title: string; hint?: string; confirm: string; danger?: boolean; run: (reason: string) => Promise<void> } | null>(null);

  const loadVersions = useCallback(async () => {
    if (!mounted.current || scopeRef.current !== scopeKey) return;
    const serial = ++versionRequest.current;
    try {
      const rows: ResourceDto[] = [];
      for (let page = 1; ; page++) {
        if (!mounted.current || serial !== versionRequest.current || scopeRef.current !== scopeKey) return;
        const result = await resourceApi.list('finance-labor-versions', { page, pageSize: 200, showHidden: true });
        rows.push(...result.items);
        if (!result.items.length || rows.length >= result.total) break;
      }
      if (!mounted.current || serial !== versionRequest.current || scopeRef.current !== scopeKey) return;
      const rank = (status: string) => ({ active: 0, draft: 1, inactive: 2 }[status] ?? 3);
      rows.sort((a, b) => Number(b.data.isDefault === true) - Number(a.data.isDefault === true) || rank(a.status) - rank(b.status) || String(b.data.effectiveFrom ?? '').localeCompare(String(a.data.effectiveFrom ?? '')) || b.id - a.id);
      setVersions(rows);
      setVersionId(cur => rows.some(row => row.id === cur) ? cur : rows.find(row => row.data.isDefault === true)?.id ?? rows[0]?.id ?? null);
      setError('');
      return true;
    } catch (e) { if (mounted.current && serial === versionRequest.current && scopeRef.current === scopeKey) setError(err(e)); return false; }
  }, [scopeKey]);
  useEffect(() => {
    mounted.current = true; versionRef.current = null;
    setVersions(null); setVersionId(null); setCats([]); setItems([]); setLoadedVersion(null); setError(''); setNotice('');
    setItemForm(null); setVersionForm(null); setReason(null); setCopying(false);
    void loadVersions();
    return () => { mounted.current = false; versionRequest.current++; request.current++; };
  }, [loadVersions]);

  const loadVersionData = useCallback(async () => {
    if(!mounted.current || scopeRef.current !== scopeKey || versionId !== versionRef.current)return;
    const serial = ++request.current;
    if (versionId === null) { setCats([]); setItems([]); return; }
    try {
      const all = async (type: string) => {
        const out: ResourceDto[] = [];
        for (let p = 1; ; p++) {
          if (!mounted.current || serial !== request.current || scopeRef.current !== scopeKey) return out;
          const r = await resourceApi.list(type, { fieldKey: 'versionId', fieldValue: versionId, pageSize: 200, page: p, showHidden: true });
          out.push(...r.items);
          if (out.length >= r.total || !r.items.length) break;
        }
        return out;
      };
      const [c, i] = await Promise.all([all('finance-labor-categories'), all('finance-labor-costs')]);
      if (!mounted.current || serial !== request.current || scopeRef.current !== scopeKey) return;
      i.sort((a, b) => String(a.refLabels.archiveCategoryId ?? '').localeCompare(String(b.refLabels.archiveCategoryId ?? ''), 'zh-CN') || String(a.refLabels.workTypeId ?? '').localeCompare(String(b.refLabels.workTypeId ?? ''), 'zh-CN') || String(a.data.workCode ?? '').localeCompare(String(b.data.workCode ?? '')) || a.id - b.id);
      setCats(c); setSelectedCat(current => c.some(row => row.id === current) ? current : null); setItems(i); setLoadedVersion(versionId); setError('');
    } catch (e) { if(mounted.current && serial === request.current && scopeRef.current === scopeKey)setError(err(e)); }
  }, [versionId, scopeKey]);
  useEffect(() => { setSelectedCat(null); setKeyword(''); setManaging(false); setCats([]); setItems([]); setLoadedVersion(null); void loadVersionData(); return()=>{request.current++;}; }, [loadVersionData]);

  const version = versions?.find((v) => v.id === versionId) ?? null;
  const tree = useMemo(() => buildCategoryTree(cats, items.map((i) => (typeof i.data.archiveCategoryId === 'number' ? i.data.archiveCategoryId : null))), [cats, items]);
  const node = findNode(tree, selectedCat);
  const scope = node ? new Set(subtreeIds(node)) : null;
  const kw = keyword.trim().toLowerCase();
  const filtered = items.filter(i => (!scope || scope.has(Number(i.data.archiveCategoryId))) && (!kw || [i.data.workCode, i.data.workName, i.refLabels.archiveCategoryId, i.refLabels.workTypeId, i.refLabels.unitId, i.data.note].some(value => String(value ?? '').toLowerCase().includes(kw))));
  const dataReady = versionId !== null && loadedVersion === versionId;
  const defaultVersion = versions?.find(v => v.data.isDefault === true) ?? versions?.find(v => v.status === 'active');
  const isLeaf = node ? node.children.length === 0 : false;

  async function run(fn: () => Promise<unknown>, done?: string) {
    setError(''); setNotice('');
    try { await fn(); if (!mounted.current || scopeRef.current !== scopeKey) return; if (done) setNotice(done); if (await loadVersions()) await loadVersionData(); } catch (e) { if (mounted.current && scopeRef.current === scopeKey) setError(err(e)); }
  }
  const locked = version?.status === 'inactive';
  const selectWrittenVersion = (id: number | null) => { if (mounted.current && scopeRef.current === scopeKey) setVersionId(id); };

  return (
    <div className="labor-cost-page">
      <header className="labor-page-heading">
        <div><span>财务模块 · 数据版本</span><h1>人力成本表</h1><p>按版本维护各类工作的计价标准，供成本核算和业务单据引用。</p></div>
        {can('create') && <button type="button" className="primary-button" onClick={() => setVersionForm({ record: null })}><Plus size={16}/>新建成本版本</button>}
      </header>
      {error && <div role="alert" className="notice error">{error}</div>}
      {notice && <div role="status" className="notice ok">{notice}</div>}
      <section className="card labor-version-panel" aria-label="成本版本列表">
        <header><div><Database size={18}/><div><h2>成本版本</h2><p>点击版本查看对应的分类和工作项目</p></div></div><span>{versions ? `${versions.length} 个版本` : '加载中…'}</span></header>
        <div className="labor-version-rows">{(versions ?? []).map(v => <article key={v.id} className={`labor-version-row${v.id === versionId ? ' selected' : ''}`}>
          <button type="button" className="labor-version-select" aria-pressed={v.id === versionId} onClick={() => setVersionId(v.id)}><span className="labor-version-name"><strong>{v.title}</strong>{v.status === 'active' && <i>已启用</i>}</span><code>{String(v.data.versionCode ?? '')}</code><small>{String(v.data.periodName || '未设置期间')} · {String(v.data.effectiveFrom || '立即')} 至 {String(v.data.effectiveTo || '长期')} · {typeof v.data.itemCount === 'number' ? v.data.itemCount : v.id === versionId && dataReady ? items.length : '—'} 项</small></button>
          <div className="row-actions">{can('create') && <button type="button" onClick={()=>{setVersionId(v.id);setCopying(true);}}><Copy size={14}/>复制版本</button>}
          {can('edit') && v.status === 'draft' && <button type="button" onClick={() => { setVersionId(v.id); setVersionForm({ record: v }); }}>编辑版本</button>}
          {can('edit') && v.status!=='active' && <button type="button" className="link-button" onClick={()=>setReason({title:'请确认操作',hint:`确认启用“${v.title}”并设为默认人力成本版本吗？启用后仍可维护项目，成本变更将同步到当前引用。`,confirm:'确认',run:async()=>{await resourceApi.changeStatus('finance-labor-versions',v.id,'active');selectWrittenVersion(v.id);}})}>{v.status==='draft'?'启用版本':'恢复使用'}</button>}
          {can('edit') && v.status==='active' && v.data.isDefault!==true && <button type="button" className="link-button" onClick={()=>void run(async()=>{await resourceApi.update('finance-labor-versions',v.id,{isDefault:true});selectWrittenVersion(v.id);},'已设为默认版本')}>设为默认版本</button>}
          {can('edit') && v.status==='active' && <button type="button" className="link-button" onClick={()=>setReason({title:'请确认操作',hint:`确认停用“${v.title}”吗？其他模块将不再读取这个版本。`,confirm:'确认',run:async()=>{await resourceApi.changeStatus('finance-labor-versions',v.id,'inactive');selectWrittenVersion(v.id);}})}>停用版本</button>}
          {can('delete') && v.status==='draft' && <button type="button" className="link-button danger" onClick={()=>setReason({title:'请确认操作',hint:`确认删除版本“${v.title}”吗？版本内人力成本项目也会一并删除。`,confirm:'确认',danger:true,run:async()=>{await resourceApi.remove('finance-labor-versions',v.id,'人力成本表确认删除版本');selectWrittenVersion(null);}})}>删除版本</button>}
          </div>
        </article>)}</div>
      </section>

      {versions && versions.length === 0 && <div className="empty-state muted">还没有成本版本。先“新建成本版本”，再建归档分类和工作项目。</div>}
      <section className="labor-summary-strip" aria-label="人力成本概览">
        <div><Database size={18}/><span>当前默认版本</span><strong>{versions ? defaultVersion?.title ?? '尚未启用' : '加载中…'}</strong></div>
        <div><CalendarDays size={18}/><span>当前生效期间</span><strong>{defaultVersion ? String(defaultVersion.data.effectiveFrom || '立即') + ' 至 ' + String(defaultVersion.data.effectiveTo || '长期') : versions ? '-' : '加载中…'}</strong></div>
        <div><BriefcaseBusiness size={18}/><span>所选版本项目</span><strong>{dataReady ? items.length + ' 项' : version ? '加载中…' : '—'}</strong></div>
        <div><CircleDollarSign size={18}/><span>启用计价标准</span><strong>{dataReady ? items.filter(i => i.status === 'active').length + ' 项' : version ? '加载中…' : '—'}</strong></div>
      </section>
      <div className="labor-detail-layout">
        <aside className="labor-directory" aria-label="项目归档分类目录">
          <header><div><span>当前成本版本</span><h2>项目归档分类</h2></div>{version && !locked && (can('create') || can('edit')) && <button type="button" disabled={!dataReady} onClick={()=>setManaging(true)}><FolderTree size={14}/>管理归档</button>}</header>
          <div className="labor-directory-hint"><span>点击归档分类查看项目</span><span>末级归档可新增工作项目</span></div>
          {version && dataReady && <CategoryTree versionId={version.id} tree={tree} selected={selectedCat} onSelect={setSelectedCat}/>}
          {version && !dataReady && <p className="muted">正在读取项目归档…</p>}
        </aside>
        <section aria-label="工作项目" className="labor-project-list" aria-busy={!!version && !dataReady}>
          <header><div><h2>工作项目列表</h2><span>共 {dataReady ? filtered.length : '—'} 条</span></div>{can('create') && !locked && isLeaf && dataReady && <button type="button" className="primary-button" onClick={() => setItemForm({ record: null })}><Plus size={14}/>新增工作项目</button>}</header>
          {version ? <>
            <div className="labor-search-toolbar"><label><Search size={16}/><input aria-label="搜索工作项目" placeholder="搜索工作编码、名称、分类或单位" value={keyword} onChange={e => setKeyword(e.target.value)}/></label><span>显示 {dataReady ? filtered.length : '—'} / {dataReady ? items.length : '—'} 项</span></div>
            {version.status === 'active' && <p className="labor-version-hint">当前版本已启用，可新增和编辑；保存人力成本后，当前BOM及SKU成本表同步更新，历史记录保留。</p>}
            {locked && <p className="labor-version-hint">当前版本已停用，不可新增或修改资料。</p>}
            <div className="table-scroll"><table className="data-table labor-project-table">
              <thead><tr><th>工作编码</th><th>工作名称</th><th>项目归档分类</th><th>工作分类</th><th>计价单位</th><th className="num">单位人力成本</th><th>状态</th><th>备注</th><th>操作</th></tr></thead>
              <tbody>
                {filtered.map((i) => (
                  <tr key={i.id}><td data-label="工作编码"><strong>{String(i.data.workCode ?? '')}</strong></td><td data-label="工作名称"><strong>{String(i.data.workName ?? '')}</strong></td><td data-label="项目归档分类">{i.refLabels.archiveCategoryId}</td><td data-label="工作分类">{i.refLabels.workTypeId}</td><td data-label="计价单位">{i.refLabels.unitId}</td>
                    <td className="num" data-label="单位人力成本">{canSeeCost ? typeof i.data.unitPrice === 'number' && Number.isFinite(i.data.unitPrice) ? `¥${unitYuanText(i.data.unitPrice)}` : '未填写' : '无权限'}</td>
                    <td data-label="状态"><span className={`labor-project-status ${i.status}`}>{i.status === 'active' ? '启用' : '停用'}</span></td>
                    <td data-label="备注">{String(i.data.note || '-')}</td>
                    <td className="row-actions">{locked ? '-' : <>
                      {can('edit') && <button type="button" className="link-button" disabled={locked} onClick={() => setItemForm({ record: i })}>编辑</button>}
                      {can('create') && !locked && <button type="button" className="link-button" onClick={() => setItemForm({ record: null, initial: { __copyOf: i.id, ...Object.fromEntries(['archiveCategoryId', 'workTypeId', 'unitId', 'workName', 'unitPrice', 'note'].filter((k) => i.data[k] !== undefined && i.data[k] !== null).map((k) => [k, i.data[k]])) } })}>复制新增</button>}
                      {!locked && can('delete') && <button type="button" className="link-button danger" disabled={version.status !== 'draft'} onClick={() => setReason({ title: '请确认操作', hint: `确认删除人力成本项目“${String(i.data.workName || i.title)}”吗？`, confirm: '确认', danger: true, run: async () => { await resourceApi.remove('finance-labor-costs', i.id, '人力成本表确认删除项目'); } })}>删除</button>}
                    </>}</td></tr>
                ))}
              </tbody>
            </table></div>
            {!dataReady ? <div className="labor-list-empty">正在读取工作项目…</div> : filtered.length === 0 && <div className="labor-list-empty"><strong>{kw ? '没有匹配的工作项目' : node ? '当前归档分类暂无工作项目' : '当前版本暂无工作项目'}</strong><span>{kw ? '试试其他关键词。' : isLeaf ? '点击“新增工作项目”维护当前归档资料。' : '选择末级归档分类后可新增工作项目。'}</span></div>}
          </> : <div className="labor-list-empty"><strong>请在上方选择成本版本</strong><span>选择版本后查看对应的项目归档和工作项目。</span></div>}
        </section>
      </div>

      {managing && version && <FinanceCategoryManager key={`${scopeKey}:categories:${version.id}`} target="finance-labor-categories" context={{field:'versionId',value:version.id,label:'当前版本标识',text:String(version.data.versionCode || '-')}} presentation={{kicker:'人力成本表 · 归档设置',description:'按一级、二级、三级逐层维护，仅用于当前成本版本的项目归档和导航。',unit:'个工作项目',footer:'草稿版本可维护全部归档分类。'}} locked={locked} allowDelete={version.status==='draft'} guardDeleteReferences={false} confirmation="message" onClose={()=>setManaging(false)} onChanged={()=>void loadVersionData()}/>}
      {copying && version && <CopyVersionDialog key={`${scopeKey}:${version.id}`} source={version} onClose={() => setCopying(false)} onCopied={(id) => { if(!mounted.current || scopeRef.current!==scopeKey)return;setCopying(false); clearRefCache('finance-labor-versions'); setVersionId(id); setNotice('已复制，新版本是草稿，检查后再启用'); void loadVersions(); }} />}
      {versionForm && <RecordForm key={`${scopeKey}:version:${versionForm.record?.id ?? 'new'}`} def={getResourceDef('finance-labor-versions')!} record={versionForm.record} initial={versionForm.record ? undefined : { versionCode: `RL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}` }} onClose={() => setVersionForm(null)} onSaved={(dto) => { if(!mounted.current || scopeRef.current!==scopeKey)return;clearRefCache('finance-labor-versions'); setVersionForm(null); setVersionId(dto.id); void loadVersions(); }} />}
      {itemForm && version && <RecordForm key={`${scopeKey}:item:${version.id}:${itemForm.record?.id ?? itemForm.initial?.__copyOf ?? 'new'}`} def={getResourceDef('finance-labor-costs')!} record={itemForm.record} initial={{ versionId: version.id, ...itemForm.initial, ...(node && isLeaf && !itemForm.record && !itemForm.initial ? { archiveCategoryId: node.id } : {}) }} lockedFields={['versionId', 'archiveCategoryId']}
        onClose={() => setItemForm(null)} onSaved={() => { if(!mounted.current || scopeRef.current!==scopeKey)return;clearRefCache('finance-labor-costs'); setItemForm(null); void loadVersions(); void loadVersionData(); }} />}
      {reason && <ReasonDialog title={reason.title} hint={reason.hint} confirmLabel={reason.confirm} danger={reason.danger} requireReason={false} onClose={() => setReason(null)} onConfirm={async (r) => { await reason.run(r); if(!mounted.current || scopeRef.current!==scopeKey)return;setReason(null); if (await loadVersions()) await loadVersionData(); }} />}
    </div>
  );
}
