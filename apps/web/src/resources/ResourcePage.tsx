import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadUnitOptions, useUnitOptions } from './unitOptions';
import { PARTY_SEED_CATEGORIES, WAREHOUSE_PRODUCT_FIELDS, archivePolicyOf, dueBadgeFor, expirySources, getResourceDef, resourcePagePath, todayShanghai, treeFilterField, viewFiltersOf, createChecker, type FieldDef } from '@kudesi/shared';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError, api } from '../api/client';
import { downloadText } from './csv';
import { resourceApi, type ListResult } from './api';
import { displayValue, statusOf } from './format';
import { CategoryTree } from './CategoryTree';
import { FeeSnapshotsDialog } from './FeeSnapshotsDialog';
import { PackagingExcelDialog } from './PackagingExcelDialog';
import { ProductCostExcelDialog } from './ProductCostExcelDialog';
import { ImportDialog } from './ImportDialog';
import { TaxPendingDialog } from './TaxPendingDialog';
import { ReasonLibraryDialog } from './ReasonLibraryDialog';
import { CategorySortDialog } from './CategorySortDialog';
import { RecordDetail, useResourceCan } from './RecordDetail';
import { RecordForm } from './RecordForm';
import { InventoryDialog } from './AssetPanels';

const PAGE_SIZES = [20, 50, 100] as const;
const SORTABLE = new Set(['text', 'textarea', 'number', 'money', 'date', 'monthday', 'select']);

function useColumns(type: string, all: FieldDef[], defaults: FieldDef[]) {
  const key = `kudesi.cols.${type}`;
  const [keys, setKeys] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as string[] | null;
      if (saved?.length) return saved.filter((k) => all.some((f) => f.key === k));
    } catch {
      /* 存储不可用时用默认列 */
    }
    return defaults.map((f) => f.key);
  });
  const update = (next: string[]) => {
    setKeys(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
  };
  return [keys, update] as const;
}

/** 通用资料页：列表（搜索/分类页签/状态/分页/列设置）+ 右侧详情抽屉 + 新增/导入/导出，全部由资源定义生成。 */
export function ResourcePage({ type, lockedTab, title }: { type: string; lockedTab?: string; title?: string }) {
  const def = getResourceDef(type)!;
  const can = useResourceCan(type);
  useUnitOptions(); // 单位列表读到后，列表里的单位编码才能换成名称
  const [keyword, setKeyword] = useState('');
  const [tab, setTab] = useState(lockedTab ?? '');
  const [status, setStatus] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [archived, setArchived] = useState(false);
  const [expiring, setExpiring] = useState(false);
  const [pageSize, setPageSize] = useState<number>(20);
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' } | null>(null);
  const [filterVals, setFilterVals] = useState<Record<string, string>>({});
  const [filterOpts, setFilterOpts] = useState<Record<string, Array<{ id: number | string; label: string }>>>({});
  const treeField = useMemo(() => treeFilterField(def), [def]);
  const viewFilters = useMemo(() => viewFiltersOf(type), [type]);
  const today = useMemo(() => todayShanghai(), []);
  const filterFields = useMemo(
    () => (def.filterBy ? ([] as string[]).concat(def.filterBy as string | string[]) : []).map((k) => def.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f)),
    [def],
  );
  useEffect(() => {
    setFilterVals({});
    setFilterOpts({});
    for (const f of filterFields) {
      if (f.ref === 'user') {
        resourceApi.users().then((list) => setFilterOpts((o) => ({ ...o, [f.key]: list.map((u) => ({ id: u.id, label: u.name })) }))).catch(() => undefined);
      } else if (f.ref) {
        resourceApi.list(f.ref, { pageSize: 200, showHidden: true }).then((r) => setFilterOpts((o) => ({ ...o, [f.key]: r.items.map((i) => ({ id: i.id, label: i.title })) }))).catch(() => undefined);
      } else if (f.options) {
        setFilterOpts((o) => ({ ...o, [f.key]: f.options!.map((x) => ({ id: x.value, label: x.label })) }));
      }
    }
  }, [filterFields]);
  const [catPath, setCatPath] = useState('');
  const [page, setPage] = useState(1);
  const [checked, setChecked] = useState<number[]>([]);
  const [batchMsg, setBatchMsg] = useState('');
  const batchFields = (def.batch ?? []).filter((k) => k !== 'status').map((k) => def.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f));
  const [batchField, setBatchField] = useState('');
  const [batchValue, setBatchValue] = useState('');
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [copyInit, setCopyInit] = useState<Record<string, unknown> | null>(null);
  const [importing, setImporting] = useState(false);
  const [columnMenu, setColumnMenu] = useState(false);
  const [reasonLib, setReasonLib] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [inventory, setInventory] = useState(false);
  const [taxPending, setTaxPending] = useState(false);
  const libType = type === 'stores' ? 'store-abnormal-reasons' : type === 'phones' ? 'phone-abnormal-reasons' : '';
  const libCan = useResourceCan(libType || type);
  const catCan = useResourceCan('asset-categories');

  const shownFields = useMemo(() => def.fields.filter((f) => f.type !== 'secret'), [def]);
  const defaults = useMemo(() => def.fields.filter((f) => f.list), [def]);
  const [colKeys, setColKeys] = useColumns(type, shownFields, defaults);
  const warehouseMode = Boolean(data?.items.some((i) => i.warehouseMode));
  const columns = colKeys.map((k) => def.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f))
    .filter((f) => !warehouseMode || WAREHOUSE_PRODUCT_FIELDS.includes(f.key));
  const tabField = def.tabsBy ? def.fields.find((f) => f.key === def.tabsBy) : undefined;

  // 切换资料类型时重置筛选
  useEffect(() => {
    setKeyword('');
    setTab(lockedTab ?? '');
    setStatus('');
    setShowHidden(false);
    setPage(1);
    setSelected(null);
    setData(null);
  }, [type, lockedTab]);

  // 从别处（关联、到期提醒）带 ?open=id 跳来时，直接打开这条记录
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const open = Number(searchParams.get('open'));
    if (open > 0) {
      setSelected(open);
      setSearchParams((p) => { p.delete('open'); return p; }, { replace: true });
    }
  }, [searchParams, setSearchParams, type]);

  const load = useCallback(async () => {
    try {
      setData(await resourceApi.list(type, { page, pageSize, keyword: keyword.trim() || undefined, tab: tab || undefined, status: status || undefined, showHidden, archived, expiring, sortBy: sort?.by, sortDir: sort?.dir, filters: filterVals }));
      setError('');
      if (type === 'finance-product-units') void loadUnitOptions(true); // 单位列表变了，商品档案的下拉也要跟着变
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [type, page, keyword, tab, status, showHidden, archived, expiring, pageSize, sort, filterVals]);

  useEffect(() => { setArchived(false); setExpiring(false); setSort(null); }, [type]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200); // 输入搜索时稍作防抖
    return () => clearTimeout(t);
  }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const hiddenExists = def.statuses.some((s) => s.hidden);

  const [seeding, setSeeding] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [packagingXlOpen, setPackagingXlOpen] = useState(false);
  const [costXlOpen, setCostXlOpen] = useState(false);
  const { user: me } = useAuth();
  const costCan = createChecker(me?.permissions ?? { isCompanyAdmin: false, allow: [], deny: [] });
  async function seedFees() {
    if (!window.confirm('把旧程序里的费用类别树和费用项目（约 380 项）导入进来？已经有的编号不会重复，也不会被覆盖。')) return;
    setSeeding(true);
    setError('');
    try {
      const r = await api<{ categoriesCreated: number; itemsCreated: number }>('/finance/fee-archive/seed', { method: 'POST', body: {} });
      window.alert(`导入完成：新增费用类别 ${r.categoriesCreated} 个、费用项目 ${r.itemsCreated} 个。`);
      window.location.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '导入失败');
    } finally {
      setSeeding(false);
    }
  }

  async function seedUnits() {
    if (!window.confirm('把常用的单位、包装类别、尺寸单位、系统规格补进来？已经有的不会重复，也不会被覆盖。')) return;
    setSeeding(true);
    setError('');
    try {
      const r = await api<{ added: number }>('/resources/finance-product-units/seed-defaults', { method: 'POST', body: {} });
      window.alert(`导入完成：新增 ${r.added} 项。`);
      void loadUnitOptions(true);
      void load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '导入失败');
    } finally {
      setSeeding(false);
    }
  }

  function newInitial(): Record<string, unknown> | undefined {
    const init: Record<string, unknown> = {};
    if (tab && def.tabsBy) init[def.tabsBy] = tab;
    const cat = treeField ? Number(filterVals[treeField.key]) : 0;
    if (treeField && cat) init[treeField.key] = treeField.type === 'refs' ? [cat] : cat;
    return Object.keys(init).length ? init : undefined;
  }

  const filtered = Boolean(keyword.trim() || tab || status || archived || expiring || Object.values(filterVals).some(Boolean));
  async function doExport(scope: 'filtered' | 'all' | 'picked') {
    try {
      const out = await resourceApi.export(type, showHidden || archived, scope === 'all' ? {} : scope === 'picked'
        ? { ids: checked }
        : { keyword: keyword.trim() || undefined, tab: tab || undefined, status: status || undefined, archived, expiring, filters: filterVals, sortBy: sort?.by, sortDir: sort?.dir });
      downloadText(out.filename, out.csv);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '导出失败');
    }
  }

  return (
    <div className="split">
      <section className="split-main">
        <div className="page-head">
          <h1>{title ?? def.label}</h1>
          <div className="pill-row">
            {type === 'finance-products' && costCan('product.cost.view') && costCan('resource.finance-product-costs.view') && <button type="button" className="secondary-button" onClick={() => setCostXlOpen(true)}>成本 Excel</button>}
            {type === 'finance-packaging-schemes' && <button type="button" className="secondary-button" onClick={() => setPackagingXlOpen(true)}>Excel 导入导出</button>}
            {type === 'finance-product-units' && can('create') && <button type="button" className="secondary-button" disabled={seeding} onClick={seedUnits}>{seeding ? '导入中…' : '导入默认项'}</button>}
            {type === 'finance-fee-items' && can('create') && <button type="button" className="secondary-button" disabled={seeding} onClick={seedFees}>{seeding ? '导入中…' : '导入默认费用档案'}</button>}
            {type === 'finance-fee-items' && <button type="button" className="secondary-button" onClick={() => setSnapshotsOpen(true)}>费用存档表</button>}
            {(type === 'finance-supplier-categories' || type === 'finance-customer-categories') && can('create') && (
              <button type="button" className="secondary-button" onClick={async () => {
                try {
                  const have = new Set((await resourceApi.list(type, { pageSize: 200, showHidden: true })).items.map((i) => i.title));
                  let n = 0;
                  for (const [name, subtitle] of PARTY_SEED_CATEGORIES[type]) if (!have.has(name)) { await resourceApi.create(type, { name, subtitle }); n++; }
                  setBatchMsg(n ? `已导入 ${n} 个默认分类` : '默认分类都已经有了');
                  void load();
                } catch (e) { setBatchMsg(e instanceof ApiError ? e.message : '导入失败'); }
              }}>导入默认分类</button>
            )}
            {type === 'fixed-assets' && catCan('view') && resourcePagePath('asset-categories') && <Link className="secondary-button" to={resourcePagePath('asset-categories')!}>分类管理</Link>}
            {type === 'fixed-assets' && can('edit') && <button type="button" className="secondary-button" onClick={() => setInventory(true)}>盘点</button>}
            {type === 'tax-profiles' && can('create') && <button type="button" className="secondary-button" onClick={() => setTaxPending(true)}>待生成</button>}
            {libType && libCan('view') && <button type="button" className="secondary-button" onClick={() => setReasonLib(true)}>异常原因库</button>}
            {type === 'finance-categories' && tab && can('edit') && <button type="button" className="secondary-button" onClick={() => setSorting(true)}>调整顺序</button>}
            {can('import') && <button type="button" className="secondary-button" onClick={() => setImporting(true)}>导入</button>}
            {can('export') && <button type="button" className="secondary-button" onClick={() => void doExport('filtered')}>{filtered ? '导出当前筛选' : '导出'}</button>}
            {can('export') && filtered && <button type="button" className="secondary-button" onClick={() => void doExport('all')}>导出全部</button>}
            {can('export') && checked.length > 0 && <button type="button" className="secondary-button" onClick={() => void doExport('picked')}>导出所选 {checked.length}</button>}
            {can('create') && <button type="button" className="primary-button" onClick={() => setCreating(true)}>＋ 新增</button>}
          </div>
        </div>
        <div className={treeField ? 'tree-layout' : undefined}>
        {treeField && (
          <CategoryTree
            type={type}
            field={treeField.key}
            tab={tab}
            status={status}
            showHidden={showHidden}
            value={filterVals[treeField.key] ?? ''}
            reloadKey={data?.total}
            onPath={setCatPath}
            onSelect={(id) => { setFilterVals((v) => ({ ...v, [treeField.key]: id })); setPage(1); }}
          />
        )}
        <div className="card">
          {tabField && !lockedTab && (
            <div className="tab-group page-tabs" role="tablist" aria-label="分类">
              <button type="button" role="tab" aria-selected={tab === ''} className={tab === '' ? 'chip active' : 'chip'} onClick={() => { setTab(''); setPage(1); if (treeField) setFilterVals((v) => ({ ...v, [treeField.key]: '' })); }}>全部</button>
              {tabField.options?.map((o) => (
                <button key={o.value} type="button" role="tab" aria-selected={tab === o.value} className={tab === o.value ? 'chip active' : 'chip'} onClick={() => { setTab(o.value); setPage(1); if (treeField) setFilterVals((v) => ({ ...v, [treeField.key]: '' })); }}>
                  {o.label}{data?.tabCounts ? ` ${data.tabCounts[o.value] ?? 0}` : ''}
                </button>
              ))}
            </div>
          )}
          <div className="toolbar">
            <input className="grow" placeholder="搜索（多个词用空格隔开）" aria-label="搜索" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
            {filterFields.filter((ff) => ff.key !== treeField?.key).map((ff) => (
              <select key={ff.key} aria-label={ff.label} value={filterVals[ff.key] ?? ''} onChange={(e) => { setFilterVals((v) => ({ ...v, [ff.key]: e.target.value })); setPage(1); }}>
                <option value="">{ff.label}：全部</option>
                {(filterOpts[ff.key] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            ))}
            {viewFilters.map((vf) => (
              <select key={vf.key} aria-label={vf.label} value={filterVals[vf.key] ?? ''} onChange={(e) => { setFilterVals((v) => ({ ...v, [vf.key]: e.target.value })); setPage(1); }}>
                <option value="">{vf.label}：全部</option>
                {vf.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ))}
            <select aria-label="状态" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">状态：全部</option>
              {def.statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            {expirySources().some((x) => x.resource === type) && (
              <button type="button" className={expiring ? 'secondary-button active' : 'secondary-button'} aria-pressed={expiring} onClick={() => { setExpiring((v) => !v); setPage(1); }}>
                即将到期
              </button>
            )}
            {archivePolicyOf(type) && (
              <button type="button" className={archived ? 'secondary-button active' : 'secondary-button'} aria-pressed={archived} onClick={() => { setArchived((v) => !v); setPage(1); }}>
                已归档{data?.archivedCount !== undefined ? ` ${data.archivedCount}` : ''}
              </button>
            )}
            {hiddenExists && !status && !archived && (
              <label className="check"><input type="checkbox" checked={showHidden} onChange={(e) => { setShowHidden(e.target.checked); setPage(1); }} /> 显示{def.statuses.filter((s) => s.hidden).map((s) => s.label).join('/')}</label>
            )}
            <div className="menu-wrap">
              <button type="button" className="secondary-button" aria-expanded={columnMenu} onClick={() => setColumnMenu((v) => !v)}>显示列</button>
              {columnMenu && (
                <div className="menu card" role="menu">
                  {shownFields.map((f) => (
                    <label key={f.key} className="check">
                      <input
                        type="checkbox"
                        checked={colKeys.includes(f.key)}
                        onChange={(e) => setColKeys(e.target.checked ? [...colKeys, f.key] : colKeys.filter((k) => k !== f.key))}
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
          {catPath && <div className="muted" style={{ padding: '6px 12px' }}>当前分类：{catPath}（含下级分类）</div>}
          {error && <div role="alert" className="notice error m">{error}</div>}
          {def.batch && checked.length > 0 && (
            <div className="toolbar" role="group" aria-label="批量操作">
              <span>已勾选 {checked.length} 条</span>
              {can('edit') && batchFields.length > 0 && (
                <>
                  <select aria-label="批量修改字段" value={batchField} onChange={(e) => { setBatchField(e.target.value); setBatchValue(''); }}>
                    <option value="">批量修改…</option>
                    {batchFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                  {batchField && (
                    <select aria-label="新的值" value={batchValue} onChange={(e) => setBatchValue(e.target.value)}>
                      <option value="">选择新的值</option>
                      {(filterOpts[batchField] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  )}
                  <button type="button" className="secondary-button" disabled={!batchField || !batchValue} onClick={async () => {
                    const f = def.fields.find((x) => x.key === batchField);
                    try {
                      const r = await resourceApi.batch(type, checked, { [batchField]: f?.type === 'refs' ? [Number(batchValue)] : f?.ref ? Number(batchValue) : batchValue });
                      setBatchMsg(`已修改 ${r.done} 条${r.failed.length ? `，${r.failed.length} 条失败：${r.failed.slice(0, 3).map((x) => `#${x.id} ${x.message}`).join('；')}` : ''}`);
                      setChecked([]); void load();
                    } catch (e) { setBatchMsg(e instanceof ApiError ? e.message : '批量修改失败'); }
                  }}>应用</button>
                </>
              )}
              {can('disable') && def.batch.includes('status') && def.statuses.filter((s) => s.value !== 'deleted').slice(0, 4).map((s) => (
                <button key={s.value} type="button" className="secondary-button" onClick={async () => {
                  const reason = s.requiresReason ? window.prompt(`批量改为“${s.label}”的原因`) : undefined;
                  if (s.requiresReason && !reason) return;
                  try {
                    const r = await resourceApi.batchStatus(type, checked, s.value, reason ?? undefined);
                    setBatchMsg(`已改为${s.label} ${r.done} 条${r.failed.length ? `，${r.failed.length} 条失败：${r.failed.slice(0, 3).map((x) => `#${x.id} ${x.message}`).join('；')}` : ''}`);
                    setChecked([]); void load();
                  } catch (e) { setBatchMsg(e instanceof ApiError ? e.message : '批量改状态失败'); }
                }}>批量{s.label}</button>
              ))}
              <button type="button" className="secondary-button" onClick={() => setChecked([])}>取消勾选</button>
            </div>
          )}
          {batchMsg && <div role="status" className="notice m">{batchMsg}</div>}
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  {def.batch && <th style={{ width: 32 }}><input type="checkbox" aria-label="本页全选" checked={!!data?.items.length && data.items.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...(data?.items.map((r) => r.id) ?? [])])] : checked.filter((id) => !data?.items.some((r) => r.id === id)))} /></th>}
                  {columns.map((f) => SORTABLE.has(f.type) ? (
                    <th key={f.key} aria-sort={sort?.by === f.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" className="link-button" title="点击排序" onClick={() => { setSort(sort?.by === f.key ? (sort.dir === 'desc' ? { by: f.key, dir: 'asc' } : null) : { by: f.key, dir: 'desc' }); setPage(1); }}>
                        {f.label}{sort?.by === f.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                    </th>
                  ) : <th key={f.key}>{f.label}</th>)}
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((row) => {
                  const st = statusOf(def, row.status);
                  return (
                    <tr
                      key={row.id}
                      className={row.id === selected ? 'selected' : undefined}
                      tabIndex={0}
                      aria-selected={row.id === selected}
                      onClick={() => setSelected(row.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelected(row.id);
                        }
                      }}
                    >
                      {def.batch && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`勾选 ${row.title}`} checked={checked.includes(row.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, row.id] : checked.filter((id) => id !== row.id))} /></td>}
                      {columns.map((f) => {
                        const due = dueBadgeFor(type, f.key, row.data, row.status, today);
                        return (
                          <td key={f.key} className={f.type === 'money' ? 'num' : undefined}>
                            {displayValue(f, row)}
                            {due && <> <span className={`pill ${due.level === 'expired' ? 'bad' : 'warn'}`} title="到期提醒按今天的日期实时计算">{due.text}</span></>}
                          </td>
                        );
                      })}
                      <td><span className={`pill ${st.tone === 'muted' ? 'warn' : st.tone}`}>{st.label}</span></td>
                    </tr>
                  );
                })}
                {data && data.items.length === 0 && (
                  <tr><td colSpan={columns.length + 2} className="muted center">没有匹配的{def.label}</td></tr>
                )}
                {!data && !error && <tr><td colSpan={columns.length + 2} className="muted center">加载中…</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card-foot between">
            <span>共 {data?.total ?? 0} 条 · 点击一行在右侧查看，不跳转页面</span>
            <span className="pill-row">
              <select aria-label="每页条数" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {PAGE_SIZES.map((n) => <option key={n} value={n}>每页 {n} 条</option>)}
              </select>
              <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <span>{page} / {totalPages}</span>
              <button type="button" className="secondary-button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
            </span>
          </div>
        </div>
        </div>
      </section>

      {costXlOpen && <ProductCostExcelDialog canImport={costCan('product.cost.edit') && costCan('resource.finance-product-costs.create')} onClose={() => setCostXlOpen(false)} onDone={() => void load()} />}
      {packagingXlOpen && <PackagingExcelDialog canCreate={can('create')} onClose={() => setPackagingXlOpen(false)} onDone={() => void load()} />}
      {snapshotsOpen && <FeeSnapshotsDialog canWrite={can('create')} canDelete={can('delete')} onClose={() => setSnapshotsOpen(false)} onRestored={() => void load()} />}
      {selected !== null && <RecordDetail def={def} id={selected} onClose={() => setSelected(null)} onChanged={() => void load()} onCopy={can('create') ? (v) => { setCopyInit(v); setSelected(null); setCreating(true); } : undefined} />}

      {creating && (
        <RecordForm
          def={def}
          record={null}
          initial={copyInit ?? newInitial()}
          onClose={() => { setCreating(false); setCopyInit(null); }}
          onContinued={() => void load()}
          onSaved={(dto) => {
            setCreating(false);
            setCopyInit(null);
            setSelected(dto.id);
            void load();
          }}
        />
      )}
      {inventory && <InventoryDialog onClose={() => setInventory(false)} onDone={(m) => { setInventory(false); setBatchMsg(m); void load(); }} />}
      {taxPending && <TaxPendingDialog onClose={() => setTaxPending(false)} onCreated={() => void load()} />}
      {sorting && tab && <CategorySortDialog archiveType={tab} onClose={() => setSorting(false)} onDone={() => void load()} />}
      {reasonLib && libType && <ReasonLibraryDialog libType={libType} title={type === 'stores' ? '店铺异常原因库' : '手机号异常原因库'} onClose={() => setReasonLib(false)} />}
      {importing && (
        <ImportDialog
          def={def}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
