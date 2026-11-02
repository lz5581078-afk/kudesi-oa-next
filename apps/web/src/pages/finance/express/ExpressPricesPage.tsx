import { useCallback, useEffect, useMemo, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { ReasonDialog, RecordForm } from '../../../resources/RecordForm';
import { useResourceCan } from '../../../resources/RecordDetail';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { ResourcePage } from '../../../resources/ResourcePage';
import { expressApi, type TreeCarrier } from './expressApi';
import { VersionPanel } from './VersionPanel';

type FormState =
  | { kind: 'carrier'; id: number | null }
  | { kind: 'branch'; id: number | null; carrierId: number }
  | { kind: 'version'; branchId: number };
type Removal = { kind: 'carriers' | 'branches'; id: number; name: string };

const COOP_TEXT = { pending: '待确认', active: '合作中', paused: '已暂停' } as const;
const err = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

/** 快递价格：快递公司 → 经营网点 → 价格版本 → 价格规则（省份 × 重量段矩阵）。 */
export function ExpressPricesPage() {
  const can = useResourceCan('finance-express-prices');
  const [carriers, setCarriers] = useState<TreeCarrier[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'tree' | 'flat'>('tree');
  const [selected, setSelected] = useState<number | null>(null);
  const [branchId, setBranchId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await expressApi.tree();
      setCarriers(t.carriers);
      setError('');
    } catch (e) { setError(err(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const found = useMemo(() => {
    for (const c of carriers ?? []) for (const b of c.branches) for (const v of b.versions) if (v.id === selected) return { c, b, v };
    return null;
  }, [carriers, selected]);
  const branch = carriers?.flatMap(c => c.branches.map(b => ({ c, b }))).find(x => x.b.id === branchId);

  if (view === 'flat') {
    return (
      <div>
        <div className="toolbar"><button type="button" className="secondary-button" onClick={() => setView('tree')}>← 返回按公司 / 网点 / 版本查看</button></div>
        <ResourcePage type="finance-express-prices" title="全部价格规则（平铺明细）" embedded />
      </div>
    );
  }

  return (
    <div className="express-reference-page">
      <div className="page-head between">
        <div><h1>快递价格表</h1><p>快递公司、经营网点、价格版本与分区运费</p></div>
        <div className="toolbar">
          {can('create') && <button type="button" className="primary-button" onClick={() => setForm({ kind: 'carrier', id: null })}>新增快递公司</button>}
          <button type="button" className="secondary-button" onClick={() => setView('flat')}>平铺明细</button>
        </div>
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {carriers && carriers.length === 0 && <div className="empty-state muted">还没有快递公司。先新增一家快递公司，再给它加经营网点和价格版本。</div>}
      <nav className="express-breadcrumb" aria-label="快递价格层级">
        <button type="button" className="link-button" onClick={() => { setBranchId(null); setSelected(null); }}>快递公司</button>
        {branch && <><span>/</span><button type="button" className="link-button" onClick={() => setSelected(null)}>{branch.c.name} / {branch.b.name}</button></>}
        {found && <><span>/</span><strong>{found.v.name}</strong></>}
      </nav>
      <div className="express-summary" aria-label="快递资料统计"><span><b>{carriers?.length ?? 0}</b>快递公司</span><span><b>{carriers?.reduce((sum,c)=>sum+c.branches.length,0) ?? 0}</b>经营网点</span><span><b>{carriers?.flatMap(c=>c.branches.flatMap(b=>b.versions)).filter(v=>v.cooperationStatus==='active').length ?? 0}</b>合作中版本</span><span><b>{carriers?.flatMap(c=>c.branches.flatMap(b=>b.versions)).length ?? 0}</b>价格版本</span></div>
      {!branch && !found && <div className="express-company-list">{(carriers ?? []).map(c => <section key={c.id} className="card express-company-card">
        <header className="between"><div><h2>{c.name}</h2><small className="muted">{c.note || '经营网点与价格版本'}</small></div><div className="row-actions">
          {can('edit') && <button type="button" className="secondary-button small" onClick={() => setForm({ kind: 'carrier', id: c.id })}>编辑快递公司</button>}
          {can('create') && <button type="button" className="secondary-button small" onClick={() => setForm({ kind: 'branch', id: null, carrierId: c.id })}>新增网点</button>}
          {can('delete') && <button type="button" className="link-button danger" onClick={() => setRemoval({ kind: 'carriers', id: c.id, name: c.name })}>删除快递公司</button>}
        </div></header>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>经营网点</th><th>聚水潭物流公司</th><th>联系人</th><th>价格版本</th><th>操作</th></tr></thead><tbody>
          {c.branches.map(b => <tr key={b.id}><td><strong>{b.name}</strong>{b.isDefault && <span className="pill ok">默认</span>}{b.status !== 'normal' && <span className="pill warn">停用</span>}</td><td>{b.jstLogisticsName || '—'}</td><td>{b.contactName} {b.contactPhone}</td><td>{b.versions.length} 个</td><td className="row-actions">
            <button type="button" className="primary-button small" onClick={() => { setBranchId(b.id); setSelected(null); }}>查看价格表</button>
            {can('edit') && <button type="button" className="link-button" onClick={() => setForm({ kind: 'branch', id: b.id, carrierId: c.id })}>编辑网点</button>}
            {can('edit') && !b.isDefault && <button type="button" className="link-button" onClick={async () => { try { await resourceApi.update('finance-express-carriers', c.id, { defaultBranchId: b.id }); await load(); } catch (e) { setError(err(e)); } }}>设为默认</button>}
            {can('delete') && <button type="button" className="link-button danger" onClick={() => setRemoval({ kind: 'branches', id: b.id, name: b.name })}>删除</button>}
          </td></tr>)}
          {!c.branches.length && <tr><td colSpan={5} className="empty-state muted">还没有经营网点，请先新增网点。</td></tr>}
        </tbody></table></div>
      </section>)}</div>}
      {branch && !found && <section className="card" aria-label="价格版本列表">
        <header className="between"><div><h2>{branch.c.name} / {branch.b.name}</h2><p className="muted">选择价格版本查看原始价格、手工价格、临时加收与最终价格。</p></div><div className="row-actions"><button type="button" className="secondary-button" onClick={() => setBranchId(null)}>返回快递公司</button>{can('create') && <button type="button" className="primary-button" onClick={() => setForm({ kind: 'version', branchId: branch.b.id })}>新建价格版本</button>}</div></header>
        <div className="express-version-cards">{branch.b.versions.map(v=><article className="express-version-card" key={v.id}><div className="between"><h3>{v.name}</h3><span className={`pill ${v.cooperationStatus==='active'?'ok':'warn'}`}>{COOP_TEXT[v.cooperationStatus]}</span></div>{v.isCurrent && <span className="pill ok">当前版本</span>}<dl><dt>有效期间</dt><dd>{v.effectiveStart || '不限'} 至 {v.effectiveEnd || '长期'}</dd><dt>可发货重量</dt><dd>{v.shippingWeightMin ?? 0} ~ {v.shippingWeightMax ?? '不限'} kg</dd><dt>价格规则</dt><dd>识别 {v.aiRuleCount} / 手工 {v.manualRuleCount}</dd><dt>临时加收</dt><dd>{v.surchargeCount}</dd></dl><button type="button" className="primary-button" onClick={()=>setSelected(v.id)}>查看价格详情</button></article>)}</div>{!branch.b.versions.length && <p className="empty-state muted">这个网点还没有价格版本。</p>}
      </section>}
      {found && <section aria-label="价格版本详情"><button type="button" className="secondary-button" onClick={() => { setBranchId(found.b.id); setSelected(null); }}>返回版本列表</button><VersionPanel key={found.v.id} carrier={found.c} branch={found.b} version={found.v} onChanged={() => void load()} onDeleted={() => { setSelected(null); void load(); }} /></section>}

      {form && <HierarchyForm state={form} onClose={() => setForm(null)} onSaved={(dto) => { setForm(null); if (form.kind === 'version') { setBranchId(form.branchId); setSelected(dto.id); } void load(); }} />}
      {removal && (
        <ReasonDialog title={`删除${removal.kind === 'carriers' ? '快递公司' : '经营网点'}「${removal.name}」`} hint="会连同下面所有的网点、价格版本、价格规则、加收和识别记录一起删除，不能恢复。" confirmLabel="确认删除" danger onClose={() => setRemoval(null)}
          onConfirm={async (reason) => { await expressApi.remove(removal.kind, removal.id, reason); setRemoval(null); setSelected(null); await load(); }} />
      )}
    </div>
  );
}

/** 公司 / 网点 / 版本的新增和修改，用通用表单（字段由资料定义生成） */
function HierarchyForm({ state, onClose, onSaved }: { state: FormState; onClose: () => void; onSaved: (dto: ResourceDto) => void }) {
  const type = state.kind === 'carrier' ? 'finance-express-carriers' : state.kind === 'branch' ? 'finance-express-branches' : 'finance-express-versions';
  const id = state.kind === 'version' ? null : state.id;
  const [record, setRecord] = useState<ResourceDto | null | undefined>(id === null ? null : undefined);
  useEffect(() => { if (id !== null) void resourceApi.get(type, id).then(setRecord).catch(onClose); }, [id, type]); // eslint-disable-line react-hooks/exhaustive-deps
  if (record === undefined) return null;
  const initial = state.kind === 'branch' ? { carrierId: state.carrierId } : state.kind === 'version' ? { branchId: state.branchId } : undefined;
  const locked = state.kind === 'branch' ? ['carrierId'] : state.kind === 'version' ? ['branchId'] : undefined;
  return <RecordForm def={getResourceDef(type)!} record={record} initial={initial} lockedFields={locked} onClose={onClose} onSaved={onSaved} />;
}
