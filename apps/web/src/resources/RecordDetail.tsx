import { copyValuesOf } from './HierRowActions';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useUnitOptions } from './unitOptions';
import { RESOURCE_DEFS, resolveProductSections, groupTitle, relationKindLabel, addDaysText, todayShanghai, archivePolicyOf, createChecker, getResourceDef, permissionOwner, resourcePermission, type ResourceDef } from '@kudesi/shared';
import { Link } from 'react-router-dom';
import { recordLink } from './recordLink';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { VerificationHistoryPanel } from './VerificationHistoryPanel';
import { resourceApi, type LogEntry, type Relation, type ResourceDto } from './api';
import { displayValue, statusOf } from './format';
import { RelationDialog, parsePurpose, type EditableLink } from './RelationDialog';
import { ReasonDialog, RecordForm, clearRefCache } from './RecordForm';
import { StatusControl, typeLabel } from './StatusControl';
import { RevenuePanel } from './RevenuePanel';
import { LinkExistingStoresButton } from './LicenseActions';
import { DutyGroupSummary } from './DutyGroupSummary';
import { AssetActionBar, AssetFlowPanel, AssetStoragePanel, LocationContentsPanel } from './AssetPanels';
import { StoreMetricsPanel } from './StoreMetricsPanel';
import { WorkforceAccountNote } from './WorkforcePanels';
import { ProductCostSummary } from './ProductCostSummary';
import { StoresPopButton } from './StoresPop';
import { DerivedStoresPanel, PartnerSubjectPanel, PhoneArchiveButton, ReturnBorrowButton, StoreAssignButton, StoreReleaseButton } from './CertPanels';
import { useResourceCan } from './useResourceCan';
import { BankCopyAll, InfoValue, SecretCell } from './DetailFields';
import { ACTION_LABEL, LogChanges } from './DetailLogs';
import { DetailHead, type DetailNav } from './DetailHead';
import { FileList } from './FilesField';
import { ChevronDown } from './ResIcons';
import { FINANCE_DETAIL_TYPES } from './FinanceDetailFields';
import { FinanceDetailBackdrop, FinanceDetailBody, FinanceDetailHead } from './FinanceRecordDetail';
import { referenceRecordLabel } from './referenceFormLayout';
import { RevisionDialog } from '../pages/finance/jst/BundleDialogs';

export { useResourceCan };

/** 新增子记录时的默认值：成本明细行默认采购成本、商品规格单位、今天生效、手工锁定（旧系统同款）。 */
export function childDefaults(childType: string, isNew: boolean, parent: ResourceDto): Record<string, unknown> {
  if (!isNew || childType !== 'finance-product-costs') return {};
  const d = parent.data;
  const unit = String(d.purchaseSpec || [d.specQty, d.specUnit].filter(Boolean).join('') || '');
  return { costType: 'purchase', ...(unit ? { unitName: unit } : {}), effectiveFrom: todayShanghai(), manualOverride: true, manualLockReason: '人工确认成本' };
}

const todayText = () => todayShanghai();
/** 供货来源：启用的来源里最近更新的一条，就是商品当前取用的最新成本。 */
export function isLatestSource(it: ResourceDto, all: ResourceDto[]): boolean {
  const live = all.filter((x) => x.status === 'active');
  if (it.status !== 'active' || live.length < 2) return false;
  return !live.some((x) => x.id !== it.id && (x.updatedAt > it.updatedAt || (x.updatedAt === it.updatedAt && x.id > it.id)));
}
/** 同一成本类型里，启用、已开始、没结束且生效日最新的一条。 */
export function isCurrentCost(it: ResourceDto, all: ResourceDto[]): boolean {
  const today = todayText();
  const ok = (x: ResourceDto) => x.status === 'active' && String(x.data.effectiveFrom ?? '') <= today && (!x.data.effectiveTo || String(x.data.effectiveTo) >= today);
  if (!ok(it)) return false;
  return !all.some((x) => x.id !== it.id && x.data.costType === it.data.costType && ok(x) && String(x.data.effectiveFrom) > String(it.data.effectiveFrom));
}

/** 子资源/相关资料卡片里要显示的列（不写就用字段配置里的 list 列） */
const CHILD_COLS: Record<string, readonly string[]> = {
  'bank-accounts': ['kind', 'bank', 'accountNo', 'keeperUserId', 'currentBalance'],
};
/** 这些卡片的每一项带字段名（保管人、存放位置…），并显示密码类字段“已维护/未设置”和备注（旧 U 盾表、银行卡列表的信息） */
const LABELED_CHILDREN = new Set(['u-shields', 'bank-store-links', 'bank-accounts', 'duty-group-members']);

export function ChildPanel({ parentDef, parent, childType, field }: { parentDef: ResourceDef; parent: ResourceDto; childType: string; field: string }) {
  const def = getResourceDef(childType)!;
  const can = useResourceCan(childType);
  const [items, setItems] = useState<ResourceDto[]>([]);
  const [editing, setEditing] = useState<ResourceDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ResourceDto | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try {
      const list = (await resourceApi.list(childType, { pageSize: 100, showHidden: true, fieldKey: field, fieldValue: parent.id })).items;
      setItems(childType === 'finance-product-costs' ? [...list].sort((a, b) => String(b.data.effectiveFrom ?? '').localeCompare(String(a.data.effectiveFrom ?? ''))) : list);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [childType, field, parent.id]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const cols = (CHILD_COLS[childType] ? CHILD_COLS[childType].map((k) => def.fields.find((f) => f.key === k)).filter((f): f is NonNullable<typeof f> => !!f) : def.fields.filter((f) => f.list && f.key !== field));
  const labeled = LABELED_CHILDREN.has(childType);
  const secrets = labeled ? def.fields.filter((f) => f.type === 'secret') : [];
  return (
    <section>
      <div className="between">
        <h2 className="section-title">{def.label}（{items.length}）</h2>
        {can('create') && <button type="button" className="secondary-button small" onClick={() => setEditing('new')}>＋ 新增</button>}
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {items.length === 0 && <p className="muted">还没有{def.label}</p>}
      {items.map((it) => (
        <div key={it.id} className="line-item col">
          <div className="between">
            <strong>{it.title}{childType === 'finance-product-costs' && isCurrentCost(it, items) && <span className="pill ok"> 当前生效</span>}{childType === 'finance-product-sources' && isLatestSource(it, items) && <span className="pill ok"> 当前最新成本</span>}</strong>
            <span className={`pill ${statusOf(def, it.status).tone === 'muted' ? 'warn' : statusOf(def, it.status).tone}`}>{statusOf(def, it.status).label}</span>
          </div>
          <small className="muted">{[...cols.map((f) => { const v = displayValue(f, it); return v && labeled ? `${f.label} ${v}` : v; }), ...secrets.map((f) => `${f.label}${it.secretConfigured[f.key] ? '已维护' : '未设置'}`)].filter(Boolean).join(' · ')}</small>
          {labeled && typeof it.data.note === 'string' && it.data.note && <small className="muted">备注：{it.data.note}</small>}
          <div className="row-actions">
            {can('edit') && <button type="button" className="link-button" onClick={() => setEditing(it)}>编辑</button>}
            {childType === 'license-borrows' && can('edit') && it.status !== 'returned' && <ReturnBorrowButton id={it.id} onDone={reload} onError={setError} />}
            {can('disable') && <StatusControl def={def} id={it.id} current={it.status} onChanged={reload} onError={setError} />}
            {can('delete') && <button type="button" className="link-button danger-text" onClick={() => setDeleting(it)}>删除…</button>}
          </div>
        </div>
      ))}
      {editing && (
        <RecordForm
          def={def}
          record={editing === 'new' ? null : editing}
          initial={{ [field]: parent.id, ...childDefaults(childType, editing === 'new', parent), ...(childType === 'bank-accounts' && parent.data.category ? { kind: parent.data.category === 'ecommerce' ? 'store_public' : 'company_public' } : {}) }}
          lockedFields={[field]}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
      {deleting && (
        <ReasonDialog
          title={`删除${def.label}`}
          confirmLabel="确认删除"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async (reason) => {
            await resourceApi.remove(childType, deleting.id, reason);
            clearRefCache(childType);
            setDeleting(null);
            void reload();
          }}
        />
      )}
      <small className="muted">属于{parentDef.label}「{parent.title}」</small>
    </section>
  );
}

type Tab = 'info' | 'relations' | 'logs' | 'revenue' | 'flow' | 'storage' | 'contents' | 'metrics' | 'derived' | 'partner' | 'verify-history' | `child:${string}`;

/** 仓库岗位：商品档案只读，只能追加上传商品照片（旧仓库档案视图） */
function WarehousePhotoUpload({ record, onDone }: { record: ResourceDto; onDone: (r: ResourceDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function pick(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setMsg('');
    try {
      const ids: number[] = [];
      for (const f of Array.from(files)) ids.push((await resourceApi.uploadFile(record.type, 'photos', f)).id);
      onDone(await resourceApi.warehousePhotos(record.id, ids));
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '上传失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pill-row">
      <label className="secondary-button">
        {busy ? '上传中…' : '上传商品照片'}
        <input type="file" accept="image/*" multiple hidden disabled={busy} aria-label="上传商品照片" onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
      </label>
      {msg && <span role="alert" className="muted">{msg}</span>}
    </div>
  );
}

/** 归档确认框里的“关联摘要”：告诉操作人这条资料现在还关联着什么（归档不会动它们）。 */
/** 关联按对方资料类型分组（旧关联面板：店铺、自媒体、微信…各一块），同类型内保持原顺序 */
function groupRelations(relations: Relation[]): Array<[string, Relation[]]> {
  const by = new Map<string, Relation[]>();
  for (const r of relations) by.set(r.type, [...(by.get(r.type) ?? []), r]);
  return [...by.entries()];
}

function relationHint(relations: Relation[] | null): string {
  if (!relations || relations.length === 0) return '';
  const by = new Map<string, number>();
  for (const r of relations) by.set(typeLabel(r.type), (by.get(typeLabel(r.type)) ?? 0) + 1);
  return `现在关联着：${[...by].map(([k, n]) => `${k} ${n} 条`).join('、')}。`;
}

/** 输入框里敲字时，上下键不能抢走：只有焦点在空白处、表格行或详情本身时才切换记录。 */
function typingTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n || !n.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) || n.isContentEditable;
}

const HIDE_EMPTY_KEY = 'kudesi.detail.hideEmpty';

export function RecordDetail({ def, id, nav, onClose, onChanged, onCopy, initialTab }: { def: ResourceDef; id: number; /** 打开时直接显示的页签（如列表里的“成本明细”） */ initialTab?: string; nav?: DetailNav; onClose: () => void; onChanged: () => void; onCopy?: (values: Record<string, unknown>) => void }) {
  const can = useResourceCan(def.key);
  const canFeeView = useResourceCan('phones')('view');
  useUnitOptions();
  const { user: me } = useAuth();
  const canView = (t: string) => (me ? createChecker(me.permissions)(resourcePermission(permissionOwner(t), 'view')) : false);
  const [record, setRecord] = useState<ResourceDto | null>(null);
  const [tab, setTab] = useState<Tab>((initialTab as Tab | undefined) ?? 'info');
  const [wide, setWide] = useState(false);
  const [editGroup, setEditGroup] = useState<string | null>(null);
  const [linkDialog, setLinkDialog] = useState<'new' | EditableLink | null>(null);
  const [relations, setRelations] = useState<Relation[] | null>(null);
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [revising, setRevising] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const archivable = Boolean(archivePolicyOf(def.key));
  const [error, setError] = useState('');
  const [logLimit, setLogLimit] = useState(15);
  const [activeGroup, setActiveGroup] = useState('');
  const [hideEmpty, setHideEmptyState] = useState(() => { try { const v = localStorage.getItem(HIDE_EMPTY_KEY); return v === null ? def.key === 'finance-products' : v === '1'; } catch { return def.key === 'finance-products'; } }); // 商品档案没设过偏好时默认藏起空字段
  const setHideEmpty = (v: boolean) => { setHideEmptyState(v); try { localStorage.setItem(HIDE_EMPTY_KEY, v ? '1' : '0'); } catch { /* 不记住而已 */ } };
  const body = useRef<HTMLDivElement>(null);
  const loadSequence = useRef(0);
  const today = todayShanghai();

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const next = await resourceApi.get(def.key, id);
      if (sequence !== loadSequence.current) return;
      setRecord(next);
      setRelations(null);
      setLogs(null);
      setError('');
    } catch (e) {
      if (sequence !== loadSequence.current) return;
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [def.key, id]);
  useEffect(() => {
    setRecord(null);
    setError('');
    setRelations(null);
    setLogs(null);
    setEditing(false);
    setRevising(false);
    setDeleting(false);
    setRestoring(false);
    setLinkDialog(null);
    setTab((initialTab as Tab | undefined) ?? 'info');
    setLogLimit(15);
    setEditGroup(null);
    void load();
    return () => { loadSequence.current++; };
  }, [load, initialTab]);

  // 快捷键：Esc 关闭；↑ / ↓ 切换上一条、下一条（有弹窗、下拉、输入框在前面时让它们先处理）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'Escape' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if ([...document.querySelectorAll('[role="dialog"], [role="menu"], .inline-form')].some(el => !el.classList.contains('finance-detail-dialog'))) return;
      if (e.key === 'Escape') { onClose(); return; }
      if (typingTarget(e.target) || !nav) return;
      const go = e.key === 'ArrowUp' ? nav.onPrev : nav.onNext;
      if (go) { e.preventDefault(); go(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, nav]);

  useEffect(() => {
    let alive = true;
    if (record?.id === id && relations === null) resourceApi.relations(def.key, id).then(r => alive && setRelations(r)).catch(() => alive && setRelations([]));
    if (record?.id === id && tab === 'logs' && logs === null) resourceApi.logs(def.key, id).then(r => alive && setLogs(r)).catch(() => alive && setLogs([]));
    return () => { alive = false; };
  }, [tab, deleting, relations, logs, def.key, id, record]);

  if (!record || record.id !== id) {
    const missing = /不存在|404|not found/i.test(error);
    return (
      <aside className="rd" aria-label={`${def.label}详情`}>
        <header className="rd-head"><div className="rd-line"><button type="button" className="rd-back res-btn" onClick={onClose}>← 返回列表</button><span className="muted">{def.label}</span><span className="rd-gap" /><button type="button" className="res-btn icon" aria-label="关闭详情" onClick={onClose}>✕</button></div></header>
        {error
          ? <div className="rd-body"><div className="notice error" role="alert">{missing ? '这条资料已经不存在，可能已被删除。返回列表查看其他资料。' : `资料没有加载成功：${error}`}</div>{!missing && <button type="button" className="res-btn" onClick={() => void load()}>重新加载</button>}</div>
          : <div className="res-loading" role="status"><span className="res-spin" aria-hidden="true" />加载中…</div>}
      </aside>
    );
  }

  const groups = new Map<string, typeof def.fields[number][]>();
  if (def.key === 'finance-products') {
    // 商品档案：详情的分区、顺序、叫法和新增/编辑表单读同一份布局（product-layout）
    const canUse = (p: string) => Boolean(me && createChecker(me.permissions)(p));
    for (const sec of resolveProductSections(record.data, { canUse })) {
      const fields = sec.nodes.flatMap((n) => (n.kind === 'field' ? [n.field] : n.block === 'costSummary' ? [] : n.fields)).filter((f) => !f.listOnly);
      if (fields.length) groups.set(sec.title, fields);
    }
  }
  for (const f of def.key === 'finance-products' ? [] : def.fields) {
    if (f.permission && !(me && createChecker(me.permissions)(f.permission))) continue;
    if (f.listOnly) continue;
    if (f.showWhen && !f.showWhen.in.includes(String(f.showWhen.field === 'status' ? record.status : (record.data[f.showWhen.field] ?? '')))) continue;
    groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  }
  // 派生统计（配置 derivedColumns）：并进详情对应分区，只读（如税务的“月营业额 / 关联店铺数”）
  for (const d of def.derivedColumns ?? []) {
    if (record.data[d.key] === undefined) continue;
    const g = d.group ?? '统计';
    groups.set(g, [...(groups.get(g) ?? []), { key: d.key, label: d.label, type: d.kind === 'sum' && d.format === 'money' ? 'money' : 'number', group: g, readonly: true }]);
  }
  const filled = (f: typeof def.fields[number]) => (f.type === 'secret' ? Boolean(record.secretConfigured[f.key]) : displayValue(f, record) !== '');
  const sectionList = [...groups.entries()]
    .map(([group, fields]) => ({ group, fields, shown: hideEmpty ? fields.filter(filled) : fields }))
    .filter((s) => s.shown.length > 0 || editGroup === s.group);
  const tabs: Array<[Tab, string]> = [
    ['info', '详情'],
    ...(def.key === 'locations' ? ([['contents' as Tab, '存放内容']] as Array<[Tab, string]>) : []),
    ...(def.key === 'fixed-assets' ? ([['flow' as Tab, '流转记录'], ['storage' as Tab, '储物空间']] as Array<[Tab, string]>) : []),
    ['relations', relations && relations.length ? `关联 ${relations.length}` : '关联'],
    ...((def.children ?? []).map((c) => [`child:${c}|${getResourceDef(c)?.parent?.field}` as Tab, getResourceDef(c)?.label ?? c]) as Array<[Tab, string]>),
    ...((def.related ?? []).filter((r) => canView(r.type)).map((r) => [`child:${r.type}|${r.field}` as Tab, getResourceDef(r.type)?.label ?? r.type]) as Array<[Tab, string]>),
    ...(def.derivedStores && canView('stores') ? ([['derived' as Tab, '适用店铺']] as Array<[Tab, string]>) : []),
    ...(def.key === 'partners' ? ([['partner' as Tab, '法人主体与银行卡']] as Array<[Tab, string]>) : []),
    ...(def.key === 'licenses' && canView('store-daily-metrics') ? ([['revenue' as Tab, '营收']] as Array<[Tab, string]>) : []),
    ...(def.key === 'stores' ? ([['metrics' as Tab, '经营数据']] as Array<[Tab, string]>) : []),
    ...(def.key === 'finance-base-codes' ? ([['verify-history' as Tab, '验证历史']] as Array<[Tab, string]>) : []),
    ['logs', '操作记录'],
  ].filter(([key]) => !record.warehouseMode || key === 'info') as Array<[Tab, string]>;

  const secId = (g: string) => `sec-${def.key}-${id}-${g}`;
  const jump = (g: string) => { setActiveGroup(g); document.getElementById(secId(g))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); };
  const onBodyScroll = () => {
    const box = body.current;
    if (!box || tab !== 'info') return;
    const top = box.getBoundingClientRect().top + 24;
    let current = sectionList[0]?.group ?? '';
    for (const s of sectionList) { const el = document.getElementById(secId(s.group)); if (el && el.getBoundingClientRect().top <= top) current = s.group; }
    if (current !== activeGroup) setActiveGroup(current);
  };
  const reloadAll = () => { void load(); onChanged(); };
  const live = !record.archived;

  const statusSlot = live && def.key !== 'fixed-assets' && can('disable')
    ? <span className={`rd-status ${statusOf(def, record.status).tone === 'muted' ? 'warn' : statusOf(def, record.status).tone}`}><StatusControl def={def} id={record.id} current={record.status} onChanged={reloadAll} onError={setError} /></span>
    : undefined;

  const moreItems: Array<{ key: string; label: string; danger?: boolean; title?: string; run: () => void }> = [];
  if (record.archived && can('delete')) moreItems.push({ key: 'restore', label: '恢复…', run: () => setRestoring(true) });
  if (live && onCopy && can('create')) {
    moreItems.push({ key: 'copy', label: '复制新建', title: '按这条的内容新建一条，编码、图片不带过去', run: () => {
      const values = { ...copyValuesOf(def, record.data), ...(def.key === 'finance-products' ? { __copyOf: record.id } : {}) };
      onCopy(values);
    } });
  }
  if (live && can('delete')) moreItems.push({ key: 'delete', label: archivable ? '归档…' : '删除…', danger: true, run: () => setDeleting(true) });

  const phoneRecharge = live && def.key === 'phones' && can('edit') ? (
    <button type="button" className="res-btn" title="把最近充值日记为今天，下次充值日按充值周期自动更新" onClick={async () => {
      const t = todayShanghai();
      const cycle = Number(record.data.rechargeCycleDays) || 30;
      if (!window.confirm(`最近充值日记为 ${t}，下次充值日更新为 ${addDaysText(t, cycle)}。`)) return;
      try { setRecord(await resourceApi.update('phones', record.id, { lastRechargeAt: t })); setLogs(null); onChanged(); } catch (e) { setError(e instanceof ApiError ? e.message : '记录失败'); }
    }}>记录今天已充值</button>
  ) : null;
  const assetBar = def.key === 'fixed-assets' && live && can('edit') ? <AssetActionBar record={record} onDone={reloadAll} /> : null;
  // 手机号 / 宽带的费用都汇总在“费用模块”里；这里给一个反向入口（搜这个号码 / 这条宽带）
  const feeLink = (def.key === 'phones' || def.key === 'broadband') && canFeeView ? (
    <Link className="res-btn" to={`/resource/fee-settings?tab=${def.key === 'phones' ? 'all' : 'broadband'}&q=${encodeURIComponent(record.title)}`} title="在费用模块里查看这条的费用、主子卡和绑定关系">在费用模块查看</Link>
  ) : null;
  const quick = phoneRecharge || assetBar || feeLink || record.warehouseMode ? <>{phoneRecharge}{feeLink}{assetBar}{record.warehouseMode && <WarehousePhotoUpload record={record} onDone={(r) => { setRecord(r); onChanged(); }} />}</> : undefined;

  const finance = FINANCE_DETAIL_TYPES.has(def.key);
  const Frame = finance ? FinanceDetailBackdrop : Fragment;
  const financeLabel = referenceRecordLabel(def.key, record.data);
  const baseCopy = def.key === 'finance-base-codes' && !record.data.canonicalId ? moreItems.find(item => item.key === 'copy') : undefined;
  const financeMore = [...moreItems.filter(item => item !== baseCopy), ...tabs.filter(([key]) => key !== 'info').map(([key, label]) => ({ key: `tab-${key}`, label, run: () => setTab(key) }))];

  return (
    <Frame><aside className={finance ? `rd finance-detail-dialog finance-detail-${def.key === 'finance-products' ? String(record.data.archiveType) : def.key}` : wide ? 'rd rd-wide' : 'rd'} aria-label={`${def.label}详情`} role={finance ? 'dialog' : undefined} aria-modal={finance ? true : undefined}>
      {finance ? <FinanceDetailHead def={def} record={record} nav={nav} onClose={onClose} /> : <DetailHead
        def={def}
        record={record}
        nav={nav}
        wide={wide}
        onToggleWide={() => setWide((v) => !v)}
        onClose={onClose}
        statusSlot={statusSlot}
        primary={live && can('edit') ? <button type="button" className="res-btn primary" onClick={() => setEditing(true)}>编辑</button> : undefined}
        more={moreItems.length > 0 ? (
          <MoreMenu items={moreItems} />
        ) : undefined}
        quick={quick}
        canSee={(f) => !f.permission || Boolean(me && createChecker(me.permissions)(f.permission))}
      />}
      {(!finance || tab !== 'info') && <div role="tablist" aria-label="详情分区" className="rd-tabs">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'rd-tab active' : 'rd-tab'} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>}
      <div className={finance ? 'rd-body finance-detail-body' : 'rd-body'} ref={body} onScroll={onBodyScroll}>
        {error && <div role="alert" className="notice error">{error}</div>}
        {finance && tab === 'info' && <FinanceDetailBody key={`${def.key}:${record.id}`} def={def} record={record} />}
        {!finance && tab === 'info' && (
          <div className={def.key === 'finance-products' ? 'rd-info rd-p' : 'rd-info'}>
            {sectionList.length > 1 && (
              <nav aria-label="分区导航" className="rd-anchors">
                {sectionList.map((s) => (
                  <button key={s.group} type="button" className={`rd-anchor${(activeGroup || sectionList[0].group) === s.group ? ' active' : ''}`} onClick={() => jump(s.group)}>{groupTitle(def, s.group, record.data)}</button>
                ))}
                <label className="rd-hide-empty check"><input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> 隐藏空字段</label>
              </nav>
            )}
            <div className="rd-sections">
              {def.key === 'finance-products' && <ProductCostSummary def={def} record={record} />}
              <BankCopyAll def={def} record={record} />
              {def.key === 'licenses' && can('edit') && <LinkExistingStoresButton license={record} onDone={reloadAll} onError={setError} />}
              {def.key === 'stores' && can('edit') && (
                <div className="rd-actions"><StoreAssignButton record={record} onDone={reloadAll} onError={setError} /> <StoreReleaseButton record={record} onDone={reloadAll} onError={setError} /></div>
              )}
              {def.key === 'bank-accounts' && (
                <PhoneArchiveButton type="bank-accounts" record={record} numberKey="reservedPhoneNumber" idKey="phoneId" holder={String(record.data.reservedPhoneHolder ?? '')} onDone={reloadAll} onError={setError} />
              )}
              {def.key === 'partners' && (
                <PhoneArchiveButton type="partners" record={record} numberKey="cardPhone" idKey="cardPhoneId" holder={String(record.data.cardPhoneHolder ?? record.title)} onDone={reloadAll} onError={setError} />
              )}
              {def.key === 'duty-groups' && <DutyGroupSummary groupId={record.id} departmentLabel={record.refLabels.departmentId ?? ''} />}
              {def.key === 'workforce' && <WorkforceAccountNote />}
              {sectionList.map(({ group, fields, shown }) => (
                <section key={group} id={secId(group)} className="rd-sec">
                  <h3 className="rd-sec-title">
                    <span>{groupTitle(def, group, record.data)}</span>
                    {can('edit') && !record.archived && editGroup !== group && fields.some((f) => !f.readonly) && (
                      <button type="button" className="link-button" aria-label={`编辑${group}`} onClick={() => setEditGroup(group)}>编辑本区</button>
                    )}
                  </h3>
                  {editGroup === group ? (
                    <RecordForm
                      def={def}
                      record={record}
                      onlyGroup={group}
                      inline
                      onClose={() => setEditGroup(null)}
                      onSaved={(dto) => { setEditGroup(null); setRecord(dto); setLogs(null); setRelations(null); onChanged(); }}
                    />
                  ) : (
                    <dl className="rd-grid">
                      {shown.map((f) => (
                        <div key={f.key} className={`rd-item${['textarea', 'files', 'attrs', 'json'].includes(f.type) ? ' wide' : ''}`}>
                          <dt>{f.label}</dt>
                          <dd>
                            {f.type === 'secret' ? (
                              <SecretCell def={def} record={record} fieldKey={f.key} />
                            ) : f.type === 'files' ? (
                              <FileList ids={Array.isArray(record.data[f.key]) ? (record.data[f.key] as number[]) : []} files={record.files} />
                            ) : f.key === 'storeCount' ? (
                              <StoresPopButton licenseId={def.key === 'licenses' ? record.id : (typeof record.data.licenseId === 'number' ? record.data.licenseId : null)} count={Number(record.data.storeCount ?? 0)} />
                            ) : (
                              <InfoValue def={def} f={f} record={record} canView={canView} today={today} />
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </section>
              ))}
              {sectionList.length === 0 && <p className="muted">这条资料还没有填写任何内容。</p>}
            </div>
          </div>
        )}
        {tab === 'relations' && (
          <section className="rd-panel">
            <h3 className="rd-sec-title"><span>关联关系</span>{can('edit') && <button type="button" className="res-btn sm" onClick={() => setLinkDialog('new')}>添加关联</button>}</h3>
            {relations === null && <p className="muted">加载中…</p>}
            {relations?.length === 0 && <p className="muted">没有关联</p>}
            {relations && relations.length > 0 && groupRelations(relations).map(([t, list]) => (
              <div key={t} className="rd-rel-group">
                <h4 className="rd-rel-title">{typeLabel(t)}<i>{list.length}</i></h4>
                {list.map((r) => (
                  <div key={`${r.direction}-${r.relation}-${r.type}-${r.id}-${r.linkId ?? ''}`} className="line-item between">
                    <span>
                      <small className="muted">{r.relation === 'manual' ? '手动关联' : r.relationLabel ?? (r.direction === 'out' ? '指向' : '被引用于')}{r.relation !== 'manual' && r.direction === 'in' && r.relationLabel ? '（由对方维护）' : ''}</small>{' '}
                      {recordLink(r.type, r.id) && canView(r.type) ? <Link to={recordLink(r.type, r.id)!}>{r.title}</Link> : r.title}
                      {r.summary && <small className="muted rd-rel-sum"> {r.summary}</small>}
                    </span>
                    {r.relation === 'manual' && (r.purpose || r.relationKind || r.validFrom || r.validTo) && (
                      <small className="muted">{r.purpose || r.relationKind ? `${(() => { const p = parsePurpose(r.purpose, r.relationKind); return `${relationKindLabel(p.kind, def.key, r.type)}${p.text ? `：${p.text}` : ''}`; })()} ` : ''}{r.validFrom || r.validTo ? `有效期 ${r.validFrom ?? '…'} ~ ${r.validTo ?? '长期'}` : ''}</small>
                    )}
                    {r.relation === 'manual' && r.linkId && can('edit') && (
                      <button type="button" className="link-button" onClick={() => setLinkDialog({ linkId: r.linkId!, targetType: r.type, title: r.title, purpose: r.purpose, relationKind: r.relationKind, validFrom: r.validFrom, validTo: r.validTo })}>改属性</button>
                    )}
                    {r.relation === 'manual' && r.linkId && can('edit') && (
                      <button type="button" className="link-button" onClick={() => { if (window.confirm(`取消和「${r.title}」的关联？`)) resourceApi.removeLink(def.key, id, r.linkId!).then(() => setRelations(null)).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败')); }}>取消关联</button>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {linkDialog && <RelationDialog type={def.key} id={id} link={linkDialog === 'new' ? undefined : linkDialog} canView={canView} onClose={() => setLinkDialog(null)} onSaved={() => { setLinkDialog(null); setRelations(null); }} />}
          </section>
        )}
        {tab.startsWith('child:') && <ChildPanel key={tab} parentDef={def} parent={record} childType={tab.slice(6).split('|')[0]} field={tab.split('|')[1]} />}
        {tab === 'revenue' && <RevenuePanel licenseId={record.id} />}
        {tab === 'contents' && <LocationContentsPanel id={record.id} />}
        {tab === 'flow' && <AssetFlowPanel record={record} version={record.updatedAt} />}
        {tab === 'storage' && <AssetStoragePanel record={record} />}
        {tab === 'metrics' && <StoreMetricsPanel store={record} />}
        {tab === 'derived' && def.derivedStores && <DerivedStoresPanel licenseId={typeof record.data[def.derivedStores] === 'number' ? (record.data[def.derivedStores] as number) : null} />}
        {tab === 'partner' && <PartnerSubjectPanel partner={record} onChanged={reloadAll} />}
        {tab === 'verify-history' && <VerificationHistoryPanel id={record.id} />}
        {tab === 'logs' && (
          <section className="rd-panel">
            <h3 className="rd-sec-title"><span>操作记录</span></h3>
            {logs === null && <p className="muted">加载中…</p>}
            {logs?.length === 0 && <p className="muted">暂无记录</p>}
            {logs?.slice(0, logLimit).map((l) => (
              <div key={l.id} className="log-item">
                <div className="between"><strong>{ACTION_LABEL[l.action] ?? l.action}</strong><small className="muted">{new Date(l.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></div>
                <small className="muted">{l.actor || '系统'}{l.note ? ` · ${l.note}` : ''}</small>
                <LogChanges def={def} log={l} />
              </div>
            ))}
            {logs && logs.length > logLimit && <button type="button" className="link-button" onClick={() => setLogLimit((n) => n + 15)}>显示更早的 {Math.min(15, logs.length - logLimit)} 条</button>}
          </section>
        )}
      </div>
      {finance && <footer className="finance-detail-foot">
        {['finance-base-codes', 'finance-bundles'].includes(def.key) && <small>{record.updatedAt ? `最后更新：${new Date(record.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : ''}</small>}
        <div className="finance-detail-foot-actions">
          {baseCopy && <button type="button" className="secondary-button" onClick={baseCopy.run}>复制新建</button>}
          {def.key === 'finance-base-codes' && statusSlot}
          {def.key === 'finance-products' && <button type="button" className="secondary-button" onClick={onClose}>关闭</button>}
          {live && can('edit') && <button type="button" className="primary-button" onClick={() => setEditing(true)}>{def.key === 'finance-products' ? `编辑${financeLabel}` : def.key === 'finance-bundles' ? '修改' : '编辑'}</button>}
          {live && def.key === 'finance-bundles' && can('edit') && <button type="button" className="secondary-button" onClick={() => setRevising(true)}>修改组成</button>}
          {quick}
          {financeMore.length > 0 && <MoreMenu items={financeMore} />}
          {def.key !== 'finance-products' && <button type="button" className="secondary-button" onClick={onClose}>关闭</button>}
        </div>
      </footer>}
      {revising && <RevisionDialog bundle={record} onClose={() => setRevising(false)} onDone={() => { setRevising(false); reloadAll(); }} />}
      {restoring && (
        <ReasonDialog
          title={`恢复${def.label}`}
          hint={`恢复后回到归档前的状态${record.archived?.fromStatus ? `（${statusOf(def, record.archived.fromStatus)?.label ?? record.archived.fromStatus}）` : ''}，关联关系原样保留。`}
          confirmLabel="确认恢复"
          onClose={() => setRestoring(false)}
          onConfirm={async (reason) => {
            await resourceApi.restore(def.key, record.id, reason);
            clearRefCache(def.key);
            setRestoring(false);
            await load();
            onChanged();
          }}
        />
      )}
      {editing && (
        <RecordForm
          def={def}
          record={record}
          onClose={() => setEditing(false)}
          onSaved={(dto) => {
            setEditing(false);
            setRecord(dto);
            setLogs(null);
            setRelations(null);
            onChanged();
          }}
        />
      )}
      {deleting && (
        <ReasonDialog
          title={`${archivable ? '归档' : '删除'}${def.label}`}
          hint={archivable
            ? `归档后不再出现在日常列表，但这条资料的关联和历史记录原样保留，可在「已归档」里恢复。${relationHint(relations)}`
            : '删除后无法恢复。还被其他资料引用时不能删除，请先解除引用，或改为停用。'}
          confirmLabel={archivable ? '确认归档' : '确认删除'}
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async (reason) => {
            await resourceApi.remove(def.key, record.id, reason);
            clearRefCache(def.key);
            setDeleting(false);
            onChanged();
            onClose();
          }}
        />
      )}
    </aside></Frame>
  );
}

/** “更多”菜单：复制新建、归档/删除、恢复这类不常点的操作收在这里。 */
function MoreMenu({ items }: { items: Array<{ key: string; label: string; danger?: boolean; title?: string; run: () => void }> }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="res-pop-wrap" ref={wrap}>
      <button type="button" className="res-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>更多<ChevronDown /></button>
      {open && (
        <div className="res-pop right res-more" role="menu" aria-label="更多操作">
          {items.map((it) => (
            <button key={it.key} type="button" role="menuitem" className={it.danger ? 'danger' : undefined} title={it.title} onClick={() => { setOpen(false); it.run(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

