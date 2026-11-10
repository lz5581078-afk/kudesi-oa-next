import { DailyWorkPanel } from '../live/DailyWorkPanel';
import { LiveCheckinPanel } from '../live/LiveCheckinPanel';
import { PersonalLiveIncome } from './PersonalLiveIncome';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { deskFor, deskLinks, groupDeskPositions, type DeskCatalog } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DeskLiveLinks } from './DeskLiveLinks';
import { DailyBusinessPanel } from './DailyBusinessPanel';
import { RoleDesk, type DeskView } from './RoleDesk';
import { workspaceApi, type DeskDto } from './workspaceApi';

/** 岗位工作台：一个岗位一个工作台，按部门分组选择；默认进入本人主岗位。 */
export function DeskPage() {
  const { can, user } = useAuth();
  const isAdmin = !!user?.permissions?.isCompanyAdmin;
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<DeskCatalog | null>(null);
  const [desk, setDesk] = useState<DeskDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { workspaceApi.catalog().then(setCatalog).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, []);
  const wanted = Number(params.get('position')) || null;
  const current = useMemo(() => catalog?.positions.find((p) => p.id === (wanted ?? catalog.defaultPositionId ?? (isAdmin ? catalog.positions[0]?.id : -1))) ?? null, [catalog, wanted, isAdmin]);
  useEffect(() => {
    let active = true;
    setDesk(null);
    setError('');
    if (!current) return;
    workspaceApi.desk(current.id).then((d) => { if (active) setDesk(d); }).catch((e) => { if (active) setError(e instanceof ApiError ? e.message : '加载失败'); });
    return () => { active = false; };
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupDeskPositions(catalog?.positions ?? []), [catalog]);

  if (error) return <div role="alert" className="notice error">{error}</div>;
  if (!catalog) return <p className="muted" role="status">正在读取岗位…</p>;
  if (catalog.positions.length === 0) return (
    <div className="empty-state muted"><strong>你还没有分配岗位</strong><span>请联系管理员在“员工与权限”里给你分配岗位；个人任务和流程在“个人工作台”里。</span></div>
  );
  if (!current && !wanted && catalog.defaultPositionId == null) return <div className="empty-state muted"><strong>你还没有分配有效岗位</strong><span>请联系管理员分配主岗位或兼岗。</span></div>;
  if (!current) return <div role="alert" className="notice error">没有这个岗位的工作台，或你无权查看。</div>;
  const position = desk?.position.id === current.id ? { ...current, referenceProfile: desk.position.referenceProfile } : current;
  const type = position.workspaceType;
  const profile = position.referenceProfile;
  const operating = type === 'operations' && (!profile || ['operations', 'operations_manager'].includes(profile));
  const aiDepartment = position.departmentPath.split('/').some(name => name.trim() === 'AI电商部门');
  const checkinType = type === 'live_anchor' || type === 'live_control' ? type : operating ? 'operations' : null;
  const showPersonalLive = !!checkinType && (position.assigned || isAdmin);
  const def = deskFor(type, profile);
  const view: DeskView | null = desk?.position.id === current.id ? {
    title: desk.title,
    subtitle: [current.departmentPath, def.focus].filter(Boolean).join(' · '),
    links: deskLinks(def, isAdmin ? 'boss' : current.level, can, isAdmin),
    skuApplication: (current.assigned || isAdmin) && (operating || type === 'live_control') && can('flow.apply.view'),
    companyProducts: operating || type === 'support' || aiDepartment,
    operations: operating && profile !== 'operations_manager',
    linksHint: def.focus,
    cards: desk.cards,
    pending: desk.pending,
    blank: current.workspaceType === 'blank',
    top: refreshKey => <>
      {operating && can('resource.store-daily-metrics.view') && <DailyBusinessPanel refreshKey={refreshKey} />}
      {showPersonalLive && checkinType && <div className="desk-live-panels">
        {isAdmin && !position.assigned && <p className="notice" role="status">管理员可查看本岗位操作入口；日常工作和上下播仍按当前账号的本人排班记录。</p>}
        <LiveCheckinPanel key={`checkin-${refreshKey}`} workspaceType={checkinType} />
        {checkinType !== 'operations' && <DailyWorkPanel key={`daily-${refreshKey}`} personal />}
      </div>}
    </>,
    side: refreshKey => <>
      <DeskLiveLinks position={position} can={can} isAdmin={isAdmin} />
      {showPersonalLive && <PersonalLiveIncome refreshKey={refreshKey} />}
    </>,
  } : null;
  return (
    <div>
      <div className="ws-picker card">
        <label>岗位
          <select aria-label="选择岗位工作台" value={current?.id ?? ''} onChange={(e) => setParams({ position: e.target.value })}>
            {groups.map((g) => (
              <optgroup key={g.title} label={g.title}>
                {g.items.map((p) => <option key={p.id} value={p.id}>{p.name}工作台{p.assigned ? (p.isPrimary ? '（我的主岗位）' : '（我的岗位）') : ''}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        {!catalog.canBrowse && <span className="muted">只显示你在岗的岗位</span>}
      </div>
      {view ? <RoleDesk key={current!.id} view={view} /> : <p className="muted" role="status">正在读取工作台…</p>}
    </div>
  );
}
