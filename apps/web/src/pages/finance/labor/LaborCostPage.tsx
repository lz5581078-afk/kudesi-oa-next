import { useCallback, useEffect, useMemo, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { ReasonDialog, RecordForm, clearRefCache } from '../../../resources/RecordForm';
import { useResourceCan } from '../../../resources/RecordDetail';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { Pager, money } from '../common';
import { CategoryTree, buildCategoryTree, findNode, subtreeIds } from './CategoryTree';
import { CopyVersionDialog } from './CopyVersionDialog';
import { DictionaryDialog } from './DictionaryDialog';

const PAGE_SIZE = 20;
const VERSION_STATUS: Record<string, string> = { draft: '草稿', active: '已启用', inactive: '已停用' };
const err = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

/** 人力成本表：成本版本 → 项目归档分类树 → 工作项目；工作分类和计价单位可自己维护。 */
export function LaborCostPage() {
  const can = useResourceCan('finance-labor-costs');
  const { can: has } = useAuth();
  const canSeeCost = has('product.cost.view');
  const [versions, setVersions] = useState<ResourceDto[] | null>(null);
  const [versionId, setVersionId] = useState<number | null>(null);
  const [cats, setCats] = useState<ResourceDto[]>([]);
  const [items, setItems] = useState<ResourceDto[]>([]);
  const [selectedCat, setSelectedCat] = useState<number | null>(null);
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'workTypes' | 'units' | null>(null);
  const [copying, setCopying] = useState(false);
  const [versionForm, setVersionForm] = useState<{ record: ResourceDto | null } | null>(null);
  const [itemForm, setItemForm] = useState<{ record: ResourceDto | null } | null>(null);
  const [reason, setReason] = useState<{ title: string; hint?: string; confirm: string; run: (reason: string) => Promise<void> } | null>(null);

  const loadVersions = useCallback(async () => {
    try {
      const r = await resourceApi.list('finance-labor-versions', { pageSize: 200, showHidden: true });
      setVersions(r.items);
      setVersionId((cur) => cur ?? r.items.find((v) => v.data.isDefault === true)?.id ?? r.items.find((v) => v.status === 'active')?.id ?? r.items[0]?.id ?? null);
      setError('');
    } catch (e) { setError(err(e)); }
  }, []);
  useEffect(() => { void loadVersions(); }, [loadVersions]);

  const loadVersionData = useCallback(async () => {
    if (versionId === null) { setCats([]); setItems([]); return; }
    try {
      const all = async (type: string) => {
        const out: ResourceDto[] = [];
        for (let p = 1; p <= 10; p++) {
          const r = await resourceApi.list(type, { fieldKey: 'versionId', fieldValue: versionId, pageSize: 200, page: p, showHidden: true });
          out.push(...r.items);
          if (out.length >= r.total) break;
        }
        return out;
      };
      const [c, i] = await Promise.all([all('finance-labor-categories'), all('finance-labor-costs')]);
      setCats(c); setItems(i); setError('');
    } catch (e) { setError(err(e)); }
  }, [versionId]);
  useEffect(() => { setSelectedCat(null); setPage(1); void loadVersionData(); }, [loadVersionData]);

  const version = versions?.find((v) => v.id === versionId) ?? null;
  const tree = useMemo(() => buildCategoryTree(cats, items.map((i) => (typeof i.data.archiveCategoryId === 'number' ? i.data.archiveCategoryId : null))), [cats, items]);
  const node = findNode(tree, selectedCat);
  const scope = node ? new Set(subtreeIds(node)) : null;
  const kw = keyword.trim().toLowerCase();
  const filtered = items.filter((i) => (!scope || scope.has(Number(i.data.archiveCategoryId))) && (!kw || `${i.title} ${String(i.data.workCode ?? '')} ${String(i.data.workName ?? '')}`.toLowerCase().includes(kw)));
  const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const isLeaf = node ? node.children.length === 0 : false;

  async function run(fn: () => Promise<unknown>, done?: string) {
    setError(''); setNotice('');
    try { await fn(); if (done) setNotice(done); await loadVersions(); await loadVersionData(); } catch (e) { setError(err(e)); }
  }
  const locked = version?.status === 'inactive';

  return (
    <div>
      <div className="page-head between">
        <h1>人力成本表</h1>
        <div className="toolbar">
          {can('create') && <button type="button" className="secondary-button" onClick={() => setVersionForm({ record: null })}>新增成本版本</button>}
          {can('create') && <button type="button" className="secondary-button" onClick={() => setDialog('workTypes')}>维护工作分类</button>}
          {can('create') && <button type="button" className="secondary-button" onClick={() => setDialog('units')}>维护计价单位</button>}
        </div>
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {notice && <div role="status" className="notice ok">{notice}</div>}

      {versions && versions.length === 0 && <div className="empty-state muted">还没有成本版本。先“新增成本版本”，再建归档分类和工作项目。</div>}
      {version && (
        <div className="card">
          <div className="toolbar">
            <label>成本版本 <select aria-label="成本版本" value={versionId ?? ''} onChange={(e) => setVersionId(Number(e.target.value))}>
              {(versions ?? []).map((v) => <option key={v.id} value={v.id}>{v.title}（{VERSION_STATUS[v.status] ?? v.status}{v.data.isDefault === true ? '，默认' : ''}）</option>)}</select></label>
            <span className={version.status === 'active' ? 'chip ok' : 'chip muted'}>{VERSION_STATUS[version.status]}</span>
            {version.data.isDefault === true && <span className="chip active">默认版本</span>}
            <span className="muted">编号 {String(version.data.versionCode)} · 适用 {String(version.data.effectiveFrom ?? '不限')} ~ {String(version.data.effectiveTo ?? '长期')}{version.data.periodName ? ` · ${String(version.data.periodName)}` : ''}</span>
          </div>
          {can('edit') && (
            <div className="toolbar">
              <button type="button" className="secondary-button small" onClick={() => setVersionForm({ record: version })}>修改版本信息</button>
              {can('create') && <button type="button" className="secondary-button small" onClick={() => setCopying(true)}>复制版本</button>}
              {version.status !== 'active' && <button type="button" className="secondary-button small" onClick={() => void run(() => resourceApi.changeStatus('finance-labor-versions', version.id, 'active'), '版本已启用，现在可以被成品构成、组合使用')}>{version.status === 'draft' ? '启用版本' : '重新启用'}</button>}
              {version.status === 'active' && version.data.isDefault !== true && <button type="button" className="secondary-button small" onClick={() => void run(() => resourceApi.update('finance-labor-versions', version.id, { isDefault: true }), '已设为默认版本')}>设为默认版本</button>}
              {version.status === 'active' && <button type="button" className="secondary-button small danger" onClick={() => setReason({ title: `停用成本版本「${version.title}」`, hint: '停用后不能再新增项目、改价，也不能被新的构成选用；已在用的构成不受影响。', confirm: '确认停用', run: async (r) => { await resourceApi.changeStatus('finance-labor-versions', version.id, 'inactive', r); } })}>停用版本</button>}
              {can('delete') && <button type="button" className="secondary-button small danger" onClick={() => setReason({ title: `删除成本版本「${version.title}」`, hint: '版本下还有分类或项目时不能删除。', confirm: '确认删除', run: async (r) => { await resourceApi.remove('finance-labor-versions', version.id, r); setVersionId(null); } })}>删除版本</button>}
            </div>
          )}
          {version.status === 'draft' && <p className="muted">草稿版本里的项目还不能被成品构成、组合选用，启用后才可以。</p>}
          {locked && <p className="muted">这个版本已停用，只能查看。</p>}
        </div>
      )}

      {version && (
        <div className="split-layout" style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 300px) 1fr', gap: 16, alignItems: 'start' }}>
          <CategoryTree versionId={version.id} versionLocked={locked} cats={cats} tree={tree} selected={selectedCat} canEdit={can('create') || can('edit')} canDelete={can('delete')} total={items.length}
            onSelect={(id) => { setSelectedCat(id); setPage(1); }} onChanged={() => void loadVersionData()} />
          <section aria-label="工作项目">
            <div className="toolbar">
              <input aria-label="搜索工作项目" placeholder="搜索工作名称或编号" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
              {can('create') && <button type="button" className="primary-button" disabled={locked || (node !== null && !isLeaf)} title={node && !isLeaf ? '请选最末级分类' : undefined} onClick={() => setItemForm({ record: null })}>新增工作项目</button>}
              {node && !isLeaf && <span className="muted">「{node.name}」还有下级分类，工作项目要放在最末级</span>}
            </div>
            <div className="table-scroll"><table className="data-table">
              <thead><tr><th>工作编号</th><th>归档分类</th><th>工作分类</th><th>工作名称</th><th>计价单位</th><th className="num">单位人力成本</th><th>零值原因</th><th>状态</th><th /></tr></thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={9} className="empty-state muted">{items.length === 0 ? '这个版本还没有工作项目。' : '没有符合条件的工作项目。'}</td></tr>}
                {shown.map((i) => (
                  <tr key={i.id}><td>{String(i.data.workCode ?? '')}</td><td>{i.refLabels.archiveCategoryId}</td><td>{i.refLabels.workTypeId}</td><td>{String(i.data.workName ?? '')}</td><td>{i.refLabels.unitId}</td>
                    <td className="num">{canSeeCost ? money(i.data.unitPrice as number | undefined) : '无权限'}</td><td>{String(i.data.zeroReason ?? '')}</td>
                    <td>{i.status === 'active' ? '启用' : '停用'}</td>
                    <td className="row-actions">
                      {can('edit') && <button type="button" className="link-button" onClick={() => setItemForm({ record: i })}>修改</button>}
                      {can('disable') && (i.status === 'active'
                        ? <button type="button" className="link-button" onClick={() => setReason({ title: `停用「${i.title}」`, hint: '被成品构成或组合用着的项目不能停用。', confirm: '确认停用', run: async (r) => { await resourceApi.changeStatus('finance-labor-costs', i.id, 'inactive', r); } })}>停用</button>
                        : <button type="button" className="link-button" onClick={() => void run(() => resourceApi.changeStatus('finance-labor-costs', i.id, 'active'))}>启用</button>)}
                      {can('delete') && <button type="button" className="link-button danger" onClick={() => setReason({ title: `删除「${i.title}」`, hint: '被成品构成或组合用着的项目不能删除，请改成停用。', confirm: '确认删除', run: async (r) => { await resourceApi.remove('finance-labor-costs', i.id, r); } })}>删除</button>}
                    </td></tr>
                ))}
              </tbody>
            </table></div>
            {filtered.length > PAGE_SIZE && <Pager page={page} total={filtered.length} pageSize={PAGE_SIZE} onPage={setPage} />}
            <p className="muted">单位人力成本填 0 时必须写明零值原因；已被成品构成或组合使用的项目，不能换版本、换计价单位、停用或删除。</p>
          </section>
        </div>
      )}

      {dialog === 'workTypes' && <DictionaryDialog type="finance-labor-work-types" title="维护工作分类" hint="工作分类如“包装、分拣、生产加工”，会参与工作编号。已经被工作项目使用的不能删除。" onClose={() => { setDialog(null); void loadVersionData(); }} />}
      {dialog === 'units' && <DictionaryDialog type="finance-labor-units" title="维护计价单位" hint="计价单位如“元/袋、元/小时”。已经被工作项目使用的不能删除。" onClose={() => { setDialog(null); void loadVersionData(); }} />}
      {copying && version && <CopyVersionDialog source={version} onClose={() => setCopying(false)} onCopied={(id) => { setCopying(false); clearRefCache('finance-labor-versions'); setVersionId(id); setNotice('已复制，新版本是草稿，检查后再启用'); void loadVersions(); }} />}
      {versionForm && <RecordForm def={getResourceDef('finance-labor-versions')!} record={versionForm.record} onClose={() => setVersionForm(null)} onSaved={(dto) => { clearRefCache('finance-labor-versions'); setVersionForm(null); setVersionId(dto.id); void loadVersions(); }} />}
      {itemForm && version && <RecordForm def={getResourceDef('finance-labor-costs')!} record={itemForm.record} initial={{ versionId: version.id, ...(node && isLeaf && !itemForm.record ? { archiveCategoryId: node.id } : {}) }} lockedFields={itemForm.record ? undefined : ['versionId']}
        onClose={() => setItemForm(null)} onSaved={() => { clearRefCache('finance-labor-costs'); setItemForm(null); void loadVersionData(); }} />}
      {reason && <ReasonDialog title={reason.title} hint={reason.hint} confirmLabel={reason.confirm} danger onClose={() => setReason(null)} onConfirm={async (r) => { await reason.run(r); setReason(null); await loadVersions(); await loadVersionData(); }} />}
    </div>
  );
}
