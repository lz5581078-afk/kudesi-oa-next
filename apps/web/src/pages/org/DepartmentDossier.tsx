import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { orgApi, LEVEL_LABELS, type DepartmentProfile, type DepartmentNode } from './orgApi';

const STAFF_STATE: Record<string, string> = { active: '在职', disabled: '已停用', inactive: '已停用' };

/** 部门卷宗：选中一个部门后看它的岗位、人员、主管、下级部门（旧系统“组织架构”右侧），数据来自 /org/departments/:id/profile。 */
export function DepartmentDossier({ id, version, actions, onSelect, onBack }: {
  id: number; version: number; actions: React.ReactNode; onSelect: (id: number) => void; onBack?: () => void;
}) {
  const [profile, setProfile] = useState<DepartmentProfile | null>(null);
  const [error, setError] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    setProfile(null); setError(''); setQ('');
    orgApi.departmentProfile(id).then(setProfile).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [id, version]);

  const staff = profile?.staff ?? [];
  const groupsOf = (s: unknown) => ((s as { groups?: string[] }).groups ?? []).join('、');
  const shown = useMemo(() => staff
    .filter((s) => showInactive || s.status === 'active')
    .filter((s) => !q.trim() || `${s.name}${s.account}${s.positionName ?? ''}${s.managerName ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())), [staff, showInactive, q]);

  if (error) return <div role="alert" className="notice error">{error}</div>;
  if (!profile) return <p className="muted">加载中…</p>;
  const d = profile.department;
  const inactiveCount = staff.filter((s) => s.status !== 'active').length;
  return (
    <section className="card pad dept-dossier" aria-label="部门卷宗">
      {onBack && <button type="button" className="link-button dept-back" onClick={onBack}>← 返回部门列表</button>}
      <div className="between">
        <div>
          <h2 className="section-title" style={{ margin: 0 }}>{d.name}{d.status === 'inactive' && <span className="pill warn"> 已停用</span>}</h2>
          <small className="muted">{d.parentName ? `上级：${d.parentName}` : '一级部门'}</small>
        </div>
        <div className="row-actions">{actions}</div>
      </div>
      <dl className="key-facts" aria-label="部门概况">
        <div><dt>在职人员</dt><dd>{profile.headcount} 人{inactiveCount > 0 && <small className="muted">（另有停用 {inactiveCount} 人）</small>}</dd></div>
        <div><dt>岗位</dt><dd>{profile.positions.length} 个</dd></div>
        <div><dt>部门主管</dt><dd>{d.managerName ?? <span className="muted">未设置</span>}</dd></div>
        <div><dt>下级部门</dt><dd>{(profile.children as unknown[] | undefined)?.length ?? 0} 个</dd></div>
      </dl>

      <h3 className="section-title">岗位（{profile.positions.length}）</h3>
      {profile.positions.length === 0 ? <p className="muted">这个部门还没有岗位。岗位是流程、任务和审批找人的依据，可在下方「岗位与权限」新增。</p> : (
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>岗位</th><th>层级</th><th className="num">在岗</th><th>状态</th></tr></thead>
          <tbody>{profile.positions.map((p) => (
            <tr key={p.id}><td>{p.name}</td><td>{LEVEL_LABELS[p.level]}</td><td className="num">{p.userCount}</td><td>{p.status === 'active' ? '启用' : '已停用'}</td></tr>
          ))}</tbody>
        </table></div>
      )}

      <div className="between">
        <h3 className="section-title">人员（{staff.filter((s) => s.status === 'active').length}）</h3>
        <label className="check-line"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />显示已停用</label>
      </div>
      {staff.length > 6 && <input type="search" aria-label="搜索本部门人员" placeholder="搜索姓名、岗位、上级" value={q} onChange={(e) => setQ(e.target.value)} />}
      {shown.length === 0 ? <p className="muted">{staff.length ? '没有匹配的人员' : '这个部门还没有人员，请到「员工与权限」新增并选择这个部门。'}</p> : (
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>姓名</th><th>岗位</th><th>直属上级</th><th>职责组</th><th>状态</th></tr></thead>
          <tbody>{shown.map((s) => (
            <tr key={s.id}><td>{s.name}</td><td>{s.positionName ?? '—'}</td><td>{s.managerName ?? '—'}</td><td>{groupsOf(s) || '—'}</td><td>{STAFF_STATE[s.status] ?? s.status}</td></tr>
          ))}</tbody>
        </table></div>
      )}

      <h3 className="section-title">下级部门（{(profile.children as unknown[] | undefined)?.length ?? 0}）</h3>
      {((profile.children as Array<{ id: number; name: string; status: string; headcount: number }> | undefined) ?? []).length === 0 ? <p className="muted">没有下级部门。</p> : (
        <ul className="plain-list">{(profile.children as Array<{ id: number; name: string; status: string; headcount: number }>).map((c) => (
          <li key={c.id} className="line-item between">
            <button type="button" className="link-button" onClick={() => onSelect(c.id)}>{c.name}</button>
            <small className="muted">{c.headcount} 人{c.status === 'inactive' ? ' · 已停用' : ''}</small>
          </li>
        ))}</ul>
      )}

      <h3 className="section-title">派单兜底</h3>
      <ul className="muted plain-list">
        <li>流程和任务先按岗位找人，再按职责组找人。</li>
        <li>岗位没有在职人员时，事项会进入无人处理异常，由管理员处理。</li>
        <li>人员停用时，未完成事项交接给同岗位或直属上级（停用员工时选择接收人）。</li>
      </ul>
    </section>
  );
}

/** 找出一个部门的所有祖先 id（搜索命中时要展开它们）。 */
export function ancestorsOf(nodes: DepartmentNode[], targetId: number, path: number[] = []): number[] | null {
  for (const n of nodes) {
    if (n.id === targetId) return path;
    const r = ancestorsOf(n.children, targetId, [...path, n.id]);
    if (r) return r;
  }
  return null;
}
