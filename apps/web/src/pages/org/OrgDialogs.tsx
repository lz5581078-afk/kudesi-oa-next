import { FormEvent, useEffect, useState } from 'react';
import type { CatalogGroup } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { PermissionPicker } from './PermissionPicker';
import { orgApi, flattenDepartments, WORKSPACE_LABELS, LEVEL_LABELS, type DepartmentNode, type PositionDto, type PositionLevel } from './orgApi';

export function errText(e: unknown, fallback = '操作失败') {
  return e instanceof ApiError ? e.message : fallback;
}

export function NameDialog({ title, initial, onClose, onSubmit }: { title: string; initial?: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
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

export function PositionDialog({ position, defaultDepartmentId, departments, catalog, canEditPerms, onClose, onSaved, onDelete }: {
  position: PositionDto | null; defaultDepartmentId?: number | null; departments: DepartmentNode[]; catalog: CatalogGroup[]; canEditPerms: boolean;
  onClose: () => void; onSaved: () => void;
  /** 编辑已有岗位时给出“删除岗位”入口（有删除权限才传） */
  onDelete?: () => void;
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
          {position && onDelete && <button type="button" className="link-button danger-text org-foot-left" onClick={onDelete}>删除岗位</button>}
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>保存</button>
        </div>
      </form>
    </div>
  );
}

export function DeptEditDialog({ node, tree, onClose, onSubmit }: { node: DepartmentNode; tree: DepartmentNode[]; onClose: () => void; onSubmit: (v: { name: string; parentId: number | null; managerId: number | null; sortOrder: number }) => Promise<void> }) {
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

export function DeptDeleteDialog({ node, tree, onClose, onConfirm }: { node: DepartmentNode; tree: DepartmentNode[]; onClose: () => void; onConfirm: (transferToId?: number) => Promise<void> }) {
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
          <p>如果部门下有下级部门、岗位、员工、固定资产或职责组，请选择接收部门，它们会整体转过去；已停用的员工会归入“离职员工”，不再出现在组织架构里；空部门可以不选直接删除。</p>
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

