import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createChecker } from '@kudesi/shared';
import type { CatalogGroup } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../api/client';
import { PermissionPicker } from './PermissionPicker';
import { orgApi, flattenDepartments, WORKSPACE_LABELS, LEVEL_LABELS, type DepartmentNode, type PositionDto, type PositionLevel, type StaffDto } from './orgApi';
import { DepartmentDossier, ancestorsOf } from './DepartmentDossier';
import { planMove, type Placement } from './deptMove';

function findNode(nodes: DepartmentNode[], id: number): DepartmentNode | null {
  for (const n of nodes) { if (n.id === id) return n; const r = findNode(n.children, id); if (r) return r; }
  return null;
}

function errText(e: unknown, fallback = '操作失败') {
  return e instanceof ApiError ? e.message : fallback;
}

/** 左侧部门树：人数、展开/收起（记住上次的展开状态）、点击选中；搜索命中时祖先自动展开。 */
function DepartmentTree({ nodes, depth, selectedId, expanded, forceOpen, headcount, hits, onToggleOpen, onSelect, onDropMove }: {
  nodes: DepartmentNode[]; depth: number; selectedId: number | null; expanded: Set<number>; forceOpen: Set<number> | null; headcount: Map<number, number>; hits: Map<number, string[]>;
  onToggleOpen: (id: number) => void; onSelect: (id: number) => void;
  /** 有值才允许拖拽调整顺序/层级 */
  onDropMove?: (sourceId: number, targetId: number, placement: Placement) => void;
}) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [hint, setHint] = useState<{ id: number; placement: Placement } | null>(null);
  const place = (e: React.DragEvent<HTMLElement>): Placement => { const r = e.currentTarget.getBoundingClientRect(); const y = e.clientY - r.top; return y < r.height * 0.25 ? 'before' : y > r.height * 0.75 ? 'after' : 'inside'; };
  return (
    <ul className="tree" role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? '部门' : undefined}>
      {nodes.filter((n) => !forceOpen || forceOpen.has(n.id)).map((n) => {
        const open = forceOpen ? true : expanded.has(n.id);
        const kids = n.children.filter((c) => !forceOpen || forceOpen.has(c.id));
        const hit = hits.get(n.id);
        return (
          <li key={n.id} role="treeitem" aria-expanded={n.children.length ? open : undefined} aria-selected={selectedId === n.id}>
            <div
              className={`line-item org-node${selectedId === n.id ? ' active' : ''}${dragId === n.id ? ' dragging' : ''}${hint?.id === n.id ? ` drop-${hint.placement}` : ''}`}
              style={{ paddingLeft: 8 + depth * 16 }}
              draggable={!!onDropMove}
              aria-label={onDropMove ? `${n.name}，可拖动调整顺序或层级` : undefined}
              onDragStart={onDropMove ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(n.id)); setDragId(n.id); } : undefined}
              onDragEnd={onDropMove ? () => { setDragId(null); setHint(null); } : undefined}
              onDragOver={onDropMove ? (e) => { if (dragId === null || dragId === n.id) return; e.preventDefault(); setHint({ id: n.id, placement: place(e) }); } : undefined}
              onDrop={onDropMove ? (e) => { if (dragId === null || dragId === n.id) return; e.preventDefault(); const pl = place(e); const src = dragId; setDragId(null); setHint(null); onDropMove(src, n.id, pl); } : undefined}
            >
              {n.children.length > 0
                ? <button type="button" className="link-button org-toggle" aria-label={`${open ? '收起' : '展开'}${n.name}`} onClick={() => onToggleOpen(n.id)}>{open ? '▾' : '▸'}</button>
                : <span className="org-toggle" />}
              <button type="button" className="link-button org-name" onClick={() => onSelect(n.id)}>
                {n.name}{n.status === 'inactive' && <span className="pill warn"> 已停用</span>}
                {hit && <small className="muted"> 含 {hit.slice(0, 3).join('、')}{hit.length > 3 ? ` 等 ${hit.length} 人` : ''}</small>}
              </button>
              <span className="muted" title="在职人数">{headcount.get(n.id) ?? 0}</span>
            </div>
            {kids.length > 0 && open && <DepartmentTree nodes={kids} depth={depth + 1} selectedId={selectedId} expanded={expanded} forceOpen={forceOpen} headcount={headcount} hits={hits} onToggleOpen={onToggleOpen} onSelect={onSelect} onDropMove={onDropMove} />}
          </li>
        );
      })}
    </ul>
  );
}

function NameDialog({ title, initial, onClose, onSubmit }: { title: string; initial?: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('请填写名称');
    setBusy(true);
    try { await onSubmit(name.trim()); } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label={title} onSubmit={submit}>
        <div className="modal-head"><strong>{title}</strong></div>
        <div className="modal-body">
          <label>名称<input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>保存</button>
        </div>
      </form>
    </div>
  );
}

function PositionDialog({ position, defaultDepartmentId, departments, catalog, canEditPerms, onClose, onSaved }: {
  position: PositionDto | null; defaultDepartmentId?: number | null; departments: DepartmentNode[]; catalog: CatalogGroup[]; canEditPerms: boolean;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(position?.name ?? '');
  const [positionKey, setPositionKey] = useState(position?.positionKey ?? '');
  const [departmentId, setDepartmentId] = useState<number | null>(position ? position.departmentId : defaultDepartmentId ?? null);
  const [workspaceType, setWorkspaceType] = useState(position?.workspaceType ?? 'blank');
  const [perms, setPerms] = useState<string[]>(position?.permissions ?? []);
  const [level, setLevel] = useState<PositionLevel>(position?.level ?? 'staff');
  const [supervisor, setSupervisor] = useState<number | null>(position?.supervisorPositionId ?? null);
  const [description, setDescription] = useState(position?.description ?? '');
  const [allPositions, setAllPositions] = useState<PositionDto[]>([]);
  useEffect(() => { void orgApi.positions().then(setAllPositions).catch(() => undefined); }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('请填写岗位名称');
    setBusy(true);
    try {
      if (position) {
        await orgApi.updatePosition(position.id, { name: name.trim(), positionKey: positionKey.trim() || null, departmentId, workspaceType, level, supervisorPositionId: supervisor, description: description.trim() || null });
        if (canEditPerms) await orgApi.setPositionPermissions(position.id, perms);
      } else {
        await orgApi.addPosition({ name: name.trim(), positionKey: positionKey.trim() || null, departmentId, workspaceType, level, supervisorPositionId: supervisor, description: description.trim() || undefined });
        if (perms.length > 0) {
          const created = (await orgApi.positions()).find((p) => p.name === name.trim());
          if (created) await orgApi.setPositionPermissions(created.id, perms);
        }
      }
      onSaved();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card" role="dialog" aria-label={position ? '编辑岗位' : '新增岗位'} onSubmit={submit}>
        <div className="modal-head"><strong>{position ? `编辑岗位：${position.name}` : '新增岗位'}</strong></div>
        <div className="modal-body">
          <div className="form-grid">
            <label>岗位名称<input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
            <label>岗位编码<input value={positionKey} maxLength={64} placeholder="选填，同一部门内不重复" onChange={(e) => setPositionKey(e.target.value)} /></label>
            <label>所属部门
              <select value={departmentId ?? ''} onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">（不属于任何部门）</option>
                {flattenDepartments(departments).map((d) => <option key={d.id} value={d.id}>{'　'.repeat(d.depth)}{d.name}</option>)}
              </select>
            </label>
            <label>岗位类型
              <select value={workspaceType} onChange={(e) => setWorkspaceType(e.target.value)}>
                {Object.entries(WORKSPACE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label>岗位层级
              <select value={level} onChange={(e) => setLevel(e.target.value as PositionLevel)}>
                {Object.entries(LEVEL_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label>上级岗位
              <select value={supervisor ?? ''} onChange={(e) => setSupervisor(e.target.value ? Number(e.target.value) : null)}>
                <option value="">（无）</option>
                {allPositions.filter((p) => p.id !== position?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>
          <label>岗位说明<textarea rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          <p className="muted">岗位类型决定默认工作台，不靠名称猜测；具体能看什么、能做什么由下面的权限决定。</p>
          {canEditPerms ? (
            <PermissionPicker catalog={catalog} values={perms} onChange={setPerms} />
          ) : (
            <p className="muted">你没有修改岗位权限的权限。</p>
          )}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>保存</button>
        </div>
      </form>
    </div>
  );
}

function DeptEditDialog({ node, tree, onClose, onSubmit }: { node: DepartmentNode; tree: DepartmentNode[]; onClose: () => void; onSubmit: (v: { name: string; parentId: number | null; managerId: number | null; sortOrder: number }) => Promise<void> }) {
  const [name, setName] = useState(node.name);
  const [managerId, setManagerId] = useState<number | null>(node.managerId ?? null);
  const [people, setPeople] = useState<Array<{ id: number; name: string }>>([]);
  useEffect(() => { orgApi.staff().then((l) => setPeople(l.filter((x) => x.status === 'active').map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined); }, []);
  const [sortOrder, setSortOrder] = useState(String(node.sortOrder));
  const findParent = (nodes: DepartmentNode[], parent: number | null): number | null | undefined => {
    for (const n of nodes) {
      if (n.id === node.id) return parent;
      const r = findParent(n.children, n.id);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  const [parentId, setParentId] = useState<number | null>(findParent(tree, null) ?? null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 自己和自己的下级不能当上级
  const banned = new Set(flattenDepartments([node]).map((d) => d.id));
  const options = flattenDepartments(tree).filter((d) => !banned.has(d.id));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('请填写名称');
    setBusy(true);
    try { await onSubmit({ name: name.trim(), parentId, managerId, sortOrder: Number(sortOrder) || 0 }); } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="编辑部门" onSubmit={submit}>
        <div className="modal-head"><strong>编辑部门：{node.name}</strong></div>
        <div className="modal-body">
          <label>名称<input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
          <label>部门主管
            <select value={managerId ?? ''} onChange={(e) => setManagerId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">（未设置）</option>
              {managerId && !people.some((x) => x.id === managerId) && <option value={managerId}>当前主管</option>}
              {people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label>上级部门
            <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">无（顶级部门）</option>
              {options.map((d) => <option key={d.id} value={d.id}>{'　'.repeat(d.depth)}{d.name}</option>)}
            </select>
          </label>
          <label>同级排序（数字小的在前）<input type="number" min="0" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>保存</button>
        </div>
      </form>
    </div>
  );
}

function DeptDeleteDialog({ node, tree, onClose, onConfirm }: { node: DepartmentNode; tree: DepartmentNode[]; onClose: () => void; onConfirm: (transferToId?: number) => Promise<void> }) {
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const banned = new Set(flattenDepartments([node]).map((d) => d.id));
  const options = flattenDepartments(tree).filter((d) => !banned.has(d.id));
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="删除部门" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true);
        try { await onConfirm(to ? Number(to) : undefined); } catch (err) { setError(errText(err)); setBusy(false); }
      }}>
        <div className="modal-head"><strong>删除部门「{node.name}」</strong></div>
        <div className="modal-body">
          <p>如果部门下有下级部门、岗位、员工或固定资产，请选择接收部门，它们会整体转过去；已停用的员工会归入“离职员工”，不再出现在组织架构里；空部门可以不选直接删除。</p>
          <label>接收部门
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">（不转移，仅空部门可删）</option>
              {options.map((d) => <option key={d.id} value={d.id}>{'　'.repeat(d.depth)}{d.name}</option>)}
            </select>
          </label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button danger-fill" disabled={busy}>确认删除</button>
        </div>
      </form>
    </div>
  );
}

export function StructurePage() {
  const { user } = useAuth();
  const can = user ? createChecker(user.permissions) : () => false;
  const [tree, setTree] = useState<DepartmentNode[]>([]);
  const [positions, setPositions] = useState<PositionDto[]>([]);
  const [catalog, setCatalog] = useState<CatalogGroup[]>([]);
  const [error, setError] = useState('');
  const [staff, setStaff] = useState<StaffDto[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    try { const v = JSON.parse(localStorage.getItem('kudesi.org.expanded') ?? 'null') as number[] | null; return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
  });
  const [treeQ, setTreeQ] = useState('');
  const [version, setVersion] = useState(0);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: 'dept-add'; parent: DepartmentNode | null } | { kind: 'dept-rename'; node: DepartmentNode } | { kind: 'dept-delete'; node: DepartmentNode } | { kind: 'dept-disable'; node: DepartmentNode }
    | { kind: 'position'; position: PositionDto | null } | { kind: 'position-delete'; position: PositionDto } | null
  >(null);

  const reload = useCallback(async () => {
    try {
      const [t, p, c] = await Promise.all([orgApi.departments(), orgApi.positions(), orgApi.catalog()]);
      setTree(t); setPositions(p); setCatalog(c); setError(''); setVersion((v) => v + 1);
      orgApi.staff().then(setStaff).catch(() => undefined); // 人数和搜索用；没有员工查看权限时只是不显示人数
      setSelectedId((cur) => cur ?? t[0]?.id ?? null);
    } catch (e) { setError(errText(e, '加载失败')); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => { try { localStorage.setItem('kudesi.org.expanded', JSON.stringify([...expanded])); } catch { /* 存储不可用 */ } }, [expanded]);
  const headcount = useMemo(() => {
    const m = new Map<number, number>();
    for (const x of staff) if (x.status === 'active' && x.departmentId) m.set(x.departmentId, (m.get(x.departmentId) ?? 0) + 1);
    return m;
  }, [staff]);
  // 搜索：部门名或部门里的人名命中，祖先保留并展开
  const search = useMemo(() => {
    const q = treeQ.trim().toLowerCase();
    if (!q) return null;
    const ids = new Set<number>();
    const hits = new Map<number, string[]>();
    for (const d of flattenDepartments(tree)) {
      const nameHit = d.name.toLowerCase().includes(q);
      const people = staff.filter((x) => x.departmentId === d.id && `${x.name}${x.positionName ?? ''}`.toLowerCase().includes(q)).map((x) => x.name);
      if (nameHit || people.length) {
        ids.add(d.id);
        for (const a of ancestorsOf(tree, d.id) ?? []) ids.add(a);
        if (people.length && !nameHit) hits.set(d.id, people);
      }
    }
    return { ids, hits };
  }, [treeQ, tree, staff]);
  const allBranchIds = useMemo(() => flattenDepartments(tree).filter((d) => d.id).map((d) => d.id), [tree]);
  const selected = selectedId ? findNode(tree, selectedId) : null;
  const siblingsOf = (id: number): DepartmentNode[] => { const anc = ancestorsOf(tree, id); const parentId = anc && anc.length ? anc[anc.length - 1] : null; return parentId ? findNode(tree, parentId)?.children ?? [] : tree; };
  async function moveSibling(n: DepartmentNode, dir: -1 | 1) {
    const sib = siblingsOf(n.id);
    const i = sib.findIndex((x) => x.id === n.id);
    const j = i + dir;
    if (j < 0 || j >= sib.length) return;
    const next = [...sib]; [next[i], next[j]] = [next[j], next[i]];
    try { await Promise.all(next.map((x, k) => (x.sortOrder === (k + 1) * 10 ? Promise.resolve() : orgApi.updateDepartment(x.id, { sortOrder: (k + 1) * 10 })))); await reload(); } catch (e) { setError(errText(e)); }
  }
  async function dropMove(sourceId: number, targetId: number, placement: Placement) {
    const plan = planMove(tree, sourceId, targetId, placement);
    if ('error' in plan) return setError(plan.error);
    if (!plan.updates.length) return;
    setError('');
    try {
      for (const u of plan.updates) await orgApi.updateDepartment(u.id, { parentId: u.parentId, sortOrder: u.sortOrder });
      if (placement === 'inside') setExpanded((cur) => new Set([...cur, targetId]));
      await reload();
    } catch (e) { setError(errText(e)); await reload(); }
  }
  const deptName = (id: number | null) => flattenDepartments(tree).find((d) => d.id === id)?.name ?? '—';
  const done = async () => { setDialog(null); await reload(); };

  return (
    <div>
      <div className="page-head"><h1>部门与岗位</h1></div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="two-col">
        <section className={`card pad org-tree-pane${mobileDetail ? ' has-selection' : ''}`}>
          <div className="between">
            <h2 className="section-title">部门</h2>
            {can('org.structure.create') && <button type="button" className="secondary-button small" onClick={() => setDialog({ kind: 'dept-add', parent: null })}>＋ 新增部门</button>}
          </div>
          <input type="search" aria-label="搜索部门或人员" placeholder="搜索部门或人员" value={treeQ} onChange={(e) => setTreeQ(e.target.value)} />
          <div className="between">
            <small className="muted" role="status">{search ? (search.ids.size ? `找到 ${search.ids.size} 个相关部门` : '没有找到相关部门或人员') : `${allBranchIds.length} 个部门 · ${staff.filter((x) => x.status === 'active').length} 名在职`}</small>
            {!search && tree.some((n) => n.children.length > 0) && (
              <span className="row-actions">
                <button type="button" className="link-button" onClick={() => setExpanded(new Set(flattenDepartments(tree).filter((d) => (findNode(tree, d.id)?.children.length ?? 0) > 0).map((d) => d.id)))}>全部展开</button>
                <button type="button" className="link-button" onClick={() => setExpanded(new Set())}>全部收起</button>
              </span>
            )}
          </div>
          {tree.length === 0 && <p className="muted">还没有部门，点「新增部门」建立第一个。</p>}
          {search && search.ids.size === 0 && <p className="muted">换个关键词再找。</p>}
          <DepartmentTree nodes={tree} depth={0} selectedId={selectedId} expanded={expanded} forceOpen={search ? search.ids : null} headcount={headcount} hits={search?.hits ?? new Map()}
            onToggleOpen={(id) => setExpanded((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
            onDropMove={can('org.structure.edit') && !search ? dropMove : undefined} onSelect={(id) => { setSelectedId(id); setMobileDetail(true); }} />
        </section>
        <div className={`org-detail-pane${mobileDetail ? ' has-selection' : ''}`}>
          {selected ? (
            <DepartmentDossier id={selected.id} version={version} onSelect={(id) => { setSelectedId(id); setExpanded((cur) => new Set([...cur, selected.id])); }} onBack={() => setMobileDetail(false)}
              actions={<>
                {can('org.structure.create') && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'dept-add', parent: selected })}>新增下级</button>}
                {can('org.structure.create') && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'position', position: null })}>新增岗位</button>}
                {can('org.structure.edit') && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'dept-rename', node: selected })}>编辑部门</button>}
                {can('org.structure.edit') && <button type="button" className="link-button" aria-label={`上移${selected.name}`} onClick={() => void moveSibling(selected, -1)}>上移</button>}
                {can('org.structure.edit') && <button type="button" className="link-button" aria-label={`下移${selected.name}`} onClick={() => void moveSibling(selected, 1)}>下移</button>}
                {can('org.structure.edit') && <button type="button" className="link-button" onClick={() => (selected.status === 'inactive' ? void orgApi.updateDepartment(selected.id, { status: 'active' }).then(reload).catch((e) => setError(errText(e))) : setDialog({ kind: 'dept-disable', node: selected }))}>{selected.status === 'inactive' ? '启用' : '停用'}</button>}
                {can('org.structure.delete') && <button type="button" className="link-button danger-text" onClick={() => setDialog({ kind: 'dept-delete', node: selected })}>删除</button>}
              </>} />
          ) : <section className="card pad"><p className="muted">选择左侧的部门，查看它的岗位、人员和下级部门。</p></section>}
        <section className="card pad" style={{ marginTop: 16 }}>
          <div className="between">
            <h2 className="section-title">岗位与权限</h2>
            {can('org.structure.create') && <button type="button" className="secondary-button small" onClick={() => setDialog({ kind: 'position', position: null })}>＋ 新增岗位</button>}
          </div>
          {positions.length === 0 && <p className="muted">还没有岗位</p>}
          {positions.map((p) => (
            <div key={p.id} className="line-item col">
              <div className="between">
                <strong>{p.name}</strong>
                <span className="muted">{p.userCount} 人</span>
              </div>
              <small className="muted">{deptName(p.departmentId)} · {LEVEL_LABELS[p.level]} · {WORKSPACE_LABELS[p.workspaceType] ?? p.workspaceType} · {p.permissions.length} 项权限</small>
              <div className="row-actions">
                {can('org.structure.edit') && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'position', position: p })}>编辑与授权</button>}
                {can('org.structure.delete') && <button type="button" className="link-button danger-text" onClick={() => setDialog({ kind: 'position-delete', position: p })}>删除</button>}
              </div>
            </div>
          ))}
        </section>
        </div>
      </div>

      {dialog?.kind === 'dept-add' && (
        <NameDialog title={dialog.parent ? `在「${dialog.parent.name}」下新增部门` : '新增部门'} onClose={() => setDialog(null)}
          onSubmit={async (name) => { await orgApi.addDepartment(name, dialog.parent?.id); await done(); }} />
      )}
      {dialog?.kind === 'dept-rename' && (
        <DeptEditDialog node={dialog.node} tree={tree} onClose={() => setDialog(null)}
          onSubmit={async (v) => { await orgApi.updateDepartment(dialog.node.id, v); await done(); }} />
      )}
      {dialog?.kind === 'dept-delete' && (
        <DeptDeleteDialog node={dialog.node} tree={tree} onClose={() => setDialog(null)}
          onConfirm={async (to) => { await orgApi.deleteDepartment(dialog.node.id, to); await done(); }} />
      )}
      {dialog?.kind === 'dept-disable' && (
        <ConfirmDialog title={`停用部门「${dialog.node.name}」`} text="停用后不能再往这个部门里加岗位和员工；已有的人员不动。可随时重新启用。" confirmLabel="确认停用" reasonLabel="停用原因" onClose={() => setDialog(null)}
          onConfirm={async (reason) => { await orgApi.updateDepartment(dialog.node.id, { status: 'inactive', reason }); await done(); }} />
      )}
      {dialog?.kind === 'position' && (
        <PositionDialog position={dialog.position} defaultDepartmentId={selectedId} departments={tree} catalog={catalog} canEditPerms={can('org.structure.edit')} onClose={() => setDialog(null)} onSaved={() => void done()} />
      )}
      {dialog?.kind === 'position-delete' && (
        <ConfirmDialog title={`删除岗位「${dialog.position.name}」`} text="岗位上还有员工时不能删除，请先给他们换岗位。" onClose={() => setDialog(null)}
          onConfirm={async () => { await orgApi.deletePosition(dialog.position.id); await done(); }} />
      )}
    </div>
  );
}

export function ConfirmDialog({ title, text, confirmLabel = '确认删除', reasonLabel, onClose, onConfirm }: { title: string; text: string; confirmLabel?: string; reasonLabel?: string; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label={title} onSubmit={async (e) => {
        e.preventDefault();
        if (reasonLabel && reason.trim().length < 2) return setError(`请填写${reasonLabel}`);
        setBusy(true);
        try { await onConfirm(reason.trim()); } catch (err) { setError(errText(err)); setBusy(false); }
      }}>
        <div className="modal-head"><strong>{title}</strong></div>
        <div className="modal-body">
          <p>{text}</p>
          {reasonLabel && <label>{reasonLabel}<input autoFocus value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button danger-fill" disabled={busy}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

