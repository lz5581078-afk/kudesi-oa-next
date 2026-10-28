import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadUnitOptions, useUnitOptions } from './unitOptions';
import { BatchBar } from './BatchBar';
import { resourceDescription, PARTY_SEED_CATEGORIES, WAREHOUSE_PRODUCT_FIELDS, archivePolicyOf, dueBadgeFor, expirySources, getResourceDef, hasFeeDefaults, resourceTabInitial, resourceTabOptions, resourcePagePath, todayShanghai, treeFilterField, viewFiltersOf, createChecker, gridPolicyOf, type FieldDef } from '@kudesi/shared';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError, api } from '../api/client';
import { downloadText } from './csv';
import { resourceApi, type ListResult } from './api';
import { displayValue, statusOf } from './format';
import { CopyButton, isCopyable } from './CopyValue';
import { CategoryTree } from './CategoryTree';
import { FeeSnapshotsDialog } from './FeeSnapshotsDialog';
import { PackagingExcelDialog } from './PackagingExcelDialog';
import { ProductCostExcelDialog } from './ProductCostExcelDialog';
import { ImportDialog } from './ImportDialog';
import { TaxPendingButton } from './TaxPendingDialog';
import { ReasonLibraryDialog } from './ReasonLibraryDialog';
import { CategorySortDialog } from './CategorySortDialog';
import { RecordDetail, useResourceCan } from './RecordDetail';
import { RecordForm } from './RecordForm';
import { ArchiveTypeDialog } from './ArchiveTypeDialog';
import { InventoryDialog } from './AssetPanels';
import { ResourceGrid } from './grid/ResourceGrid';
import { useWideScreen } from './grid/useWideScreen';

const PAGE_SIZES = [20, 50, 100, 200] as const;
const SORTABLE = new Set(['text', 'textarea', 'number', 'money', 'date', 'monthday', 'select']);

type ListPrefs = { pageSize?: number; status?: string; filters?: Record<string, string> };
const prefsKey = (type: string) => `kudesi.list.${type}`;
function readPrefs(type: string): ListPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(prefsKey(type)) ?? 'null') as ListPrefs | null;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function writePrefs(type: string, patch: ListPrefs) {
  try {
    localStorage.setItem(prefsKey(type), JSON.stringify({ ...readPrefs(type), ...patch }));
  } catch {
    /* 存储不可用时只是不记住 */
  }
}

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
  const unitOpts = useUnitOptions(); // 单位列表读到后，列表里的单位编码才能换成名称
  const [keyword, setKeyword] = useState('');
  const [tab, setTab] = useState(lockedTab ?? '');
  const [status, setStatus] = useState(() => readPrefs(type).status ?? '');
  const [showHidden, setShowHidden] = useState(false);
  const [archived, setArchived] = useState(false);
  const [expiring, setExpiring] = useState(false);
  const [pageSize, setPageSize] = useState<number>(() => { const n = readPrefs(type).pageSize; return n && (PAGE_SIZES as readonly number[]).includes(n) ? n : 20; });
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' } | null>(null);
  const [filterVals, setFilterVals] = useState<Record<string, string>>(() => readPrefs(type).filters ?? {});
  const [filterOpts, setFilterOpts] = useState<Record<string, Array<{ id: number | string; label: string }>>>({});
  const treeField = useMemo(() => treeFilterField(def), [def]);
  const viewFilters = useMemo(() => viewFiltersOf(type), [type]);
  // 选项由服务端按公司生成的筛选（如 部门）
  const [deptOpts, setDeptOpts] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    if (!viewFilters.some((v) => v.optionsFrom === 'departments')) return;
    resourceApi.departments().then((l) => setDeptOpts(l.map((d) => ({ value: String(d.id), label: d.name })))).catch(() => setDeptOpts([]));
  }, [viewFilters]);
  const today = useMemo(() => todayShanghai(), []);
  const filterFields = useMemo(
    () => (def.filterBy ? ([] as string[]).concat(def.filterBy as string | string[]) : []).map((k) => def.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f)),
    [def],
  );
  useEffect(() => {
    setFilterVals(readPrefs(type).filters ?? {});
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
  }, [filterFields]); // eslint-disable-line react-hooks/exhaustive-deps
  const [catPath, setCatPath] = useState('');
  const [page, setPage] = useState(1);
  const [checked, setChecked] = useState<number[]>([]);
  const [batchMsg, setBatchMsg] = useState('');
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
  const libType = type === 'stores' ? 'store-abnormal-reasons' : type === 'phones' ? 'phone-abnormal-reasons' : '';
  const libCan = useResourceCan(libType || type);
  const catCan = useResourceCan('asset-categories');

  // 派生列（配置 derivedColumns）：按页现算的数字，当作只读列显示，服务端可排序、可导出
  const derivedFields = useMemo<FieldDef[]>(() => (def.derivedColumns ?? []).map((d) => ({ key: d.key, label: d.label, type: d.kind === 'sum' && d.format === 'money' ? 'money' : 'number', group: '统计', readonly: true, list: d.list !== false })), [def]);
  const derivedKeys = useMemo(() => new Set(derivedFields.map((f) => f.key)), [derivedFields]);
  const shownFields = useMemo(() => [...def.fields.filter((f) => f.type !== 'secret'), ...derivedFields], [def, derivedFields]);
  const defaults = useMemo(() => [...def.fields.filter((f) => f.list), ...derivedFields.filter((f) => f.list)], [def, derivedFields]);
  const [colKeys, setColKeys] = useColumns(type, shownFields, defaults);
  const warehouseMode = Boolean(data?.items.some((i) => i.warehouseMode));
  const columns = colKeys.map((k) => shownFields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f))
    .filter((f) => !warehouseMode || WAREHOUSE_PRODUCT_FIELDS.includes(f.key));
  const tabField = def.tabsBy ? def.fields.find((f) => f.key === def.tabsBy) : undefined;

  // 切换资料类型时重置筛选
  useEffect(() => {
    setKeyword('');
    setTab(lockedTab ?? '');
    setStatus(readPrefs(type).status ?? '');
    const n = readPrefs(type).pageSize;
    setPageSize(n && (PAGE_SIZES as readonly number[]).includes(n) ? n : 20);
    setShowHidden(false);
    setPage(1);
    setSelected(null);
    setData(null);
  }, [type, lockedTab]);

  // 记住筛选、状态和每页条数（按资料类型）；分类目录的选择不记
  useEffect(() => {
    const keep = Object.fromEntries(Object.entries(filterVals).filter(([k, v]) => v && k !== treeField?.key));
    writePrefs(type, { pageSize, status, filters: keep });
  }, [filterVals, status, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  // 记住的筛选项如果已经不存在（选项被删/改名），会让列表莫名其妙是空的，加载到选项后清掉它
  useEffect(() => {
    setFilterVals((cur) => {
      const stale = Object.entries(cur).filter(([k, v]) => {
        if (!v || k === treeField?.key) return false;
        const opts = filterOpts[k] ?? viewFilters.find((x) => x.key === k)?.options?.map((o) => ({ id: o.value }));
        return Boolean(opts && opts.length && !opts.some((o) => String(o.id) === String(v)));
      }).map(([k]) => k);
      if (!stale.length) return cur;
      return Object.fromEntries(Object.entries(cur).filter(([k]) => !stale.includes(k)));
    });
  }, [filterOpts]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // 表格编辑模式（电脑宽屏、有编辑权限、该资料适合网格时才有）；有未保存改动时锁住筛选/翻页，免得换了数据丢改动
  const wide = useWideScreen();
  const [gridMode, setGridMode] = useState(false);
  const [gridDirty, setGridDirty] = useState(false);
  const prevPageSize = useRef(pageSize);
  const gridAllowed = wide && can('edit') && gridPolicyOf(type).enabled && !warehouseMode && !archived;
  const gridOn = gridMode && gridAllowed;
  useEffect(() => { setGridMode(false); setGridDirty(false); }, [type]);
  function enterGrid() {
    prevPageSize.current = pageSize;
    setPageSize(200);
    setPage(1);
    setSelected(null);
    setChecked([]);
    setGridMode(true);
  }
  function leaveGrid() {
    setGridMode(false);
    setGridDirty(false);
    setPageSize(prevPageSize.current);
    setPage(1);
  }
  const gridLocked = gridOn && gridDirty;

  const [seeding, setSeeding] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [packagingXlOpen, setPackagingXlOpen] = useState(false);
  const [costXlOpen, setCostXlOpen] = useState(false);
  const [archiveTypesOpen, setArchiveTypesOpen] = useState(false);
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
    if (tab && def.tabsBy) Object.assign(init, resourceTabInitial(def, tab));
    const cat = treeField ? Number(filterVals[treeField.key]) : 0;
    if (treeField && cat) init[treeField.key] = treeField.type === 'refs' ? [cat] : cat;
    return Object.keys(init).length ? init : undefined;
  }

  const filtered = Boolean(keyword.trim() || tab || status || archived || expiring || Object.values(filterVals).some(Boolean));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = Object.entries(filterVals).filter(([k, v]) => v && k !== treeField?.key).length + (status ? 1 : 0);
  function clearFilters() {
    setKeyword(''); setStatus(''); setArchived(false); setExpiring(false); setFilterVals({}); setTab(lockedTab ?? ''); setPage(1);
  }
  async function doExport(scope: 'filtered' | 'all' | 'picked') {
    try {
      const cols = colKeys.filter((k) => derivedKeys.has(k));
      const out = await resourceApi.export(type, showHidden || archived, scope === 'all' ? { cols } : scope === 'picked'
        ? { ids: checked, cols }
        : { cols, keyword: keyword.trim() || undefined, tab: tab || undefined, status: status || undefined, archived, expiring, filters: filterVals, sortBy: sort?.by, sortDir: sort?.dir });
      downloadText(out.filename, out.csv);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '导出失败');
    }
  }

  return (
    <div className="split">
      <section className="split-main">
        <div className="page-head">
          <div><h1>{title ?? def.label}</h1>{resourceDescription(type) && !lockedTab && <p className="muted page-desc">{resourceDescription(type)}</p>}</div>
          <div className="pill-row">
            {type === 'finance-products' && costCan('product.cost.view') && costCan('resource.finance-product-costs.view') && <button type="button" className="secondary-button" onClick={() => setCostXlOpen(true)}>成本 Excel</button>}
            {type === 'finance-packaging-schemes' && <button type="button" className="secondary-button" onClick={() => setPackagingXlOpen(true)}>Excel 导入导出</button>}
            {type === 'finance-products' && can('edit') && <button type="button" className="secondary-button" onClick={() => setArchiveTypesOpen(true)}>管理档案类型</button>}
            {type === 'finance-product-units' && can('create') && <button type="button" className="secondary-button" disabled={seeding} onClick={seedUnits}>{seeding ? '导入中…' : '导入默认项'}</button>}
            {type === 'finance-fee-items' && can('create') && hasFeeDefaults(me?.companyName) && <button type="button" className="secondary-button" disabled={seeding} onClick={seedFees}>{seeding ? '导入中…' : '导入默认费用档案'}</button>}
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
            {type === 'tax-profiles' && can('create') && <TaxPendingButton refreshKey={data?.total} onCreated={() => void load()} />}
            {libType && libCan('view') && <button type="button" className="secondary-button" onClick={() => setReasonLib(true)}>异常原因库</button>}
            {type === 'finance-categories' && tab && can('edit') && <button type="button" className="secondary-button" onClick={() => setSorting(true)}>调整顺序</button>}
            {gridAllowed && !gridOn && <button type="button" className="secondary-button" onClick={enterGrid} title="整页变成像飞书表格一样的编辑表格，适合批量管理">表格编辑</button>}
            {can('import') && <button type="button" className="secondary-button" disabled={gridLocked} onClick={() => setImporting(true)}>导入</button>}
            {can('export') && <button type="button" className="secondary-button" onClick={() => void doExport('filtered')}>{filtered ? '导出当前筛选' : '导出'}</button>}
            {can('export') && filtered && <button type="button" className="secondary-button" onClick={() => void doExport('all')}>导出全部</button>}
            {can('export') && checked.length > 0 && <button type="button" className="secondary-button" onClick={() => void doExport('picked')}>导出所选 {checked.length}</button>}
            {can('create') && <button type="button" className="primary-button" disabled={gridLocked} onClick={() => setCreating(true)}>＋ 新增</button>}
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
            onSelect={(id) => { if (gridLocked) return; setFilterVals((v) => ({ ...v, [treeField.key]: id })); setPage(1); }}
          />
        )}
        <div className="card">
          <fieldset className="grid-lock" disabled={gridLocked} title={gridLocked ? '有没保存的修改：请先保存或放弃，再换筛选或翻页' : undefined}>
          {(tabField || def.quickTabs?.length) && !lockedTab && (
            <div className="tab-group page-tabs" role="tablist" aria-label="分类">
              <button type="button" role="tab" aria-selected={tab === ''} className={tab === '' ? 'chip active' : 'chip'} onClick={() => { setTab(''); setPage(1); if (treeField) setFilterVals((v) => ({ ...v, [treeField.key]: '' })); }}>全部</button>
              {[...resourceTabOptions(def), ...(def.tabsBy === 'archiveType' && (unitOpts.archive_type ?? []).filter((o) => !resourceTabOptions(def).some((b) => b.value === o.value))) || [], ...(def.quickTabs ?? []).map((t) => ({ value: `q:${t.key}`, label: t.label })).filter((t) => tab === t.value || !data?.tabCounts || (data.tabCounts[t.value] ?? 0) > 0)].map((o) => (
                <button key={o.value} type="button" role="tab" aria-selected={tab === o.value} className={tab === o.value ? 'chip active' : 'chip'} onClick={() => { setTab(o.value); setPage(1); if (treeField) setFilterVals((v) => ({ ...v, [treeField.key]: '' })); }}>
                  {o.label}{data?.tabCounts ? ` ${data.tabCounts[o.value] ?? 0}` : ''}
                </button>
              ))}
            </div>
          )}
          <div className="toolbar">
            <span className="list-search grow">
              <input type="search" placeholder="搜索（多个词用空格隔开）" aria-label="搜索" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
              {keyword && <button type="button" className="icon-button search-clear" aria-label="清空搜索" onClick={() => { setKeyword(''); setPage(1); }}>✕</button>}
            </span>
            {(filterFields.length > 0 || viewFilters.length > 0) && (
              <button type="button" className={`secondary-button filter-toggle${activeFilterCount ? ' active' : ''}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
                筛选{activeFilterCount ? ` ${activeFilterCount}` : ''}
              </button>
            )}
            <select className="sort-mobile" aria-label="排序方式" value={sort ? `${sort.by}:${sort.dir}` : ''} onChange={(e) => { const [by, dir] = e.target.value.split(':'); setSort(by ? { by, dir: dir as 'asc' | 'desc' } : null); setPage(1); }}>
              <option value="">默认排序</option>
              {columns.filter((f) => SORTABLE.has(f.type)).flatMap((f) => [<option key={`${f.key}:asc`} value={`${f.key}:asc`}>{f.label} ↑</option>, <option key={`${f.key}:desc`} value={`${f.key}:desc`}>{f.label} ↓</option>])}
            </select>
            <div className={`filter-group${filtersOpen ? ' open' : ''}`}>
            {filterFields.filter((ff) => ff.key !== treeField?.key).map((ff) => (
              <select key={ff.key} aria-label={ff.label} value={filterVals[ff.key] ?? ''} onChange={(e) => { setFilterVals((v) => ({ ...v, [ff.key]: e.target.value })); setPage(1); }}>
                <option value="">{ff.label}：全部</option>
                {(filterOpts[ff.key] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            ))}
            {viewFilters.map((vf) => (
              <select key={vf.key} aria-label={vf.label} value={filterVals[vf.key] ?? ''} onChange={(e) => { setFilterVals((v) => ({ ...v, [vf.key]: e.target.value })); setPage(1); }}>
                <option value="">{vf.label}：全部</option>
                {(vf.optionsFrom === 'departments' ? deptOpts : vf.options).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ))}
            <select aria-label="状态" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">状态：全部</option>
              {def.statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            </div>
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
            {filtered && <button type="button" className="secondary-button" onClick={clearFilters}>清除筛选</button>}
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
                  <div className="pill-row">
                    <button type="button" className="link-button" onClick={() => setColKeys(shownFields.map((f) => f.key))}>全部显示</button>
                    <button type="button" className="link-button" onClick={() => setColKeys(defaults.map((f) => f.key))}>恢复默认</button>
                  </div>
                </div>
              )}
            </div>
          </div>
          </fieldset>
          {filtered && data && (
            <div className="result-bar" role="status" aria-live="polite">
              <span>{data.total ? `找到 ${data.total} 条符合条件的${def.label}` : `没有符合条件的${def.label}`}</span>
              <button type="button" className="link-button" onClick={clearFilters}>清除搜索和筛选</button>
            </div>
          )}
          {catPath && <div className="muted" style={{ padding: '6px 12px' }}>当前分类：{catPath}（含下级分类）</div>}
          {error && <div role="alert" className="notice error m">{error}</div>}
          {!gridOn && checked.length > 0 && <BatchBar def={def} type={type} rows={data?.items ?? []} checked={checked} can={can} filterOpts={filterOpts} onMessage={setBatchMsg} onDone={() => void load()} onExport={() => void doExport('picked')} onClear={() => setChecked([])} />}
          {batchMsg && <div role="status" className="notice m between"><span>{batchMsg}</span><button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setBatchMsg('')}>✕</button></div>}
          {gridOn ? (
            data ? (
              <ResourceGrid
                key={type}
                def={def}
                items={data.items}
                fields={columns}
                sort={sort}
                newDefaults={newInitial()}
                newLabels={treeField && catPath && filterVals[treeField.key] ? { [treeField.key]: catPath } : undefined}
                onSort={(key) => { setSort(sort?.by === key ? (sort.dir === 'asc' ? { by: key, dir: 'desc' } : null) : { by: key, dir: 'asc' }); setPage(1); }}
                onDirtyChange={setGridDirty}
                onOpen={setSelected}
                onSaved={(ok) => { if (ok) void load(); }}
                onExit={leaveGrid}
              />
            ) : <div className="muted center m">加载中…</div>
          ) : (
          <div className="table-scroll">
            <table className="data-table cards-narrow">
              <thead>
                <tr>
                  {<th style={{ width: 32 }}><input type="checkbox" aria-label="本页全选" checked={!!data?.items.length && data.items.every((r) => checked.includes(r.id))} onChange={(e) => setChecked(e.target.checked ? [...new Set([...checked, ...(data?.items.map((r) => r.id) ?? [])])] : checked.filter((id) => !data?.items.some((r) => r.id === id)))} /></th>}
                  {columns.map((f) => SORTABLE.has(f.type) ? (
                    <th key={f.key} aria-sort={sort?.by === f.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" className="link-button" title="点击排序" onClick={() => { setSort(sort?.by === f.key ? (sort.dir === 'asc' ? { by: f.key, dir: 'desc' } : null) : { by: f.key, dir: 'asc' }); setPage(1); }}>
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
                      {<td className="card-skip" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`勾选 ${row.title}`} checked={checked.includes(row.id)} onChange={(e) => setChecked(e.target.checked ? [...checked, row.id] : checked.filter((id) => id !== row.id))} /></td>}
                      {columns.map((f) => {
                        const due = dueBadgeFor(type, f.key, row.data, row.status, today);
                        return (
                          <td key={f.key} data-label={f.label} className={f.type === 'money' ? 'num' : undefined}>
                            {displayValue(f, row)}
                            {isCopyable(def, f) && f.type !== 'number' && displayValue(f, row) && <> <CopyButton value={displayValue(f, row)} label={f.label} /></>}
                            {due && <> <span className={`pill ${due.level === 'expired' ? 'bad' : 'warn'}`} title="到期提醒按今天的日期实时计算">{due.text}</span></>}
                          </td>
                        );
                      })}
                      <td data-label="状态"><span className={`pill ${st.tone === 'muted' ? 'warn' : st.tone}`}>{st.label}</span></td>
                    </tr>
                  );
                })}
                {data && data.items.length === 0 && (
                  <tr><td colSpan={columns.length + 2} className="muted center">
                    {filtered ? <>没有符合当前条件的{def.label}。可以清空搜索词、换一个分类，或勾选“显示停用”。 <button type="button" className="link-button" onClick={clearFilters}>清除全部条件</button></> : `还没有${def.label}`}
                  </td></tr>
                )}
                {!data && !error && <tr><td colSpan={columns.length + 2} className="muted center">加载中…</td></tr>}
              </tbody>
            </table>
          </div>
          )}
          <div className="card-foot between">
            <span>共 {data?.total ?? 0} 条 · 点击一行在右侧查看，不跳转页面</span>
            <span className="pill-row">
              <select aria-label="每页条数" disabled={gridLocked} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                {PAGE_SIZES.map((n) => <option key={n} value={n}>每页 {n} 条</option>)}
              </select>
              <button type="button" className="secondary-button" disabled={page <= 1 || gridLocked} onClick={() => setPage(page - 1)}>上一页</button>
              <span>{page} / {totalPages}</span>
              <button type="button" className="secondary-button" disabled={page >= totalPages || gridLocked} onClick={() => setPage(page + 1)}>下一页</button>
            </span>
          </div>
        </div>
        </div>
      </section>

      {archiveTypesOpen && <ArchiveTypeDialog counts={data?.tabCounts} onClose={() => setArchiveTypesOpen(false)} onChanged={() => void load()} />}
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
      {sorting && tab && <CategorySortDialog archiveType={tab} onClose={() => setSorting(false)} onDone={() => void load()} />}
      {reasonLib && libType && <ReasonLibraryDialog libType={libType} title={type === 'stores' ? '店铺异常原因库' : '手机号异常原因库'} onClose={() => setReasonLib(false)} />}
      {importing && (
        <ImportDialog
          def={def}
          onClose={() => setImporting(false)}
          onDone={(m) => {
            setImporting(false);
            if (m) setBatchMsg(m);
            void load();
          }}
        />
      )}
    </div>
  );
}
