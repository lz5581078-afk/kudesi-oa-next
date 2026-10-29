import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fieldOptions, loadUnitOptions, useUnitOptions } from './unitOptions';
import { selectChoices, useCategoryOptions } from './categoryOptions';
import { CategoryManageDialog } from './CategoryManageDialog';
import { BatchBar } from './BatchBar';
import { rowActionsFor } from './RowActions';
import { resourceDescription, PARTY_SEED_CATEGORIES, WAREHOUSE_PRODUCT_FIELDS, archivePolicyOf, dueBadgeFor, expirySources, getResourceDef, hasFeeDefaults, describeColFilter, STATUS_COL, unitYuanText, resourceTabInitial, resourceTabOptions, resourcePagePath, todayShanghai, treeFilterField, browseFilterFields, permissionOwner, resourcePermission, viewFiltersOf, createChecker, gridPolicyOf, SPECIAL_PERMISSIONS, type ColFilter, type FieldDef } from '@kudesi/shared';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError, api } from '../api/client';
import { downloadText } from './csv';
import { resourceApi, type ListResult } from './api';
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
import { LeaveDialog, RouterLeaveBlocker, type GridControl, type LeaveRequest } from './grid/LeaveGuard';
import { labelKey, readColFilters, writeColFilters, type SavedColFilters } from './colFilterPrefs';
import { useWideScreen } from './grid/useWideScreen';
import { AppbarHint, useAppbarBare, useHasAppbarSlot } from '../layout/AppbarSlot';
import { ResourceCards, ResourceTable, SORTABLE } from './ResourceTable';
import { ActiveChips, ColumnsPop, DensityButton, FilterPop, MorePop, type Chip } from './ListTools';
import { PageHint } from './PageHint';
import { AddAccountDialog, UnfiledBanner } from './WorkforcePanels';
import { CloseIcon, GearIcon, SearchGlyph } from './ResIcons';
import { useColumnWidths, useDensity } from './listPrefs';
import { useIsMobile } from './useMedia';
import { displayValue } from './format';
import { groupNote } from './groupNote';
import { groupRowsByDept, groupRowsByValue, type DeptRef, type RowGroup } from './groupRows';

const PAGE_SIZES = [20, 50, 100, 200] as const;

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
export function ResourcePage({ type, lockedTab, title, embedded }: { type: string; lockedTab?: string; title?: string; embedded?: boolean }) {
  const def = getResourceDef(type)!;
  const isMobile = useIsMobile();
  const [density, setDensity] = useDensity();
  const colWidths = useColumnWidths(type);
  const hasAppbar = useHasAppbarSlot();
  useAppbarBare(!embedded);
  const can = useResourceCan(type);
  const unitOpts = useUnitOptions(); // 单位列表读到后，列表里的单位编码才能换成名称
  const { user: me } = useAuth();
  const colCan = useMemo(() => createChecker(me?.permissions ?? { isCompanyAdmin: false, allow: [], deny: [] }), [me]);
  // 列筛选（表格列头设置，服务端筛，分页总数是筛选后的）；条件按资料类型记在本机
  const [colSaved, setColSaved] = useState<SavedColFilters>(() => readColFilters(def, colCan));
  const colFilters = colSaved.filters;
  const colType = useRef(type);
  useEffect(() => {
    if (colType.current === type) return;
    colType.current = type;
    setColSaved(readColFilters(def, colCan));
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps
  const commitCol = (next: SavedColFilters) => { setColSaved(next); writeColFilters(type, next); setPage(1); };
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
  // 左侧目录的浏览维度：分类、位置、使用人、部门…（配置在 filterBy 里）
  const browseFields = useMemo(() => browseFilterFields(def), [def]);
  const browseKeys = useMemo(() => new Set(browseFields.map((f) => f.key)), [browseFields]);
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
  const [paths, setPaths] = useState<Record<string, string>>({});
  const setPath = useCallback((key: string, path: string) => setPaths((cur) => (cur[key] === path ? cur : { ...cur, [key]: path })), []);
  const [page, setPage] = useState(1);
  const [checked, setChecked] = useState<number[]>([]);
  const [batchMsg, setBatchMsg] = useState('');
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [copyInit, setCopyInit] = useState<Record<string, unknown> | null>(null);
  const [importing, setImporting] = useState(false);
  const [reasonLib, setReasonLib] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [inventory, setInventory] = useState(false);
  const libType = type === 'stores' ? 'store-abnormal-reasons' : type === 'phones' ? 'phone-abnormal-reasons' : '';
  const libCan = useResourceCan(libType || type);
  const catCan = useResourceCan('asset-categories');

  // 列表按引用字段分组（配置 listGroupBy，如职责组按所属部门）：分组可折叠，分组方式和折叠状态按资料类型记在本机
  const groupCfg = def.listGroupBy;
  const [groupOn, setGroupOn] = useState(() => { try { return localStorage.getItem(`kudesi.group.${type}`) !== 'flat'; } catch { return true; } });
  const [foldedGroups, setFoldedGroups] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(`kudesi.folded.${type}`) ?? '[]') as string[]); } catch { return new Set(); } });
  const wantGroup = Boolean(groupCfg) && groupOn;
  const [groupDepts, setGroupDepts] = useState<DeptRef[]>([]);
  useEffect(() => {
    if (!groupCfg || groupCfg.order !== 'department') return;
    resourceApi.departments().then(setGroupDepts).catch(() => setGroupDepts([]));
  }, [groupCfg]);

  // 派生列（配置 derivedColumns）：按页现算的数字，当作只读列显示，服务端可排序、可导出
  const derivedFields = useMemo<FieldDef[]>(() => (def.derivedColumns ?? []).map((d) => ({ key: d.key, label: d.label, type: d.kind === 'sum' && d.format === 'money' ? 'money' : 'number', group: '统计', readonly: true, list: d.list !== false })), [def]);
  const derivedKeys = useMemo(() => new Set(derivedFields.map((f) => f.key)), [derivedFields]);
  const shownFields = useMemo(() => [...def.fields.filter((f) => f.type !== 'secret'), ...derivedFields], [def, derivedFields]);
  const defaults = useMemo(() => [...def.fields.filter((f) => f.list), ...derivedFields.filter((f) => f.list)], [def, derivedFields]);
  const [colKeys, setColKeys] = useColumns(type, shownFields, defaults);
  const warehouseMode = Boolean(data?.items.some((i) => i.warehouseMode));
  const columns = colKeys.map((k) => shownFields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f))
    .filter((f) => !warehouseMode || WAREHOUSE_PRODUCT_FIELDS.includes(f.key))
    .filter((f) => !(wantGroup && f.key === groupCfg?.field)); // 按这个字段分组时，列里不再重复显示
  const tabField = def.tabsBy ? def.fields.find((f) => f.key === def.tabsBy) : undefined;

  // 切换资料类型时重置筛选
  const resetType = useRef<string | null>(null);
  useEffect(() => {
    setKeyword('');
    setTab(lockedTab ?? '');
    setStatus(readPrefs(type).status ?? '');
    const n = readPrefs(type).pageSize;
    setPageSize(n && (PAGE_SIZES as readonly number[]).includes(n) ? n : 20);
    setShowHidden(false);
    setPage(1);
    // 同一资料内 lockedTab 变化不关掉刚由 ?open 打开的详情
    if (resetType.current !== type) setSelected(null);
    resetType.current = type;
    setData(null);
  }, [type, lockedTab]);

  // 记住筛选、状态和每页条数（按资料类型）；分类目录的选择不记
  useEffect(() => {
    const keep = Object.fromEntries(Object.entries(filterVals).filter(([k, v]) => v && !browseKeys.has(k)));
    writePrefs(type, { pageSize, status, filters: keep });
  }, [filterVals, status, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  // 记住的筛选项如果已经不存在（选项被删/改名），会让列表莫名其妙是空的，加载到选项后清掉它
  useEffect(() => {
    setFilterVals((cur) => {
      const stale = Object.entries(cur).filter(([k, v]) => {
        if (!v || browseKeys.has(k)) return false;
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
      setData(await resourceApi.list(type, { page: wantGroup ? 1 : page, pageSize: wantGroup ? 200 : pageSize, keyword: keyword.trim() || undefined, tab: tab || undefined, status: status || undefined, showHidden, archived, expiring, sortBy: sort?.by, sortDir: sort?.dir, filters: filterVals, colFilters }));
      setError('');
      if (type === 'finance-product-units') void loadUnitOptions(true); // 单位列表变了，商品档案的下拉也要跟着变
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [type, page, keyword, tab, status, showHidden, archived, expiring, pageSize, sort, filterVals, colFilters, wantGroup]);

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
  const grouping = wantGroup && !gridOn;
  const groupField = groupCfg ? def.fields.find((f) => f.key === groupCfg.field) : undefined;
  const [chip, setChip] = useState('');
  useEffect(() => setChip(''), [type, tab, status]);
  const allGroups = useMemo<RowGroup[] | undefined>(() => (grouping && data && groupCfg ? (groupCfg.order === 'value' && groupField ? groupRowsByValue(data.items, groupCfg.field, groupCfg.emptyLabel, (r) => displayValue(groupField, r)) : groupRowsByDept(data.items, groupCfg.field, groupCfg.emptyLabel, groupDepts, groupCfg.thenBy)).map((g) => ({ ...g, note: groupNote(type, g.rows) })) : undefined), [grouping, data, groupCfg, groupField, groupDepts, type]);
  const rowGroups = useMemo<RowGroup[] | undefined>(() => (allGroups && chip ? allGroups.filter((g) => g.key === chip) : allGroups), [allGroups, chip]);
  const setGroupMode = (on: boolean) => { setGroupOn(on); setPage(1); try { localStorage.setItem(`kudesi.group.${type}`, on ? 'group' : 'flat'); } catch { /* 存储不可用时只是不记住 */ } };
  const toggleGroup = (key: string) => setFoldedGroups((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); try { localStorage.setItem(`kudesi.folded.${type}`, JSON.stringify([...n])); } catch { /* 忽略 */ } return n; });
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
  // 有没保存的修改时，任何会丢掉修改的离开动作（退出表格、站内跳转、后退前进、切换资料）都先弹确认
  const gridCtl = useRef<GridControl | null>(null);
  const [leave, setLeave] = useState<LeaveRequest | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const leaveCounts = leave ? gridCtl.current?.counts() ?? { changes: 0, errors: 0 } : { changes: 0, errors: 0 };
  async function leaveSave() {
    const req = leave;
    if (!req || !gridCtl.current) return;
    setLeaveBusy(true);
    let ok = false;
    try { ok = await gridCtl.current.save(); } finally { setLeaveBusy(false); }
    setLeave(null);
    if (ok) req.go();
    else { req.cancel?.(); setError('有行保存失败或格式不对，没有退出：请在表格里修改后再保存（失败原因在最右一列）。'); }
  }
  function leaveDiscard() { const req = leave; setLeave(null); req?.go(); }
  function leaveStay() { const req = leave; setLeave(null); req?.cancel?.(); }

  const [seeding, setSeeding] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [packagingXlOpen, setPackagingXlOpen] = useState(false);
  const [costXlOpen, setCostXlOpen] = useState(false);
  const [archiveTypesOpen, setArchiveTypesOpen] = useState(false);
  const catOptions = useCategoryOptions(type); // 页签分类：本公司的名称、顺序、自建、隐藏
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const canManageCategories = !!catOptions && can('view') && !!me && createChecker(me.permissions)(SPECIAL_PERMISSIONS.resourceCategoriesManage);
  const costCan = colCan;
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
    for (const bf of browseFields) {
      const picked = Number(filterVals[bf.key]);
      if (picked) init[bf.key] = bf.type === 'refs' ? [picked] : picked;
    }
    return Object.keys(init).length ? init : undefined;
  }

  const filtered = Boolean(colFilters.length || keyword.trim() || tab || status || archived || expiring || Object.values(filterVals).some(Boolean));
  const onCheck = (ids: number[], on: boolean) => setChecked((cur) => (on ? [...new Set([...cur, ...ids])] : cur.filter((id) => !ids.includes(id))));
  function clearFilters() {
    if (colFilters.length) commitCol({ filters: [], labels: {} });
    setKeyword(''); setStatus(''); setArchived(false); setExpiring(false); setFilterVals({}); setTab(lockedTab ?? ''); setPage(1);
  }
  async function doExport(scope: 'filtered' | 'all' | 'picked') {
    try {
      const cols = colKeys.filter((k) => derivedKeys.has(k));
      const out = await resourceApi.export(type, showHidden || archived, scope === 'all' ? { cols } : scope === 'picked'
        ? { ids: checked, cols }
        : { cols, keyword: keyword.trim() || undefined, tab: tab || undefined, status: status || undefined, archived, expiring, filters: filterVals, colFilters, sortBy: sort?.by, sortDir: sort?.dir });
      downloadText(out.filename, out.csv);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '导出失败');
    }
  }

  // —— 工具条派生数据 ——
  const treeKey = treeField?.key;
  const shownFilterFields = filterFields.filter((ff) => !browseKeys.has(ff.key));
  const optLabel = (key: string, value: string) => (filterOpts[key] ?? []).find((o) => String(o.id) === value)?.label ?? value;
  const chips: Chip[] = [];
  const dropVal = (k: string) => () => { setFilterVals((v) => ({ ...v, [k]: '' })); setPage(1); };
  for (const ff of shownFilterFields) if (filterVals[ff.key]) chips.push({ key: ff.key, text: `${ff.label}：${optLabel(ff.key, filterVals[ff.key])}`, clear: dropVal(ff.key) });
  for (const vf of viewFilters) if (filterVals[vf.key]) chips.push({ key: vf.key, text: `${vf.label}：${(vf.optionsFrom === 'departments' ? deptOpts : vf.options).find((o) => o.value === filterVals[vf.key])?.label ?? filterVals[vf.key]}`, clear: dropVal(vf.key) });
  if (status) chips.push({ key: 'status', text: `状态：${def.statuses.find((x) => x.value === status)?.label ?? status}`, clear: () => { setStatus(''); setPage(1); } });
  if (expiring) chips.push({ key: 'expiring', text: '即将到期', clear: () => { setExpiring(false); setPage(1); } });
  if (archived) chips.push({ key: 'archived', text: '已归档', clear: () => { setArchived(false); setPage(1); } });
  if (showHidden && hiddenExists && !status && !archived) chips.push({ key: 'hidden', text: `含${def.statuses.filter((x) => x.hidden).map((x) => x.label).join('/')}`, clear: () => { setShowHidden(false); setPage(1); } });
  for (const bf of browseFields) if (filterVals[bf.key] && paths[bf.key]) chips.push({ key: `browse:${bf.key}`, text: `${browseFields.length > 1 || bf.key !== treeKey ? bf.label : '分类'}：${paths[bf.key]}`, clear: () => { setFilterVals((v) => ({ ...v, [bf.key]: '' })); setPage(1); } });
  const colFieldLabel = (key: string) => (key === STATUS_COL ? '状态' : def.fields.find((f) => f.key === key)?.label ?? key);
  const colValueLabel = (f: ColFilter) => (v: string) => {
    if (f.key === STATUS_COL) return def.statuses.find((x) => x.value === v)?.label ?? v;
    const field = def.fields.find((x) => x.key === f.key);
    if (field?.type === 'select') return selectChoices(type, field, (x) => fieldOptions(x, {}, unitOpts), { mode: 'display' }).find((o) => o.value === v)?.label ?? v;
    return colSaved.labels[labelKey(f.key, v)] ?? v;
  };
  colFilters.forEach((f, i) => {
    const money = def.fields.find((x) => x.key === f.key)?.type === 'money';
    const shown = money ? { ...f, value: f.value !== undefined ? unitYuanText(Number(f.value)) : undefined, value2: f.value2 !== undefined ? unitYuanText(Number(f.value2)) : undefined } : f;
    chips.push({ key: `col:${i}`, text: describeColFilter(shown, colFieldLabel(f.key), colValueLabel(f)), clear: () => commitCol({ ...colSaved, filters: colFilters.filter((_, j) => j !== i) }) });
  });
  const hasFilterPop = true;
  const popCount = chips.filter((c) => !c.key.startsWith('browse:') && !c.key.startsWith('col:')).length;
  const tabList = (tabField || def.quickTabs?.length) && !lockedTab
    ? [...resourceTabOptions(def, catOptions?.filter((o) => !o.hidden)), ...((def.tabsBy === 'archiveType' && (unitOpts.archive_type ?? []).filter((o) => !resourceTabOptions(def).some((b) => b.value === o.value))) || []), ...(def.quickTabs ?? []).map((t) => ({ value: `q:${t.key}`, label: t.label })).filter((t) => tab === t.value || !data?.tabCounts || (data.tabCounts[t.value] ?? 0) > 0)]
    : [];
  useEffect(() => { // 当前页签的分类被隐藏/删除后回到“全部”
    if (tab && catOptions && !tab.startsWith('q:') && !def.tabSplit && !tabList.some((t) => t.value === tab)) setTab('');
  }, [catOptions]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabsOwnRow = tabList.length > 3 || isMobile; // 分类多的资料（商品档案等）页签单独一行，工具条仍是一行
  const desc = !lockedTab ? resourceDescription(type) : '';
  const hint = desc ? <PageHint text={desc} /> : null;
  const items = rowGroups ? rowGroups.flatMap((g) => g.rows) : data?.items ?? [];
  const selIdx = selected !== null ? items.findIndex((r) => r.id === selected) : -1;
  const detailNav = selIdx >= 0 ? { index: selIdx + 1, total: items.length, onPrev: selIdx > 0 ? () => setSelected(items[selIdx - 1].id) : undefined, onNext: selIdx < items.length - 1 ? () => setSelected(items[selIdx + 1].id) : undefined } : undefined;
  useEffect(() => {
    if (selected !== null) document.querySelector('.res-table tr.selected, .res-card.selected')?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const tabsEl = tabList.length > 0 && (
    <div className="res-tabs" role="tablist" aria-label="分类">
      <button type="button" role="tab" aria-selected={tab === ''} className={tab === '' ? 'res-tab active' : 'res-tab'} onClick={() => { setTab(''); setPage(1); if (treeField) setFilterVals((v) => ({ ...v, [treeField.key]: '' })); }}>全部</button>
      {tabList.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={tab === o.value} className={tab === o.value ? 'res-tab active' : 'res-tab'} onClick={() => { setTab(o.value); setPage(1); if (treeField) setFilterVals((v) => ({ ...v, [treeField.key]: '' })); }}>
          {o.label}{data?.tabCounts ? <i>{data.tabCounts[o.value] ?? 0}</i> : null}
        </button>
      ))}
      {canManageCategories && (
        <button type="button" className="res-tab-gear" aria-label="管理分类" title="管理分类：改名、排序、隐藏、新增" onClick={() => setCategoriesOpen(true)}><GearIcon /></button>
      )}
    </div>
  );

  const extras = (
    <>
      {groupCfg && <button type="button" className={wantGroup ? 'res-btn on' : 'res-btn'} aria-pressed={wantGroup} title={`列表按${groupField?.label ?? '所属部门'}分组，可折叠`} onClick={() => setGroupMode(!wantGroup)}>{groupCfg.order === 'value' ? `按${groupField?.label ?? ''}分组` : '按部门分组'}</button>}
      {type === 'finance-products' && costCan('product.cost.view') && costCan('resource.finance-product-costs.view') && <button type="button" className="res-btn" onClick={() => setCostXlOpen(true)}>成本 Excel</button>}
      {type === 'finance-packaging-schemes' && <button type="button" className="res-btn" onClick={() => setPackagingXlOpen(true)}>Excel 导入导出</button>}
      {type === 'finance-products' && can('edit') && <button type="button" className="res-btn" onClick={() => setArchiveTypesOpen(true)}>管理档案类型</button>}
      {type === 'finance-product-units' && can('create') && <button type="button" className="res-btn" disabled={seeding} onClick={seedUnits}>{seeding ? '导入中…' : '导入默认项'}</button>}
      {type === 'finance-fee-items' && can('create') && hasFeeDefaults(me?.companyName) && <button type="button" className="res-btn" disabled={seeding} onClick={seedFees}>{seeding ? '导入中…' : '导入默认费用档案'}</button>}
      {type === 'finance-fee-items' && <button type="button" className="res-btn" onClick={() => setSnapshotsOpen(true)}>费用存档表</button>}
      {(type === 'finance-supplier-categories' || type === 'finance-customer-categories') && can('create') && (
        <button type="button" className="res-btn" onClick={async () => {
          try {
            const have = new Set((await resourceApi.list(type, { pageSize: 200, showHidden: true })).items.map((i) => i.title));
            let n = 0;
            for (const [name, subtitle] of PARTY_SEED_CATEGORIES[type]) if (!have.has(name)) { await resourceApi.create(type, { name, subtitle }); n++; }
            setBatchMsg(n ? `已导入 ${n} 个默认分类` : '默认分类都已经有了');
            void load();
          } catch (e) { setBatchMsg(e instanceof ApiError ? e.message : '导入失败'); }
        }}>导入默认分类</button>
      )}
      {type === 'workforce' && can('create') && <button type="button" className="res-btn" onClick={() => setAddingAccount(true)}>新增账号并建档</button>}
      {type === 'fixed-assets' && catCan('view') && resourcePagePath('asset-categories') && <Link className="res-btn" to={resourcePagePath('asset-categories')!}>分类管理</Link>}
      {type === 'fixed-assets' && can('edit') && <button type="button" className="res-btn" onClick={() => setInventory(true)}>盘点</button>}
      {type === 'tax-profiles' && can('create') && <TaxPendingButton refreshKey={data?.total} onCreated={() => void load()} />}
      {libType && libCan('view') && <button type="button" className="res-btn" onClick={() => setReasonLib(true)}>异常原因库</button>}
      {type === 'finance-categories' && tab && can('edit') && <button type="button" className="res-btn" onClick={() => setSorting(true)}>调整顺序</button>}
    </>
  );

  const actions = (
    <>
      {extras}
      {gridAllowed && !gridOn && <button type="button" className="res-btn" onClick={enterGrid} title="整页变成像飞书表格一样的编辑表格，适合批量管理">表格编辑</button>}
      {can('import') && <button type="button" className="res-btn" disabled={gridLocked} onClick={() => setImporting(true)}>导入</button>}
      {can('export') && (filtered
        ? <MorePop label="导出"><>
            <button type="button" role="menuitem" onClick={() => void doExport('filtered')}>导出当前筛选</button>
            <button type="button" role="menuitem" onClick={() => void doExport('all')}>导出全部</button>
          </></MorePop>
        : <button type="button" className="res-btn" onClick={() => void doExport('filtered')}>导出</button>)}
      {can('create') && <button type="button" className="res-btn primary" disabled={gridLocked} onClick={() => setCreating(true)}>＋ 新增</button>}
    </>
  );

  const addInGroup = groupCfg && can('create') ? (g: RowGroup) => { setCopyInit(def.fields.find((f) => f.key === groupCfg.field)?.readonly ? {} : g.refId ? { [groupCfg.field]: g.refId } : g.value ? { [groupCfg.field]: g.value } : {}); setCreating(true); } : undefined;
  const rowActions = useMemo(() => rowActionsFor(type, (a) => can(a), (m) => { if (m) setBatchMsg(m); void load(); }), [type, can, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const empty = filtered
    ? <div className="res-empty"><p>没有符合当前条件的{def.label}。可以清空搜索词、换一个分类，或勾选“显示停用”。</p><button type="button" className="link-button" onClick={clearFilters}>清除全部条件</button></div>
    : <div className="res-empty"><p>还没有{def.label}</p>{can('create') && <button type="button" className="res-btn primary sm" onClick={() => setCreating(true)}>＋ 新增{def.label}</button>}</div>;

  const toolbar = (
    <fieldset className="grid-lock res-tools" disabled={gridLocked} title={gridLocked ? '有没保存的修改：请先保存或放弃，再换筛选或翻页' : undefined}>
      {tabsOwnRow && tabsEl}
      <div className="res-bar">
        {!tabsOwnRow && tabsEl}
        <span className="res-search">
          <SearchGlyph />
          <input type="search" placeholder="搜索，多个词用空格隔开" aria-label="搜索" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1); }} />
          {keyword && <button type="button" className="icon-button search-clear" aria-label="清空搜索" onClick={() => { setKeyword(''); setPage(1); }}><CloseIcon size={12} /></button>}
        </span>
        {hasFilterPop && (
          <FilterPop
            count={popCount}
            filtered={filtered}
            extra={isMobile ? (
              <label className="res-filter-wide"><span>排序</span>
                <select aria-label="排序方式" value={sort ? `${sort.by}:${sort.dir}` : ''} onChange={(e) => { const [by, dir] = e.target.value.split(':'); setSort(by ? { by, dir: dir as 'asc' | 'desc' } : null); setPage(1); }}>
                  <option value="">默认排序</option>
                  {columns.filter((f) => SORTABLE.has(f.type)).flatMap((f) => [<option key={`${f.key}:asc`} value={`${f.key}:asc`}>{f.label} ↑</option>, <option key={`${f.key}:desc`} value={`${f.key}:desc`}>{f.label} ↓</option>])}
                </select>
              </label>
            ) : undefined}
            state={{ fields: shownFilterFields, viewFilters, vals: filterVals, opts: filterOpts, deptOpts, status, statuses: def.statuses, hasExpiry: expirySources().some((x) => x.resource === type), expiring, archivable: Boolean(archivePolicyOf(type)), archived, archivedCount: data?.archivedCount, hiddenLabels: def.statuses.filter((x) => x.hidden).map((x) => x.label), showHidden, canShowHidden: hiddenExists }}
            actions={{
              setVal: (k, v) => { setFilterVals((cur) => ({ ...cur, [k]: v })); setPage(1); },
              setStatus: (v) => { setStatus(v); setPage(1); },
              setExpiring: (v) => { setExpiring(v); setPage(1); },
              setArchived: (v) => { setArchived(v); setPage(1); },
              setShowHidden: (v) => { setShowHidden(v); setPage(1); },
              clearAll: clearFilters,
            }}
          />
        )}
        {!isMobile && <ColumnsPop fields={shownFields} picked={colKeys} onChange={setColKeys} defaults={defaults} />}
        {!isMobile && <DensityButton density={density} onChange={setDensity} />}
        {!hasAppbar && hint}
        <span className="res-bar-gap" />
        <div className="res-actions">{isMobile ? (
          <>
            {can('create') && <button type="button" className="res-btn primary" disabled={gridLocked} onClick={() => setCreating(true)}>＋ 新增</button>}
            <MorePop label="更多"><>
              {extras}
              {can('import') && <button type="button" role="menuitem" onClick={() => setImporting(true)}>导入</button>}
              {can('export') && <button type="button" role="menuitem" onClick={() => void doExport('filtered')}>{filtered ? '导出当前筛选' : '导出'}</button>}
              {can('export') && filtered && <button type="button" role="menuitem" onClick={() => void doExport('all')}>导出全部</button>}
            </></MorePop>
          </>
        ) : actions}</div>
      </div>
      {(filtered || chips.length > 0) && data && (
        <ActiveChips
          chips={chips}
          summary={filtered ? (data.total ? `找到 ${data.total} 条符合条件的${def.label}` : `没有符合条件的${def.label}`) : ''}
          onClearAll={clearFilters}
        />
      )}
    </fieldset>
  );

  return (
    <div className={`res-page${selected !== null ? ' has-detail' : ''}${embedded ? ' embedded' : ''}`}>
      {hasAppbar && hint && <AppbarHint>{hint}</AppbarHint>}
      <div className={browseFields.length ? 'res-body with-tree' : 'res-body'}>
        {browseFields.length > 0 && (
          <CategoryTree
            type={type}
            fields={browseFields}
            tab={tab}
            status={status}
            showHidden={showHidden}
            values={filterVals}
            reloadKey={data?.total}
            onPath={setPath}
            canManage={(f) => Boolean(def.treeManage?.includes(f.key) && f.ref && me && createChecker(me.permissions)(resourcePermission(permissionOwner(f.ref), 'edit')))}
            onChanged={() => void load()}
            onSelect={(key, id) => { if (gridLocked) return; setFilterVals((v) => ({ ...v, [key]: id })); setPage(1); }}
          />
        )}
        <section className="res-main" aria-label={`${title ?? def.label}列表`}>
          {toolbar}
          {type === 'workforce' && <UnfiledBanner refreshKey={data?.total} canCreate={can('create')} onFile={(userId) => { setCopyInit({ userId }); setCreating(true); }} />}
          {error && <div role="alert" className="notice error m">{error}</div>}
          {!gridOn && checked.length > 0 && <BatchBar def={def} type={type} rows={data?.items ?? []} checked={checked} can={can} filterOpts={filterOpts} onMessage={setBatchMsg} onDone={() => void load()} onExport={() => void doExport('picked')} onClear={() => setChecked([])} />}
          {batchMsg && <div role="status" className="notice m between"><span>{batchMsg}</span><button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setBatchMsg('')}>✕</button></div>}
          {grouping && groupCfg?.chips && allGroups && allGroups.length > 1 && (
            <div className="res-tags" role="group" aria-label={`按${groupField?.label ?? ''}看`}>
              <span className="muted">{groupField?.label}</span>
              {[{ key: '', label: '全部' }, ...allGroups].map((g) => <button key={g.key || 'all'} type="button" className={`res-tag${chip === g.key ? ' active' : ''}`} aria-pressed={chip === g.key} onClick={() => setChip(g.key)}>{g.label}</button>)}
            </div>
          )}
          {gridOn ? (
            data ? (
              <ResourceGrid
                key={type}
                def={def}
                items={data.items}
                derived={derivedFields}
                sort={sort}
                newDefaults={newInitial()}
                newLabels={Object.fromEntries(browseFields.filter((bf) => paths[bf.key] && filterVals[bf.key]).map((bf) => [bf.key, paths[bf.key]]))}
                onSort={(key) => { setSort(sort?.by === key ? (sort.dir === 'asc' ? { by: key, dir: 'desc' } : null) : { by: key, dir: 'asc' }); setPage(1); }}
                onSortTo={(key, dir) => { setSort(dir ? { by: key, dir } : null); setPage(1); }}
                colFilters={colFilters}
                colLabels={colSaved.labels}
                onColFilter={(key, f, labels) => commitCol({ filters: [...colFilters.filter((x) => x.key !== key), ...(f ? [f] : [])], labels: { ...colSaved.labels, ...Object.fromEntries(Object.entries(labels).map(([v, l]) => [labelKey(key, v), l])) } })}
                today={today}
                controlRef={gridCtl}
                onDirtyChange={setGridDirty}
                onOpen={setSelected}
                onSaved={(ok) => { if (ok) void load(); }}
                onExit={() => (gridLocked ? setLeave({ go: leaveGrid }) : leaveGrid())}
              />
            ) : <div className="res-loading" role="status"><span className="res-spin" aria-hidden="true" />加载中…</div>
          ) : isMobile ? (
            <ResourceCards def={def} type={type} rows={data ? data.items : null} columns={columns} checked={checked} onCheck={onCheck} selected={selected} onOpen={setSelected} today={today} empty={empty} groups={rowGroups} folded={foldedGroups} onToggleGroup={toggleGroup} onAddInGroup={addInGroup} />
          ) : (
            <ResourceTable
              def={def}
              type={type}
              rows={data ? data.items : null}
              columns={columns}
              widths={colWidths.widths}
              onWidth={colWidths.preview}
              onWidthCommit={colWidths.commit}
              onWidthReset={colWidths.reset}
              density={density}
              sort={sort}
              onSort={(key) => { setSort(sort?.by === key ? (sort.dir === 'asc' ? { by: key, dir: 'desc' } : null) : { by: key, dir: 'asc' }); setPage(1); }}
              checked={checked}
              onCheck={onCheck}
              selected={selected}
              onOpen={setSelected}
              today={today}
              empty={empty}
              groups={rowGroups}
              folded={foldedGroups}
              onToggleGroup={toggleGroup}
              onAddInGroup={addInGroup}
              rowActions={rowActions}
              rowActionsLabel={['licenses', 'tax-profiles', 'qualifications', 'partners', 'trademarks'].includes(type) ? '查看' : undefined}
            />
          )}
          <div className="res-foot">
            <span className="res-foot-sum">共 {data?.total ?? 0} 条{checked.length > 0 && !gridOn ? <> · 已勾选 {checked.length} 条</> : null}</span>
            {grouping
              ? <span className="res-foot-sum">{rowGroups?.length ?? 0} 个分组{data && data.total > data.items.length ? ` · 只显示前 ${data.items.length} 条，请用筛选缩小范围` : ''}</span>
              : (
                <span className="res-pager">
                  <select aria-label="每页条数" disabled={gridLocked} value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
                    {PAGE_SIZES.map((n) => <option key={n} value={n}>每页 {n} 条</option>)}
                  </select>
                  <button type="button" className="res-btn sm" disabled={page <= 1 || gridLocked} onClick={() => setPage(page - 1)}>上一页</button>
                  <span className="res-page-no">{page} / {totalPages}</span>
                  <button type="button" className="res-btn sm" disabled={page >= totalPages || gridLocked} onClick={() => setPage(page + 1)}>下一页</button>
                </span>
              )}
          </div>
        </section>
      </div>

      {gridOn && <RouterLeaveBlocker when={gridDirty} onBlocked={setLeave} />}
      {leave && <LeaveDialog changes={leaveCounts.changes} errors={leaveCounts.errors} busy={leaveBusy} onSave={() => void leaveSave()} onDiscard={leaveDiscard} onStay={leaveStay} />}
      {categoriesOpen && <CategoryManageDialog type={type} def={def} onClose={() => setCategoriesOpen(false)} onChanged={() => void load()} />}
      {archiveTypesOpen && <ArchiveTypeDialog counts={data?.tabCounts} onClose={() => setArchiveTypesOpen(false)} onChanged={() => void load()} />}
      {costXlOpen && <ProductCostExcelDialog canImport={costCan('product.cost.edit') && costCan('resource.finance-product-costs.create')} onClose={() => setCostXlOpen(false)} onDone={() => void load()} />}
      {packagingXlOpen && <PackagingExcelDialog canCreate={can('create')} onClose={() => setPackagingXlOpen(false)} onDone={() => void load()} />}
      {snapshotsOpen && <FeeSnapshotsDialog canWrite={can('create')} canDelete={can('delete')} onClose={() => setSnapshotsOpen(false)} onRestored={() => void load()} />}
      {selected !== null && <RecordDetail def={def} id={selected} nav={detailNav} onClose={() => setSelected(null)} onChanged={() => void load()} onCopy={can('create') ? (v) => { setCopyInit(v); setSelected(null); setCreating(true); } : undefined} />}

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
      {addingAccount && <AddAccountDialog onClose={() => setAddingAccount(false)} onCreated={(userId) => { setAddingAccount(false); setCopyInit({ userId }); setCreating(true); }} />}
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
