import { useCallback, useEffect, useState } from 'react';
import { useUnitOptions } from './unitOptions';
import { ASSET_LOG_LABELS, RESOURCE_DEFS, addDaysText, dueBadgeFor, todayShanghai, archivePolicyOf, createChecker, getResourceDef, permissionOwner, resourcePermission, type ResourceAction, type ResourceDef } from '@kudesi/shared';
import { Link } from 'react-router-dom';
import { recordLink } from './recordLink';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { VerificationHistoryPanel } from './VerificationHistoryPanel';
import { FileList } from './FilesField';
import { resourceApi, type LogEntry, type Relation, type ResourceDto } from './api';
import { displayValue, statusOf } from './format';
import { RelationDialog, parsePurpose, type EditableLink } from './RelationDialog';
import { ReasonDialog, RecordForm, clearRefCache, loadRefOptions } from './RecordForm';
import { StatusControl, typeLabel } from './StatusControl';
import { RevenuePanel } from './RevenuePanel';
import { CopyButton, copyText, isCopyable, urlOf } from './CopyValue';
import { LinkExistingStoresButton } from './LicenseActions';
import { DutyGroupSummary } from './DutyGroupSummary';
import { KeyFacts } from './KeyFacts';
import { AssetActionBar, AssetFlowPanel, AssetStoragePanel, LocationContentsPanel } from './AssetPanels';
import { StoreMetricsPanel } from './StoreMetricsPanel';
import { ProductCostSummary } from './ProductCostSummary';
import { DerivedStoresPanel, PartnerSubjectPanel, PhoneArchiveButton, ReturnBorrowButton, StoreAssignButton, StoreReleaseButton } from './CertPanels';

export function useResourceCan(type: string) {
  const { user } = useAuth();
  const check = user ? createChecker(user.permissions) : () => false;
  return (action: ResourceAction) => check(resourcePermission(permissionOwner(type), action));
}

const ACTION_LABEL: Record<string, string> = {
  import: '导入', link: '绑定关联', unlink: '解除关联', link_update: '修改关联信息',
  create: '新建', update: '修改', status: '改状态', delete: '删除', reveal: '查看明文', archived: '归档', restored: '恢复',
  ...ASSET_LOG_LABELS,
};

/** 归档确认框里的“关联摘要”：告诉操作人这条资料现在还关联着什么（归档不会动它们）。 */
function relationHint(relations: Relation[] | null): string {
  if (!relations || relations.length === 0) return '';
  const by = new Map<string, number>();
  for (const r of relations) by.set(typeLabel(r.type), (by.get(typeLabel(r.type)) ?? 0) + 1);
  return `现在关联着：${[...by].map(([k, n]) => `${k} ${n} 条`).join('、')}。`;
}

function SecretCell({ def, record, fieldKey }: { def: ResourceDef; record: ResourceDto; fieldKey: string }) {
  const can = useResourceCan(def.key);
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(0);
  const shown = record.secretConfigured[fieldKey] ? '••••••' : '';
  useEffect(() => {
    if (value === null) return;
    setLeft(30); // 明文只显示 30 秒（旧系统同款），倒计时给人看
    const t = setInterval(() => setLeft((n) => {
      if (n <= 1) { setValue(null); setCopied(false); return 0; }
      return n - 1;
    }), 1000);
    return () => clearInterval(t);
  }, [value]);
  // 换了一条记录，上一条的明文立刻收起
  useEffect(() => { setValue(null); setCopied(false); setError(''); }, [record.id]);
  if (!record.secretConfigured[fieldKey]) return <span className="muted">未设置</span>;
  return (
    <span className="secret-cell">
      <span className="mono">{value ?? shown}</span>{' '}
      {value !== null && <small className="muted">{left} 秒后隐藏 </small>}
      {can('secret') &&
        (value === null ? (
          <button
            type="button"
            className="link-button"
            onClick={async () => {
              try {
                setValue((await resourceApi.reveal(def.key, record.id, fieldKey)).value);
              } catch (e) {
                setError(e instanceof ApiError ? (e.message || '没有查看这项敏感信息的权限，请联系管理员开通。') : '读取失败，请稍后重试。');
              }
            }}
          >
            查看（会留记录）
          </button>
        ) : (
          <>
            <button type="button" className="link-button" onClick={() => { void copyText(value).then((ok) => (ok ? setCopied(true) : setError('浏览器不允许复制，请手动选中后复制。'))); }}>{copied ? '已复制' : '复制'}</button>{' '}
            <button type="button" className="link-button" onClick={() => { setValue(null); setCopied(false); }}>隐藏</button>
          </>
        ))}
      {error && <small className="bad-text"> {error}</small>}
    </span>
  );
}

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

function ChildPanel({ parentDef, parent, childType, field }: { parentDef: ResourceDef; parent: ResourceDto; childType: string; field: string }) {
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
  const cols = def.fields.filter((f) => f.list && f.key !== field);
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
          <small className="muted">{cols.map((f) => displayValue(f, it)).filter(Boolean).join(' · ')}</small>
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

export function RecordDetail({ def, id, onClose, onChanged, onCopy }: { def: ResourceDef; id: number; onClose: () => void; onChanged: () => void; onCopy?: (values: Record<string, unknown>) => void }) {
  const can = useResourceCan(def.key);
  useUnitOptions();
  const { user: me } = useAuth();
  const canView = (t: string) => (me ? createChecker(me.permissions)(resourcePermission(permissionOwner(t), 'view')) : false);
  const [record, setRecord] = useState<ResourceDto | null>(null);
  const [tab, setTab] = useState<Tab>('info');
  const [linkDialog, setLinkDialog] = useState<'new' | EditableLink | null>(null);
  const [relations, setRelations] = useState<Relation[] | null>(null);
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const archivable = Boolean(archivePolicyOf(def.key));
  const [error, setError] = useState('');
  const [logLimit, setLogLimit] = useState(15);
  const today = todayShanghai();

  const load = useCallback(async () => {
    try {
      setRecord(await resourceApi.get(def.key, id));
      setRelations(null);
      setLogs(null);
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    }
  }, [def.key, id]);
  useEffect(() => {
    setTab('info');
    setLogLimit(15);
    void load();
  }, [load]);

  // Esc 关闭详情（有弹窗、下拉在前面时先让它们处理）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (record && relations === null) resourceApi.relations(def.key, id).then(setRelations).catch(() => setRelations([]));
    if (tab === 'logs' && logs === null) resourceApi.logs(def.key, id).then(setLogs).catch(() => setLogs([]));
  }, [tab, deleting, relations, logs, def.key, id, record]);

  if (!record) {
    const missing = /不存在|404|not found/i.test(error);
    return (
      <aside className="drawer card" aria-label={`${def.label}详情`}>
        <div className="drawer-head between"><span className="muted">{def.label}</span><button type="button" className="icon-button" aria-label="关闭详情" onClick={onClose}>✕</button></div>
        {error
          ? <div className="drawer-body"><div className="notice error" role="alert">{missing ? '这条资料已经不存在，可能已被删除。返回列表查看其他资料。' : `资料没有加载成功：${error}`}</div>{!missing && <button type="button" className="secondary-button" onClick={() => void load()}>重新加载</button>}</div>
          : <div className="empty-state muted">加载中…</div>}
      </aside>
    );
  }

  const st = statusOf(def, record.status);
  const groups = new Map<string, typeof def.fields[number][]>();
  for (const f of def.fields) {
    if (f.permission && !(me && createChecker(me.permissions)(f.permission))) continue;
    if (f.showWhen && !f.showWhen.in.includes(String(f.showWhen.field === 'status' ? record.status : (record.data[f.showWhen.field] ?? '')))) continue;
    groups.set(f.group, [...(groups.get(f.group) ?? []), f]);
  }
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

  return (
    <aside className="drawer card" aria-label={`${def.label}详情`}>
      <div className="drawer-head">
        <div className="between">
          <span className="muted">{def.label}</span>
          <button type="button" className="drawer-back secondary-button" onClick={onClose}>← 返回列表</button>
          <button type="button" className="icon-button" aria-label="关闭详情" onClick={onClose}>✕</button>
        </div>
        <div className="drawer-title">{record.title}</div>
        <div className="pill-row">
          <span className={`pill ${st.tone === 'muted' ? 'warn' : st.tone}`}>{st.label}</span>
          {record.statusReason && <span className="muted">原因：{record.statusReason}</span>}
          {record.archived && <span className="muted">已归档{record.archived.reason ? `：${record.archived.reason}` : ''}（{new Date(record.archived.at).toLocaleDateString('zh-CN')}）</span>}
        </div>
        <KeyFacts def={def} record={record} canSee={(f) => !f.permission || Boolean(me && createChecker(me.permissions)(f.permission))} />
      </div>
      <div role="tablist" aria-label="详情分区" className="tabs">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'tab active' : 'tab'} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="drawer-body">
        {error && <div role="alert" className="notice error">{error}</div>}
        {record.warehouseMode && <WarehousePhotoUpload record={record} onDone={(r) => { setRecord(r); onChanged(); }} />}
        {tab === 'info' && def.key === 'finance-products' && <ProductCostSummary def={def} record={record} />}
        {tab === 'info' && <BankCopyAll def={def} record={record} />}
        {tab === 'info' &&
          [...groups.entries()].map(([group, fields]) => (
            <section key={group}>
              <h2 className="section-title">{group}</h2>
              <dl className="kv">
                {fields.map((f) => (
                  <FragmentRow key={f.key} label={f.label}>
                    {f.type === 'secret' ? (
                      <SecretCell def={def} record={record} fieldKey={f.key} />
                    ) : f.type === 'files' ? (
                      <FileList ids={Array.isArray(record.data[f.key]) ? (record.data[f.key] as number[]) : []} files={record.files} />
                    ) : (
                      <InfoValue def={def} f={f} record={record} canView={canView} today={today} />
                    )}
                  </FragmentRow>
                ))}
              </dl>
            </section>
          ))}
        {tab === 'info' && def.key === 'bank-accounts' && (
          <PhoneArchiveButton type="bank-accounts" record={record} numberKey="reservedPhoneNumber" idKey="phoneId" holder={String(record.data.reservedPhoneHolder ?? '')} onDone={() => { void load(); onChanged(); }} onError={setError} />
        )}
        {tab === 'info' && def.key === 'licenses' && can('edit') && <LinkExistingStoresButton license={record} onDone={() => { void load(); onChanged(); }} onError={setError} />}
        {tab === 'info' && def.key === 'duty-groups' && <DutyGroupSummary groupId={record.id} />}
        {tab === 'info' && def.key === 'stores' && can('edit') && (
          <><StoreAssignButton record={record} onDone={() => { void load(); onChanged(); }} onError={setError} /> <StoreReleaseButton record={record} onDone={() => { void load(); onChanged(); }} onError={setError} /></>
        )}
        {tab === 'info' && def.key === 'partners' && (
          <PhoneArchiveButton type="partners" record={record} numberKey="cardPhone" idKey="cardPhoneId" holder={String(record.data.cardPhoneHolder ?? record.title)} onDone={() => { void load(); onChanged(); }} onError={setError} />
        )}
        {tab === 'relations' && (
          <section>
            <h2 className="section-title">关联关系</h2>
            {relations === null && <p className="muted">加载中…</p>}
            {relations?.length === 0 && <p className="muted">没有关联</p>}
            {relations?.map((r) => (
              <div key={`${r.direction}-${r.relation}-${r.type}-${r.id}-${r.linkId ?? ''}`} className="line-item between">
                <span>
                  <small className="muted">{r.relation === 'manual' ? '手动关联' : r.direction === 'out' ? '指向' : '被引用于'} · {typeLabel(r.type)}</small>{' '}
                  {recordLink(r.type, r.id) && canView(r.type) ? <Link to={recordLink(r.type, r.id)!}>{r.title}</Link> : r.title}
                </span>
                {r.relation === 'manual' && (r.purpose || r.validFrom || r.validTo) && (
                  <small className="muted">{r.purpose ? `${(() => { const p = parsePurpose(r.purpose); return `${p.kind}${p.text ? `：${p.text}` : ''}`; })()} ` : ''}{r.validFrom || r.validTo ? `有效期 ${r.validFrom ?? '…'} ~ ${r.validTo ?? '长期'}` : ''}</small>
                )}
                {r.relation === 'manual' && r.linkId && can('edit') && (
                  <button type="button" className="link-button" onClick={() => setLinkDialog({ linkId: r.linkId!, title: r.title, purpose: r.purpose, validFrom: r.validFrom, validTo: r.validTo })}>改属性</button>
                )}
                {r.relation === 'manual' && r.linkId && can('edit') && (
                  <button type="button" className="link-button" onClick={() => { if (window.confirm(`取消和「${r.title}」的关联？`)) resourceApi.removeLink(def.key, id, r.linkId!).then(() => setRelations(null)).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败')); }}>取消关联</button>
                )}
              </div>
            ))}
            {can('edit') && <button type="button" className="secondary-button" style={{ marginTop: 12 }} onClick={() => setLinkDialog('new')}>添加关联</button>}
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
        {tab === 'partner' && <PartnerSubjectPanel partner={record} onChanged={() => { void load(); onChanged(); }} />}
        {tab === 'verify-history' && <VerificationHistoryPanel id={record.id} />}
        {tab === 'logs' && (
          <section>
            <h2 className="section-title">操作记录</h2>
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
      <div className="drawer-foot">
        {record.archived && can('delete') && <button type="button" className="secondary-button" onClick={() => setRestoring(true)}>恢复…</button>}
        {!record.archived && def.key === 'phones' && can('edit') && (
          <button type="button" className="secondary-button" title="把最近充值日记为今天，下次充值日按充值周期自动更新" onClick={async () => {
            const today = todayShanghai();
            const cycle = Number(record.data.rechargeCycleDays) || 30;
            if (!window.confirm(`最近充值日记为 ${today}，下次充值日更新为 ${addDaysText(today, cycle)}。`)) return;
            try { setRecord(await resourceApi.update('phones', record.id, { lastRechargeAt: today })); setLogs(null); onChanged(); } catch (e) { setError(e instanceof ApiError ? e.message : '记录失败'); }
          }}>记录今天已充值</button>
        )}
        {!record.archived && can('edit') && <button type="button" className="secondary-button" onClick={() => setEditing(true)}>编辑</button>}
        {!record.archived && onCopy && can('create') && (
          <button type="button" className="secondary-button" title="按这条的内容新建一条，编码、图片不带过去" onClick={() => {
            const values: Record<string, unknown> = {};
            for (const f of def.fields) {
              if (f.readonly || f.type === 'files' || f.type === 'secret' || f.type === 'sensitive' || f.key === 'code' || f.key === def.uniqueField || def.copyOmit?.includes(f.key)) continue;
              const v = record.data[f.key];
              if (v !== undefined && v !== null && v !== '') values[f.key] = v;
            }
            onCopy(values);
          }}>复制新建</button>
        )}
        {def.key === 'fixed-assets' ? (
          !record.archived && can('edit') && <AssetActionBar record={record} onDone={() => { void load(); onChanged(); }} />
        ) : !record.archived && can('disable') && (
          <StatusControl def={def} id={record.id} current={record.status} onChanged={() => { void load(); onChanged(); }} onError={setError} />
        )}
        {!record.archived && can('delete') && <button type="button" className="secondary-button danger" onClick={() => setDeleting(true)}>{archivable ? '归档…' : '删除…'}</button>}
      </div>
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
    </aside>
  );
}

/** 供应商等有开户名/开户行/账号的资料：一键复制整组银行信息，付款对账时直接粘贴。 */
function BankCopyAll({ def, record }: { def: ResourceDef; record: ResourceDto }) {
  const d = record.data;
  if (!def.fields.some((f) => f.key === 'bankAccountNo') || !d.bankAccountNo) return null;
  const text = [`户名：${String(d.bankAccountName ?? record.title)}`, `开户行：${String(d.bank ?? '')}`, `账号：${String(d.bankAccountNo)}`].join('\n');
  return <div className="pill-row"><span className="muted">银行信息</span><CopyButton value={text} label="全部银行信息" /></div>;
}

/** 详情里一个字段的值：编号/账号/手机号类带“复制”，引用的资料可点进去，到期日期带提醒角标。 */
function InfoValue({ def, f, record, canView, today }: { def: ResourceDef; f: ResourceDef['fields'][number]; record: ResourceDto; canView: (t: string) => boolean; today: string }) {
  const text = displayValue(f, record);
  if (!text) return <span className="muted">—</span>;
  const url = urlOf(f, text);
  if ((f.type === 'ref' || f.type === 'refs') && f.ref && f.ref !== 'user' && canView(f.ref)) {
    const raw = record.data[f.key];
    const ids = (Array.isArray(raw) ? raw : [raw]).filter((x): x is number => typeof x === 'number');
    const labels = text.split('、');
    if (ids.length === labels.length) {
      return <>{ids.map((id, i) => {
        const to = recordLink(f.ref!, id);
        return <span key={id}>{i > 0 && '、'}{to ? <Link to={to}>{labels[i]}</Link> : labels[i]}</span>;
      })}</>;
    }
  }
  const due = dueBadgeFor(def.key, f.key, record.data, record.status, today);
  return (
    <>
      {url ? <a href={url} target="_blank" rel="noopener noreferrer">{text}</a> : f.type === 'textarea' ? <span className="pre-wrap">{text}</span> : text}
      {isCopyable(def, f) && <> <CopyButton value={text} label={f.label} /></>}
      {due && <> <span className={`pill ${due.level === 'expired' ? 'bad' : 'warn'}`}>{due.text}</span></>}
    </>
  );
}

const SKIP_DIFF_TYPES = new Set(['secret', 'sensitive', 'files', 'attrs', 'json']);
/** 变更记录里“哪些字段从什么改成什么”：只列普通字段；密码/证件号/文件等不显示具体值。 */
function LogChanges({ def, log }: { def: ResourceDef; log: LogEntry }) {
  if (log.action !== 'update' || !log.before || !log.after) return null;
  const rows: Array<{ label: string; from: string; to: string | null }> = [];
  for (const f of def.fields) {
    const a = log.before[f.key];
    const b = log.after[f.key];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    if (!(f.key in log.before) && !(f.key in log.after)) continue;
    if (SKIP_DIFF_TYPES.has(f.type) || f.type === 'ref' || f.type === 'refs' || f.type === 'money') { rows.push({ label: f.label, from: '', to: null }); continue; }
    const show = (v: unknown) => (v === undefined || v === null || v === '' ? '（空）' : f.type === 'select' ? (f.options?.find((o) => o.value === v)?.label ?? String(v)) : f.type === 'bool' ? (v ? '是' : '否') : String(v));
    rows.push({ label: f.label, from: show(a), to: show(b) });
  }
  if (!rows.length) return null;
  return (
    <ul className="log-changes">
      {rows.map((r) => <li key={r.label}>{r.to === null ? <>{r.label}：已修改</> : <>{r.label}：{r.from} → {r.to}</>}</li>)}
    </ul>
  );
}

function FragmentRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
