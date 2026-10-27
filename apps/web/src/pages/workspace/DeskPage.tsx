import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { deskFor, deskLinks, groupDeskPositions, type DeskCatalog } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DailyBusinessPanel } from './DailyBusinessPanel';
import { RoleDesk, type DeskView } from './RoleDesk';
import { workspaceApi, type DeskDto } from './workspaceApi';

/** 岗位工作台：一个岗位一个工作台，按部门分组选择；默认进入本人主岗位。 */
export function DeskPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<DeskCatalog | null>(null);
  const [desk, setDesk] = useState<DeskDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { workspaceApi.catalog().then(setCatalog).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, []);
  const wanted = Number(params.get('position')) || null;
  const current = useMemo(() => catalog?.positions.find((p) => p.id === (wanted ?? catalog.defaultPositionId ?? -1)) ?? null, [catalog, wanted]);
  useEffect(() => {
    setDesk(null);
    if (!current) return;
    workspaceApi.desk(current.id).then((d) => { setDesk(d); setError(''); }).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupDeskPositions(catalog?.positions ?? []), [catalog]);

  if (error) return <div role="alert" className="notice error">{error}</div>;
  if (!catalog) return <p className="muted" role="status">正在读取岗位…</p>;
  if (catalog.positions.length === 0) return (
    <div className="empty-state muted"><strong>你还没有分配岗位</strong><span>请联系管理员在“员工与权限”里给你分配岗位；个人任务和流程在“个人工作台”里。</span></div>
  );
  const def = deskFor(current?.workspaceType);
  const view: DeskView | null = current && desk ? {
    title: desk.title,
    subtitle: [current.departmentPath, def.focus].filter(Boolean).join(' · '),
    links: deskLinks(def, current.level, can),
    linksHint: def.focus,
    cards: desk.cards,
    pending: desk.pending,
    blank: current.workspaceType === 'blank',
    top: current.workspaceType === 'operations' && can('resource.store-daily-metrics.view') ? <DailyBusinessPanel /> : undefined,
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
