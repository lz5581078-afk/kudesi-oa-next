import { useCallback, useEffect, useMemo, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { ApiError } from '../../../api/client';
import { ReasonDialog, RecordForm } from '../../../resources/RecordForm';
import { useResourceCan } from '../../../resources/RecordDetail';
import { resourceApi, type ResourceDto } from '../../../resources/api';
import { ResourcePage } from '../../../resources/ResourcePage';
import { expressApi, type TreeBranch, type TreeCarrier } from './expressApi';
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
  useEffect(() => {
    if (carriers && selected === null) {
      const first = carriers.flatMap((c) => c.branches.flatMap((b) => b.versions.filter((v) => v.isCurrent).map((v) => v.id)))[0] ?? carriers.flatMap((c) => c.branches.flatMap((b) => b.versions.map((v) => v.id)))[0];
      if (first) setSelected(first);
    }
  }, [carriers, selected]);

  if (view === 'flat') {
    return (
      <div>
        <div className="toolbar"><button type="button" className="secondary-button" onClick={() => setView('tree')}>← 返回按公司 / 网点 / 版本查看</button></div>
        <ResourcePage type="finance-express-prices" title="全部价格规则（平铺明细）" embedded />
      </div>
    );
  }

  return (
    <div>
      <div className="page-head between">
        <h1>快递价格表</h1>
        <div className="toolbar">
          {can('create') && <button type="button" className="primary-button" onClick={() => setForm({ kind: 'carrier', id: null })}>新增快递公司</button>}
          <button type="button" className="secondary-button" onClick={() => setView('flat')}>平铺明细</button>
        </div>
      </div>
      <p className="muted">每个网点只有一个“当前版本”；运费预估和分区建议只读取“当前版本 + 合作中 + 日期有效”的价格。</p>
      {error && <div role="alert" className="notice error">{error}</div>}
      {carriers && carriers.length === 0 && <div className="empty-state muted">还没有快递公司。先新增一家快递公司，再给它加经营网点和价格版本。</div>}
      <div className="split-layout" style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 16, alignItems: 'start' }}>
        <nav aria-label="快递公司网点版本" className="card">
          {(carriers ?? []).map((c) => (
            <div key={c.id} className="tree-group">
              <div className="between">
                <strong>{c.name}{c.status !== 'normal' ? '（停用）' : ''}</strong>
                <span className="row-actions">
                  {can('edit') && <button type="button" className="link-button" onClick={() => setForm({ kind: 'carrier', id: c.id })}>修改</button>}
                  {can('create') && <button type="button" className="link-button" onClick={() => setForm({ kind: 'branch', id: null, carrierId: c.id })}>加网点</button>}
                  {can('delete') && <button type="button" className="link-button danger" onClick={() => setRemoval({ kind: 'carriers', id: c.id, name: c.name })}>删除</button>}
                </span>
              </div>
              {c.branches.length === 0 && <p className="muted">还没有网点</p>}
              {c.branches.map((b) => <BranchNode key={b.id} branch={b} selected={selected} can={can} onSelect={setSelected}
                onEdit={() => setForm({ kind: 'branch', id: b.id, carrierId: c.id })} onAddVersion={() => setForm({ kind: 'version', branchId: b.id })} onRemove={() => setRemoval({ kind: 'branches', id: b.id, name: b.name })} />)}
            </div>
          ))}
        </nav>
        <section aria-label="价格版本详情">
          {found ? <VersionPanel key={found.v.id} carrier={found.c} branch={found.b} version={found.v} onChanged={() => void load()} onDeleted={() => { setSelected(null); void load(); }} />
            : <div className="empty-state muted">在左边选一个价格版本，查看和修改它的价格。</div>}
        </section>
      </div>

      {form && <HierarchyForm state={form} onClose={() => setForm(null)} onSaved={(dto) => { setForm(null); if (form.kind === 'version') setSelected(dto.id); void load(); }} />}
      {removal && (
        <ReasonDialog title={`删除${removal.kind === 'carriers' ? '快递公司' : '经营网点'}「${removal.name}」`} hint="会连同下面所有的网点、价格版本、价格规则、加收和识别记录一起删除，不能恢复。" confirmLabel="确认删除" danger onClose={() => setRemoval(null)}
          onConfirm={async (reason) => { await expressApi.remove(removal.kind, removal.id, reason); setRemoval(null); setSelected(null); await load(); }} />
      )}
    </div>
  );
}

function BranchNode({ branch, selected, can, onSelect, onEdit, onAddVersion, onRemove }: {
  branch: TreeBranch; selected: number | null; can: (a: 'create' | 'edit' | 'delete') => boolean; onSelect: (id: number) => void; onEdit: () => void; onAddVersion: () => void; onRemove: () => void;
}) {
  return (
    <div className="tree-branch">
      <div className="between">
        <span>{branch.name}{branch.isDefault ? ' ·默认' : ''}{branch.status !== 'normal' ? '（停用）' : ''}</span>
        <span className="row-actions">
          {can('edit') && <button type="button" className="link-button" onClick={onEdit}>修改</button>}
          {can('create') && <button type="button" className="link-button" onClick={onAddVersion}>加版本</button>}
          {can('delete') && <button type="button" className="link-button danger" onClick={onRemove}>删除</button>}
        </span>
      </div>
      {branch.jstLogisticsName && <div className="muted small">聚水潭：{branch.jstLogisticsName}</div>}
      <ul className="plain-list">
        {branch.versions.length === 0 && <li className="muted">还没有价格版本</li>}
        {branch.versions.map((v) => (
          <li key={v.id}>
            <button type="button" className={v.id === selected ? 'tree-item active' : 'tree-item'} aria-current={v.id === selected} onClick={() => onSelect(v.id)}>
              {v.name} <span className="muted">{COOP_TEXT[v.cooperationStatus]}{v.isCurrent ? ' · 当前' : ''}{v.inUse ? ' · 在用' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
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
