import { useCallback, useEffect, useMemo, useState } from 'react';
import { createChecker, resourceDescription } from '@kudesi/shared';
import type { CatalogGroup } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { AppbarHint, useAppbarBare, useHasAppbarSlot } from '../../layout/AppbarSlot';
import { PageHint } from '../../resources/PageHint';
import { orgApi, flattenDepartments, type DepartmentNode, type PositionDto, type StaffDto } from './orgApi';
import { DepartmentDossier } from './DepartmentDossier';
import { DepartmentTree } from './DepartmentTree';
import { StructureManager } from './StructureManager';
import { ancestorsOf, findNode, planMove, type Placement } from './deptMove';
import { ConfirmDialog, DeptDeleteDialog, DeptEditDialog, NameDialog, PositionDialog, errText } from './OrgDialogs';

export { ConfirmDialog };

type Dialog =
  | { kind: 'dept-add'; parent: DepartmentNode | null } | { kind: 'dept-rename'; node: DepartmentNode } | { kind: 'dept-delete'; node: DepartmentNode } | { kind: 'dept-disable'; node: DepartmentNode }
  | { kind: 'position'; position: PositionDto | null } | { kind: 'position-delete'; position: PositionDto } | null;

/** 组织架构（旧版“组织架构”页）：左边部门树，右边选中部门的卷宗；“管理架构”弹窗里按层级拖动、上下架。 */
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
  const [managing, setManaging] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  useAppbarBare();
  const hasSlot = useHasAppbarSlot();
  const hint = <PageHint text={resourceDescription('org-tree') || '公司、部门、岗位和人员关系；岗位是流程、任务和审批找人的依据。'} />;

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
  const posCount = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of positions) if (p.departmentId && p.status === 'active') m.set(p.departmentId, (m.get(p.departmentId) ?? 0) + 1);
    return m;
  }, [positions]);
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
  const allBranchIds = useMemo(() => flattenDepartments(tree).map((d) => d.id), [tree]);
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
  async function toggleStatus(n: DepartmentNode) {
    if (n.status === 'inactive') { try { await orgApi.updateDepartment(n.id, { status: 'active' }); await reload(); } catch (e) { setError(errText(e)); } } else setDialog({ kind: 'dept-disable', node: n });
  }
  const done = async () => { setDialog(null); await reload(); };
  const canDo = { create: can('org.structure.create'), edit: can('org.structure.edit'), delete: can('org.structure.delete') };

  return (
    <div className="res-page org-page">
      {hasSlot ? <AppbarHint>{hint}</AppbarHint> : null}
      {error && <div role="alert" className="notice error m">{error}</div>}
      <div className="org-body">
        <aside className={`org-side org-tree-pane${mobileDetail ? ' has-selection' : ''}`} aria-label="部门树">
          <div className="org-side-head">
            <div>
              <strong>组织架构</strong>
              <small className="muted"> {staff.filter((x) => x.status === 'active').length} 名在职 · {allBranchIds.length} 个部门</small>
            </div>
            {!hasSlot && hint}
            <span className="row-actions">
              {(canDo.create || canDo.edit) && <button type="button" className="res-btn sm" onClick={() => setManaging(true)}>管理架构</button>}
              {canDo.create && <button type="button" className="res-btn sm primary" onClick={() => setDialog({ kind: 'dept-add', parent: null })}>＋ 新增部门</button>}
            </span>
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
          <div className="org-tree-scroll">
            {tree.length === 0 && <p className="muted">还没有部门，点「新增部门」建立第一个。</p>}
            {search && search.ids.size === 0 && <p className="muted">换个关键词再找。</p>}
            <DepartmentTree nodes={tree} depth={0} selectedId={selectedId} expanded={expanded} forceOpen={search ? search.ids : null} headcount={headcount} posCount={posCount} hits={search?.hits ?? new Map()}
              onToggleOpen={(id) => setExpanded((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
              onDropMove={canDo.edit && !search ? dropMove : undefined} onSelect={(id) => { setSelectedId(id); setMobileDetail(true); }} />
          </div>
        </aside>
        <div className={`org-main org-detail-pane${mobileDetail ? ' has-selection' : ''}`}>
          {selected ? (
            <DepartmentDossier id={selected.id} version={version} canCreateStaff={can('org.staff.create')} canEditPosition={canDo.edit}
              onSelect={(id) => { setSelectedId(id); setExpanded((cur) => new Set([...cur, selected.id])); }} onBack={() => setMobileDetail(false)}
              onAddPosition={canDo.create ? () => setDialog({ kind: 'position', position: null }) : undefined}
              onEditPosition={(pid) => { const p = positions.find((x) => x.id === pid); if (p) setDialog({ kind: 'position', position: p }); }}
              actions={<>
                {canDo.create && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'dept-add', parent: selected })}>新增下级</button>}
                {canDo.create && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'position', position: null })}>新增岗位</button>}
                {canDo.edit && <button type="button" className="link-button" onClick={() => setDialog({ kind: 'dept-rename', node: selected })}>编辑部门</button>}
                {canDo.edit && <button type="button" className="link-button" aria-label={`上移${selected.name}`} onClick={() => void moveSibling(selected, -1)}>上移</button>}
                {canDo.edit && <button type="button" className="link-button" aria-label={`下移${selected.name}`} onClick={() => void moveSibling(selected, 1)}>下移</button>}
                {canDo.edit && <button type="button" className="link-button" onClick={() => void toggleStatus(selected)}>{selected.status === 'inactive' ? '启用' : '停用'}</button>}
                {canDo.delete && <button type="button" className="link-button danger-text" onClick={() => setDialog({ kind: 'dept-delete', node: selected })}>删除</button>}
              </>} />
          ) : <section className="org-dossier"><p className="muted pad">选择左侧的部门，查看它的岗位、人员和下级部门。</p></section>}
        </div>
      </div>

      {managing && (
        <StructureManager tree={tree} headcount={headcount} posCount={posCount} selectedId={selectedId} can={canDo} message={error} onClose={() => setManaging(false)}
          onSelect={setSelectedId} onAdd={(parent) => setDialog({ kind: 'dept-add', parent })} onEdit={(node) => setDialog({ kind: 'dept-rename', node })}
          onDelete={(node) => setDialog({ kind: 'dept-delete', node })} onToggleStatus={(n) => void toggleStatus(n)} onDropMove={(s, t, p) => void dropMove(s, t, p)} />
      )}
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
          onConfirm={async (to) => { await orgApi.deleteDepartment(dialog.node.id, to); if (selectedId === dialog.node.id) setSelectedId(null); await done(); }} />
      )}
      {dialog?.kind === 'dept-disable' && (
        <ConfirmDialog title={`停用部门「${dialog.node.name}」`} text="停用后不能再往这个部门里加岗位和员工；已有的人员不动。可随时重新启用。" confirmLabel="确认停用" reasonLabel="停用原因" onClose={() => setDialog(null)}
          onConfirm={async (reason) => { await orgApi.updateDepartment(dialog.node.id, { status: 'inactive', reason }); await done(); }} />
      )}
      {dialog?.kind === 'position' && (
        <PositionDialog position={dialog.position} defaultDepartmentId={selectedId} departments={tree} catalog={catalog} canEditPerms={canDo.edit} onClose={() => setDialog(null)} onSaved={() => void done()}
          onDelete={canDo.delete && dialog.position ? () => setDialog({ kind: 'position-delete', position: dialog.position! }) : undefined} />
      )}
      {dialog?.kind === 'position-delete' && (
        <ConfirmDialog title={`删除岗位「${dialog.position.name}」`} text="岗位上还有员工时不能删除，请先给他们换岗位。" onClose={() => setDialog(null)}
          onConfirm={async () => { await orgApi.deletePosition(dialog.position.id); await done(); }} />
      )}
    </div>
  );
}
