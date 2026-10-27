import { useCallback, useEffect, useState } from 'react';
import { useUnitOptions } from './unitOptions';
import { ASSET_LOG_LABELS, RESOURCE_DEFS, addDaysText, todayShanghai, archivePolicyOf, createChecker, getResourceDef, permissionOwner, resourcePermission, type ResourceAction, type ResourceDef } from '@kudesi/shared';
import { Link } from 'react-router-dom';
import { recordLink } from './recordLink';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { VerificationHistoryPanel } from './VerificationHistoryPanel';
import { FileList } from './FilesField';
import { resourceApi, type LogEntry, type Relation, type ResourceDto } from './api';
import { displayValue, statusOf } from './format';
import { ReasonDialog, RecordForm, clearRefCache, loadRefOptions } from './RecordForm';
import { StatusControl, typeLabel } from './StatusControl';
import { RevenuePanel } from './RevenuePanel';
import { CopyButton, isCopyable } from './CopyValue';
import { KeyFacts } from './KeyFacts';
import { AssetActionBar, AssetFlowPanel, AssetStoragePanel, LocationContentsPanel } from './AssetPanels';
import { StoreMetricsPanel } from './StoreMetricsPanel';
import { ProductCostSummary } from './ProductCostSummary';
import { DerivedStoresPanel, PartnerSubjectPanel, PhoneArchiveButton, ReturnBorrowButton, StoreReleaseButton } from './CertPanels';

export function useResourceCan(type: string) {
  const { user } = useAuth();
  const check = user ? createChecker(user.permissions) : () => false;
  return (action: ResourceAction) => check(resourcePermission(permissionOwner(type), action));
}

const ACTION_LABEL: Record<string, string> = {
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
  const shown = record.secretConfigured[fieldKey] ? '••••••' : '';
  useEffect(() => {
    if (value === null) return;
    const t = setTimeout(() => setValue(null), 30000); // 明文只显示 30 秒（旧系统同款）
    return () => clearTimeout(t);
  }, [value]);
  if (!record.secretConfigured[fieldKey]) return <span className="muted">未设置</span>;
  return (
    <span className="secret-cell">
      <span className="mono">{value ?? shown}</span>{' '}
      {can('secret') &&
        (value === null ? (
          <button
            type="button"
            className="link-button"
            onClick={async () => {
              try {
                setValue((await resourceApi.reveal(def.key, record.id, fieldKey)).value);
              } catch (e) {
                setError(e instanceof ApiError ? e.message : '查看失败');
              }
            }}
          >
            查看（会留记录）
          </button>
        ) : (
          <>
            <button type="button" className="link-button" onClick={() => { void navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => setError('复制失败，请手动选中复制')); }}>{copied ? '已复制' : '复制'}</button>{' '}
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
            <strong>{it.title}{childType === 'finance-product-costs' && isCurrentCost(it, items) && <span className="pill ok"> 当前生效</span>}</strong>
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
  const [relations, setRelations] = useState<Relation[] | null>(null);
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const archivable = Boolean(archivePolicyOf(def.key));
  const [error, setError] = useState('');

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
    void load();
  }, [load]);

  useEffect(() => {
    if ((tab === 'relations' || deleting) && relations === null) resourceApi.relations(def.key, id).then(setRelations).catch(() => setRelations([]));
    if (tab === 'logs' && logs === null) resourceApi.logs(def.key, id).then(setLogs).catch(() => setLogs([]));
  }, [tab, deleting, relations, logs, def.key, id]);

  if (!record) return <aside className="drawer card">{error ? <div className="notice error" role="alert">{error}</div> : <div className="empty-state muted">加载中…</div>}</aside>;

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
    ['relations', '关联'],
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
                      <>
                        {displayValue(f, record) || <span className="muted">—</span>}
                        {isCopyable(def, f) && displayValue(f, record) && <> <CopyButton value={displayValue(f, record)} label={f.label} /></>}
                      </>
                    )}
                  </FragmentRow>
                ))}
              </dl>
            </section>
          ))}
        {tab === 'info' && def.key === 'bank-accounts' && (
          <PhoneArchiveButton type="bank-accounts" record={record} numberKey="reservedPhoneNumber" idKey="phoneId" holder={String(record.data.reservedPhoneHolder ?? '')} onDone={() => { void load(); onChanged(); }} onError={setError} />
        )}
        {tab === 'info' && def.key === 'stores' && can('edit') && (
          <StoreReleaseButton record={record} onDone={() => { void load(); onChanged(); }} onError={setError} />
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
                  <small className="muted">{r.purpose ? `${r.purpose} ` : ''}{r.validFrom || r.validTo ? `有效期 ${r.validFrom ?? '…'} ~ ${r.validTo ?? '长期'}` : ''}</small>
                )}
                {r.relation === 'manual' && r.linkId && can('edit') && (
                  <button type="button" className="link-button" onClick={() => {
                    const purpose = window.prompt('用途（留空=不填）', r.purpose ?? '');
                    if (purpose === null) return;
                    const validFrom = window.prompt('有效期开始（YYYY-MM-DD，留空=不填）', r.validFrom ?? '');
                    if (validFrom === null) return;
                    const validTo = window.prompt('有效期结束（YYYY-MM-DD，留空=长期）', r.validTo ?? '');
                    if (validTo === null) return;
                    resourceApi.updateLink(def.key, id, r.linkId!, { purpose, validFrom, validTo }).then(() => setRelations(null)).catch((e) => setError(e instanceof ApiError ? e.message : '修改失败'));
                  }}>改属性</button>
                )}
                {r.relation === 'manual' && r.linkId && can('edit') && (
                  <button type="button" className="link-button" onClick={() => { if (window.confirm(`取消和「${r.title}」的关联？`)) resourceApi.removeLink(def.key, id, r.linkId!).then(() => setRelations(null)).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败')); }}>取消关联</button>
                )}
              </div>
            ))}
            {can('edit') && <ManualLinkAdder type={def.key} id={id} canView={canView} onAdded={() => setRelations(null)} onError={setError} />}
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
            {logs?.map((l) => (
              <div key={l.id} className="log-item">
                <div className="between"><strong>{ACTION_LABEL[l.action] ?? l.action}</strong><small className="muted">{new Date(l.createdAt).toLocaleString('zh-CN')}</small></div>
                <small className="muted">{l.actor}{l.note ? ` · ${l.note}` : ''}</small>
              </div>
            ))}
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

function FragmentRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** 手动关联：选一类资料，搜索并选其中一条，可填用途和有效期（如商标授权给某店铺的起止日期），关联到当前记录（可以关联多条）。 */
function ManualLinkAdder({ type, id, canView, onAdded, onError }: { type: string; id: number; canView: (t: string) => boolean; onAdded: () => void; onError: (m: string) => void }) {
  const types = RESOURCE_DEFS.filter((d) => !d.parent && canView(d.key));
  const [target, setTarget] = useState('');
  const [keyword, setKeyword] = useState('');
  const [options, setOptions] = useState<Array<{ value: number; label: string }>>([]);
  const [pick, setPick] = useState<number | ''>('');
  const [purpose, setPurpose] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  useEffect(() => {
    setPick('');
    if (!target) { setOptions([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      if (target === 'user') {
        resourceApi.users()
          .then((r) => alive && setOptions(r.filter((u) => u.active && (!keyword.trim() || u.name.includes(keyword.trim()))).slice(0, 50).map((u) => ({ value: u.id, label: u.name }))))
          .catch(() => alive && setOptions([]));
        return;
      }
      resourceApi.list(target, { pageSize: 50, showHidden: true, keyword: keyword.trim() || undefined })
        .then((r) => alive && setOptions(r.items.map((i) => ({ value: i.id, label: i.title }))))
        .catch(() => alive && setOptions([]));
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [target, keyword]);
  return (
    <div className="toolbar" style={{ marginTop: 12, flexWrap: 'wrap' }}>
      <select value={target} onChange={(e) => { setTarget(e.target.value); setKeyword(''); }}>
        <option value="">关联其他资料：选类型</option>
        <option value="user">员工</option>
        {types.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
      </select>
      {target && <input type="search" aria-label="搜索要关联的资料" placeholder="输入关键字搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />}
      {target && (
        <select value={pick} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : '')}>
          <option value="">选择一条</option>
          {options.filter((o) => !(target === type && o.value === id)).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {target && <input aria-label="用途" placeholder="用途（可选）" maxLength={200} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}
      {target && <label className="inline-field"><small className="muted">开始</small><input type="date" aria-label="有效期开始" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></label>}
      {target && <label className="inline-field"><small className="muted">结束</small><input type="date" aria-label="有效期结束" value={validTo} onChange={(e) => setValidTo(e.target.value)} /></label>}
      <button type="button" className="secondary-button" disabled={!target || !pick} onClick={() => {
        onError('');
        resourceApi.addLink(type, id, target, Number(pick), { purpose: purpose.trim() || undefined, validFrom: validFrom || undefined, validTo: validTo || undefined })
          .then(() => { setPick(''); setPurpose(''); setValidFrom(''); setValidTo(''); onAdded(); })
          .catch((e) => onError(e instanceof ApiError ? e.message : '关联失败'));
      }}>添加关联</button>
    </div>
  );
}
