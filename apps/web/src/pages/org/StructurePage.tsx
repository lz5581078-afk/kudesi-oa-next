import { FormEvent, useCallback, useEffect, useState } from 'react';
import { createChecker } from '@kudesi/shared';
import type { CatalogGroup } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../api/client';
import { PermissionPicker } from './PermissionPicker';
import { orgApi, flattenDepartments, WORKSPACE_LABELS, LEVEL_LABELS, type DepartmentNode, type PositionDto, type PositionLevel } from './orgApi';

function errText(e: unknown, fallback = '操作失败') {
  return e instanceof ApiError ? e.message : fallback;
}

function DepartmentTree({ nodes, depth, canEdit, canCreate, canDelete, onAdd, onRename, onDelete, onToggle }: {
  nodes: DepartmentNode[]; depth: number; canEdit: boolean; canCreate: boolean; canDelete: boolean;
  onAdd: (parent: DepartmentNode) => void; onRename: (n: DepartmentNode) => void; onDelete: (n: DepartmentNode) => void; onToggle: (n: DepartmentNode) => void;
}) {
  return (
    <ul className="tree">
      {nodes.map((n) => (
        <li key={n.id}>
          <div className="line-item" style={{ paddingLeft: depth * 16 }}>
            <strong>{n.name}{n.status === 'inactive' && <span className="pill warn"> 已停用</span>}</strong>
            <span className="row-actions">
              {canCreate && <button type="button" className="link-button" onClick={() => onAdd(n)}>加下级</button>}
              {canEdit && <button type="button" className="link-button" onClick={() => onRename(n)}>编辑</button>}
              {canEdit && <button type="button" className="link-button" onClick={() => onToggle(n)}>{n.status === 'inactive' ? '启用' : '停用'}</button>}
              {canDelete && <button type="button" className="link-button danger-text" onClick={() => onDelete(n)}>删除</button>}
            </span>
          </div>
          <DepartmentTree nodes={n.children} depth={depth + 1} canEdit={canEdit} canCreate={canCreate} canDelete={canDelete} onAdd={onAdd} onRename={onRename} onDelete={onDelete} onToggle={onToggle} />
        </li>
      ))}
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

function PositionDialog({ position, departments, catalog, canEditPerms, onClose, onSaved }: {
  position: PositionDto | null; departments: DepartmentNode[]; catalog: CatalogGroup[]; canEditPerms: boolean;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(position?.name ?? '');
  const [departmentId, setDepartmentId] = useState<number | null>(position?.departmentId ?? null);
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
        await orgApi.updatePosition(position.id, { name: name.trim(), departmentId, workspaceType, level, supervisorPositionId: supervisor, description: description.trim() || null });
        if (canEditPerms) await orgApi.setPositionPermissions(position.id, perms);
      } else {
        await orgApi.addPosition({ name: name.trim(), departmentId, workspaceType, level, supervisorPositionId: supervisor, description: description.trim() || undefined });
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

function DeptEditDialog({ node, tree, onClose, onSubmit }: { node: DepartmentNode; tree: DepartmentNode[]; onClose: () => void; onSubmit: (v: { name: string; parentId: number | null; sortOrder: number }) => Promise<void> }) {
  const [name, setName] = useState(node.name);
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
    try { await onSubmit({ name: name.trim(), parentId, sortOrder: Number(sortOrder) || 0 }); } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="编辑部门" onSubmit={submit}>
        <div className="modal-head"><strong>编辑部门：{node.name}</strong></div>
        <div className="modal-body">
          <label>名称<input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
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
          <p>如果部门下有下级部门、岗位或员工，请选择接收部门，它们会整体转过去；空部门可以不选直接删除。</p>
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
  const [dialog, setDialog] = useState<
    | { kind: 'dept-add'; parent: DepartmentNode | null } | { kind: 'dept-rename'; node: DepartmentNode } | { kind: 'dept-delete'; node: DepartmentNode } | { kind: 'dept-disable'; node: DepartmentNode }
    | { kind: 'position'; position: PositionDto | null } | { kind: 'position-delete'; position: PositionDto } | null
  >(null);

  const reload = useCallback(async () => {
    try {
      const [t, p, c] = await Promise.all([orgApi.departments(), orgApi.positions(), orgApi.catalog()]);
      setTree(t); setPositions(p); setCatalog(c); setError('');
    } catch (e) { setError(errText(e, '加载失败')); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const deptName = (id: number | null) => flattenDepartments(tree).find((d) => d.id === id)?.name ?? '—';
  const done = async () => { setDialog(null); await reload(); };

  return (
    <div>
      <div className="page-head"><h1>部门与岗位</h1></div>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="two-col">
        <section className="card pad">
          <div className="between">
            <h2 className="section-title">部门</h2>
            {can('org.structure.create') && <button type="button" className="secondary-button small" onClick={() => setDialog({ kind: 'dept-add', parent: null })}>＋ 新增部门</button>}
          </div>
          {tree.length === 0 && <p className="muted">还没有部门</p>}
          <DepartmentTree nodes={tree} depth={0} canEdit={can('org.structure.edit')} canCreate={can('org.structure.create')} canDelete={can('org.structure.delete')}
            onAdd={(n) => setDialog({ kind: 'dept-add', parent: n })} onRename={(n) => setDialog({ kind: 'dept-rename', node: n })} onDelete={(n) => setDialog({ kind: 'dept-delete', node: n })}
            onToggle={(n) => (n.status === 'inactive' ? void orgApi.updateDepartment(n.id, { status: 'active' }).then(reload).catch((e) => setError(errText(e))) : setDialog({ kind: 'dept-disable', node: n }))} />
        </section>
        <section className="card pad">
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
        <PositionDialog position={dialog.position} departments={tree} catalog={catalog} canEditPerms={can('org.structure.edit')} onClose={() => setDialog(null)} onSaved={() => void done()} />
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

