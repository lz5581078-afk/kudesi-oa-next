import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database } from 'lucide-react';
import { ExpressPanel } from './ExpressPanel';
import { ApiError } from '../../../api/client';
import { ReasonDialog } from '../../../resources/RecordForm';
import { useResourceCan } from '../../../resources/RecordDetail';
import { resourceApi } from '../../../resources/api';
import { useAuth } from '../../../auth/AuthContext';
import './expressWorkspace.css';
import { expressApi, type TreeCarrier } from './expressApi';
import { useExpressWorkspace } from './ExpressWorkspaceContext';
import { VersionPanel } from './VersionPanel';

import { HierarchyForm, type HierarchyState } from './HierarchyForm';

type FormState = HierarchyState;
type Removal = { kind: 'carriers' | 'branches' | 'versions'; id: number; name: string };

const COOP_TEXT = { pending: '待确认', active: '合作中', paused: '已暂停' } as const;
const err = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

/** 快递价格：快递公司 → 经营网点 → 价格版本 → 价格规则（省份 × 重量段矩阵）。 */
export function ExpressPricesPage() {
  const workspace = useExpressWorkspace();
  const hosted = Boolean(workspace);
  const acceptCarriers = workspace?.acceptCarriers;
  const setLocation = workspace?.setLocation;
  const { can: permitted } = useAuth();
  const canZone = permitted('finance.zone-suggestion.view') && permitted('product.cost.view');
  const [runCount, setRunCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    if (canZone && !hosted) void expressApi.zoneRuns(1, 1).then(r => { if (active) setRunCount(r.total); }).catch(() => { if (active) setRunCount(null); });
    return () => { active = false; };
  }, [canZone, hosted]);
  const can = useResourceCan('finance-express-prices');
  const [carriers, setCarriers] = useState<TreeCarrier[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [branchId, setBranchId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await expressApi.tree();
      setCarriers(t.carriers);
      acceptCarriers?.(t.carriers);
      setError('');
    } catch (e) { setError(err(e)); }
  }, [acceptCarriers]);
  useEffect(() => { void load(); }, [load]);

  async function change(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await operation(); await load(); } catch (e) { setError(err(e)); }
    setBusy(false);
  }

  const found = useMemo(() => {
    for (const c of carriers ?? []) for (const b of c.branches) for (const v of b.versions) if (v.id === selected) return { c, b, v };
    return null;
  }, [carriers, selected]);
  const branch = carriers?.flatMap(c => c.branches.map(b => ({ c, b }))).find(x => x.b.id === branchId);

  useEffect(() => {
    setLocation?.({ branchName: branch?.b.name, versionName: found?.v.name, companies: () => { setBranchId(null); setSelected(null); }, versions: () => setSelected(null) });
    return () => setLocation?.(null);
  }, [setLocation, branch?.b.name, found?.v.name]);

  return (
    <div className="express-price-workspace">
      {!hosted && <div className="page-head"><h1>快递价格表</h1></div>}
      {!hosted && !branch && !found && <>
        <div className="express-workspace-overview" aria-label="快递价格汇总">
          <div><strong>{carriers?.length ?? '—'}</strong><span>快递公司</span></div>
          <div><strong>{carriers ? carriers.reduce((n, c) => n + c.branches.length, 0) : '—'}</strong><span>经营网点</span></div>
          <div><strong>{carriers ? carriers.flatMap(c => c.branches).filter(b => b.versions.some(v => v.isCurrent && v.cooperationStatus === 'active')).length : '—'}</strong><span>合作中版本</span></div>
          {canZone && <div><strong>{runCount ?? '—'}</strong><span>建议记录</span></div>}
        </div>
      </>}
      {error && <div role="alert" className="notice error">{error}</div>}
      {carriers && carriers.length === 0 && <div className="empty-state muted">还没有快递公司。先新增一家快递公司，再给它加经营网点和价格版本。</div>}
      {!hosted && <nav className="toolbar" aria-label="快递价格层级">
        <button type="button" className="link-button" onClick={() => { setBranchId(null); setSelected(null); }}>快递公司</button>
        {branch && <><span>/</span><button type="button" className="link-button" onClick={() => setSelected(null)}>{branch.c.name} / {branch.b.name}</button></>}
        {found && <><span>/</span><strong>{found.v.name}</strong></>}
      </nav>}
      {!branch && !found && <ExpressPanel title="快递公司与经营网点" icon={Database} className="express-carrier-panel" actions={can('create') && <button type="button" className="primary-button" onClick={() => setForm({ kind: 'carrier', id: null })}>新增快递公司</button>}>{(carriers ?? []).map(c => <section key={c.id} className="express-carrier-section">
        <header className="express-carrier-heading"><div><strong>{c.name}</strong><small>{c.branches.length} 个经营网点</small></div><div className="row-actions">
          {can('edit') && <button type="button" className="secondary-button small" onClick={() => setForm({ kind: 'carrier', id: c.id })}>编辑快递公司</button>}
          {can('create') && <button type="button" className="secondary-button small" onClick={() => setForm({ kind: 'branch', id: null, carrierId: c.id })}>新增网点</button>}
          {can('delete') && <button type="button" className="secondary-button small danger" onClick={() => setRemoval({ kind: 'carriers', id: c.id, name: c.name })}>删除快递公司</button>}
        </div></header>
        <div className="express-branch-cards">{c.branches.map(b => {
          const current = b.versions.find(v => v.isCurrent);
          return <article key={b.id} className={`express-branch-row${b.isDefault ? ' is-default' : ''}`}>
            <div className="express-branch-title"><strong>{b.name}</strong>{b.isDefault && <small>默认网点</small>}</div>
            <div className="express-branch-metadata"><span>当前版本<b>{current?.name || '未设置'}</b></span><span>合作状态<b className={current?.cooperationStatus === 'active' ? 'is-active' : ''}>{COOP_TEXT[current?.cooperationStatus ?? 'pending']}</b></span><span>聚水潭映射<b>{b.jstLogisticsName || '待维护'}</b></span></div>
            <div className="row-actions express-branch-actions"><button type="button" className="primary-button small" onClick={() => { setBranchId(b.id); setSelected(null); }}>查看价格表</button>
              {can('edit') && <button type="button" className="secondary-button small" onClick={() => setForm({ kind: 'branch', id: b.id, carrierId: c.id })}>编辑网点</button>}
              {can('edit') && !b.isDefault && <button type="button" className="secondary-button small" disabled={busy} onClick={() => void change(() => resourceApi.update('finance-express-carriers', c.id, { defaultBranchId: b.id }))}>设为默认</button>}
              {can('delete') && <button type="button" className="secondary-button small danger" onClick={() => setRemoval({ kind: 'branches', id: b.id, name: b.name })}>删除</button>}
            </div>
          </article>;
        })}{!c.branches.length && <p className="muted">这个快递公司还没有经营网点</p>}</div>
      </section>)}</ExpressPanel>}
      {branch && !found && <section aria-label="价格版本列表">
        <div className="express-current-branch"><div><strong>{branch.c.name} / {branch.b.name}</strong><span>{branch.b.versions.length} 个价格版本 · 当前版本：{branch.b.versions.find(v => v.isCurrent)?.name || '未设置'}</span></div><button type="button" className="secondary-button" onClick={() => setBranchId(null)}>返回网点列表</button></div>
        <ExpressPanel title="价格版本" icon={Database} className="express-versions-panel" actions={can('create') && <button type="button" className="primary-button" onClick={() => setForm({ kind: 'version', branchId: branch.b.id })}>新建价格版本</button>}>
        <div className="express-version-cards">{[...branch.b.versions].sort((a, b) => b.id - a.id).map(v => <article key={v.id} className={`express-version-card${v.isCurrent ? ' is-current' : ''}`}>
          <header><div><strong>{v.name}</strong><small>{v.createdAt ? `建立：${new Date(v.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : '历史版本'}</small></div><span className="pill">{v.isCurrent ? '启用中' : v.status === 'active' ? '启用中' : v.status === 'draft' ? '草稿' : '已停用'}</span></header>
          <div className="express-version-metadata"><span><b>生效</b>{v.effectiveStart || '-'}</span><span><b>失效</b>{v.effectiveEnd || '长期有效'}</span><span className="express-version-weight"><b>可发货重量</b>{v.shippingWeightMin ?? 0}–{v.shippingWeightMax ?? '不限'} kg</span><span><b>规则</b>{v.ruleCount ?? (v.priceSource === 'ai' ? v.aiRuleCount : v.manualRuleCount)} 条</span><span><b>加收</b>{v.surchargeCount} 条</span><span><b>识别</b>{v.recognitionCount ?? 0} 次</span><span><b>原始表</b>{v.attachmentName ? '已上传' : '未上传'}</span></div>
          {v.remark && <p>{v.remark.slice(0, 80)}</p>}
          <div className="express-version-actions"><button type="button" className="primary-button" onClick={() => setSelected(v.id)}>查看详情</button>{can('edit') && <button type="button" className="secondary-button" onClick={() => setForm({ kind: 'version', id: v.id, branchId: branch.b.id })}>编辑版本资料</button>}
            {!v.isCurrent && can('edit') && <button type="button" className="secondary-button express-version-current" disabled={busy} onClick={() => void change(() => resourceApi.update('finance-express-branches', branch.b.id, { currentVersionId: v.id }))}>设为当前版本</button>}
            <footer>{can('delete') && <button type="button" className="secondary-button danger" onClick={() => setRemoval({ kind: 'versions', id: v.id, name: v.name })}>删除版本</button>}{can('edit') && <button type="button" className="express-cooperation-switch" role="switch" aria-label={`${v.name}合作开关`} aria-checked={v.cooperationStatus === 'active'} disabled={busy} onClick={() => void change(() => resourceApi.update('finance-express-versions', v.id, { cooperationStatus: v.cooperationStatus === 'active' ? 'paused' : 'active' }))}><i aria-hidden="true"/><span>{v.cooperationStatus === 'active' ? '合作中' : '合作关闭'}</span></button>}</footer>
          </div>
        </article>)}</div>{!branch.b.versions.length && <p className="muted">还没有价格版本</p>}</ExpressPanel>
      </section>}
      {found && <section aria-label="价格版本详情"><VersionPanel key={found.v.id} carrier={found.c} branch={found.b} version={found.v} onChanged={() => void load()} onBack={() => { setBranchId(found.b.id); setSelected(null); }} onDeleted={() => { setSelected(null); void load(); }} /></section>}

      {form && <HierarchyForm carriers={carriers ?? []} state={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); if (form.kind === 'version') setBranchId(form.branchId); void load(); }} />}
      {removal && (
        <ReasonDialog requireReason={false} title="确认删除" hint={`确定删除${removal.kind === 'carriers' ? '快递公司' : removal.kind === 'versions' ? '价格版本' : '经营网点'}“${removal.name}”吗？${removal.kind === 'versions' ? '该版本下的价格表、临时加收和识别记录会一并移除。' : removal.kind === 'branches' ? '该网点下的价格版本、价格表、临时加收和识别记录会一并移除。' : '该快递公司下的经营网点、价格版本、价格表、临时加收和识别记录会一并移除。'}`} confirmLabel="确认删除" danger onClose={() => setRemoval(null)}
          onConfirm={async () => { await expressApi.remove(removal.kind, removal.id, `人工确认删除${removal.kind === 'carriers' ? '快递公司' : removal.kind === 'versions' ? '价格版本' : '经营网点'}`); setRemoval(null); setSelected(null); await load(); }} />
      )}
    </div>
  );
}
