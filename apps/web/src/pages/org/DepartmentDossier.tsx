import { useEffect, useMemo, useState } from 'react';
import { resourcePagePath } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { orgApi, LEVEL_LABELS, WORKSPACE_LABELS, type DepartmentProfile } from './orgApi';
import { SafeLink } from './SafeLink';

const STAFF_STATE: Record<string, string> = { active: '在职', disabled: '已停用', inactive: '已停用' };

/**
 * 部门卷宗（旧版“组织架构”右侧主区）：头部（名称、上级、操作）→ 四个数字（部门人数/在职人员/岗位数量/部门主管）
 * → 本部门岗位卡片（点开编辑）→ 左：成员列表（可搜索）/ 右：下级部门、职责组、派单兜底。数据来自 /org/departments/:id/profile。
 */
export function DepartmentDossier({ id, version, actions, canCreateStaff, canEditPosition, onSelect, onBack, onAddPosition, onEditPosition }: {
  id: number; version: number; actions: React.ReactNode; canCreateStaff?: boolean; canEditPosition?: boolean;
  onSelect: (id: number) => void; onBack?: () => void; onAddPosition?: () => void; onEditPosition?: (positionId: number) => void;
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
  const shown = useMemo(() => staff
    .filter((s) => showInactive || s.status === 'active')
    .filter((s) => !q.trim() || `${s.name}${s.account}${s.positionName ?? ''}${s.managerName ?? ''}${(s.groups ?? []).join('')}`.toLowerCase().includes(q.trim().toLowerCase())), [staff, showInactive, q]);

  if (error) return <div role="alert" className="notice error">{error}</div>;
  if (!profile) return <p className="muted">加载中…</p>;
  const d = profile.department;
  const activeCount = staff.filter((s) => s.status === 'active').length;
  const inactiveCount = staff.length - activeCount;
  const kids = profile.children ?? [];
  const groups = profile.dutyGroups ?? [];
  const employeesPath = resourcePagePath('employees');
  const groupsPath = resourcePagePath('duty-groups');
  return (
    <section className="org-dossier" aria-label="部门卷宗">
      {onBack && <button type="button" className="link-button dept-back" onClick={onBack}>← 返回部门列表</button>}
      <header className="org-dossier-head">
        <div className="org-dossier-title">
          <h2>{d.name}{d.status === 'inactive' && <span className="pill warn"> 已停用</span>}</h2>
          <small className="muted">{d.parentName ? `上级：${d.parentName}` : '一级部门'} · {activeCount} 名在职 · {profile.positions.length} 个岗位</small>
        </div>
        <div className="row-actions org-dossier-actions">{actions}</div>
      </header>
      <dl className="key-facts org-stats" aria-label="部门概况">
        <div className="stat-blue"><dt>部门人数</dt><dd>{staff.length} 人{inactiveCount > 0 && <small className="muted">（含停用 {inactiveCount} 人）</small>}</dd></div>
        <div className="stat-green"><dt>在职人员</dt><dd>{profile.headcount} 人</dd></div>
        <div className="stat-amber"><dt>岗位数量</dt><dd>{profile.positions.length} 个</dd></div>
        <div className="stat-red"><dt>部门主管</dt><dd>{d.managerName ?? <span className="muted">未设置</span>}</dd></div>
      </dl>

      <section className="org-strip" aria-label="本部门岗位">
        <div className="between">
          <div><strong>本部门岗位</strong> <small className="muted">岗位是流程、任务和审批找人的依据</small></div>
          {onAddPosition && <button type="button" className="secondary-button small" onClick={onAddPosition}>＋ 新增岗位</button>}
        </div>
        <div className="org-pos-cards">
          {profile.positions.map((p) => (
            <button key={p.id} type="button" className={`org-pos-card${p.status === 'inactive' ? ' inactive' : ''}`} disabled={!canEditPosition || !onEditPosition} aria-label={`岗位 ${p.name}`} onClick={() => onEditPosition?.(p.id)}>
              <strong>{p.name}{p.status === 'inactive' && <span className="pill warn"> 已停用</span>}</strong>
              <span className="muted">{LEVEL_LABELS[p.level]}{p.workspaceType ? ` · ${WORKSPACE_LABELS[p.workspaceType] ?? p.workspaceType}` : ''} · {p.userCount} 人{p.dutyCount ? ` · ${p.dutyCount} 条职责` : ''}</span>
            </button>
          ))}
          {profile.positions.length === 0 && (
            <button type="button" className="org-pos-card empty" disabled={!onAddPosition} onClick={onAddPosition}><strong>暂无岗位</strong><span className="muted">{onAddPosition ? '点击新增岗位' : '这个部门还没有岗位'}</span></button>
          )}
        </div>
      </section>

      <div className="org-cols">
        <section className="org-members" aria-label="成员">
          <div className="org-members-bar">
            <strong>成员</strong>
            <small className="muted">{shown.length} / {staff.length}</small>
            <input type="search" aria-label="搜索本部门人员" placeholder="搜索姓名、岗位、上级、职责组" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="check-line"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />显示已停用</label>
            {canCreateStaff && employeesPath && <SafeLink to={`${employeesPath}?dept=${id}&new=1`} className="secondary-button small">＋ 新增成员</SafeLink>}
          </div>
          {shown.length === 0 ? <p className="muted pad">{staff.length ? '没有匹配的人员，换个关键词试试。' : '这个部门还没有人员，请到「员工与权限」新增并选择这个部门。'}</p> : (
            <div className="table-wrap org-members-table"><table className="data-table">
              <thead><tr><th>姓名</th><th>岗位</th><th>账号</th><th>直属上级</th><th>职责组</th><th>状态</th></tr></thead>
              <tbody>{shown.map((s) => (
                <tr key={s.id}>
                  <td><span className="avatar-dot" aria-hidden="true">{s.name.slice(0, 1)}</span>{s.name}</td>
                  <td>{s.positionName ?? '—'}</td><td className="muted">{s.account || '—'}</td><td>{s.managerName ?? '—'}</td>
                  <td>{(s.groups ?? []).join('、') || '—'}</td><td>{STAFF_STATE[s.status] ?? s.status}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>

        <aside className="org-aside">
          <section aria-label="下级部门">
            <div className="between"><strong>下级部门</strong><span className="muted">{kids.length}</span></div>
            {kids.length === 0 ? <p className="muted">暂无下级部门，如需调整结构请用左侧“管理架构”。</p> : (
              <ul className="plain-list">{kids.map((c) => (
                <li key={c.id} className="line-item between">
                  <button type="button" className="link-button" onClick={() => onSelect(c.id)}>{c.name}</button>
                  <small className="muted">{c.headcount} 人{c.status === 'inactive' ? ' · 已停用' : ''}</small>
                </li>
              ))}</ul>
            )}
          </section>
          <section aria-label="本部门职责组">
            <div className="between"><strong>职责组</strong><span className="muted">{groups.length}</span></div>
            {groups.length === 0 ? <p className="muted">还没有职责组归到这个部门。</p> : (
              <ul className="plain-list">{groups.map((g) => (
                <li key={g.id} className="line-item between">
                  {groupsPath ? <SafeLink to={`${groupsPath}?open=${g.id}`} className="link-button">{g.title}</SafeLink> : <span>{g.title}</span>}
                  <small className="muted">{g.memberCount} 人{g.status === 'inactive' ? ' · 已停用' : ''}</small>
                </li>
              ))}</ul>
            )}
          </section>
          <section aria-label="派单兜底">
            <div className="between"><strong>兜底规则</strong><span className="muted">流程任务</span></div>
            <ul className="muted plain-list">
              <li>流程和任务先按岗位找人，再按职责组找人。</li>
              <li>岗位没有在职人员时，事项会进入无人处理异常，由管理员处理。</li>
              <li>人员停用时，未完成事项交接给同岗位或直属上级（停用员工时选择接收人）。</li>
            </ul>
          </section>
        </aside>
      </div>
    </section>
  );
}
