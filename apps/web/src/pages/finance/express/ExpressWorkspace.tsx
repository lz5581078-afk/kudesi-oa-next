import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../../auth/AuthContext';
import { TabHost, type HostTab } from '../../../layout/TabHost';
import { expressApi, type TreeCarrier } from './expressApi';
import { ExpressWorkspaceContext, type ExpressLocation } from './ExpressWorkspaceContext';
import './expressWorkspace.css';

/** The existing host owns the only tab bar; location and shared summary precede it. */
export function ExpressWorkspace({ tabs }: { tabs: HostTab[] }) {
  const { can } = useAuth();
  const [, setParams] = useSearchParams();
  const [location, setLocation] = useState<ExpressLocation | null>(null);
  const [carriers, acceptCarriers] = useState<TreeCarrier[] | null>(null);
  const [runCount, setRunCount] = useState<number | null>(null);
  const [error, setError] = useState('');
  const canZone = can('finance.zone-suggestion.view') && can('product.cost.view');
  const refreshCounts = useCallback(() => {
    if (canZone) void expressApi.zoneRuns(1, 1).then(result => setRunCount(result.total)).catch(() => setRunCount(null));
  }, [canZone]);
  useEffect(() => {
    let active = true;
    void expressApi.tree().then(result => { if (active) { acceptCarriers(result.carriers); setError(''); } }).catch(e => { if (active) setError((e as Error).message || '读取失败'); });
    return () => { active = false; };
  }, []);
  useEffect(refreshCounts, [refreshCounts]);
  const context = useMemo(() => ({ setLocation, acceptCarriers, refreshCounts }), [refreshCounts]);
  const detail = Boolean(location?.branchName);
  const beforeNavigation = <>
    <div className="express-workspace-title"><h1>快递价格表</h1><p>快递公司、经营网点、价格版本与分区运费</p></div>
    <nav className="express-workspace-location" aria-label="快递资料位置"><button type="button" className={!detail ? 'current' : ''} onClick={() => { location?.companies(); setParams({}, { replace: true }); }}>快递公司</button><span>/</span><button type="button" disabled={!detail} className={detail && !location?.versionName ? 'current' : ''} onClick={() => location?.versions()}>{location?.branchName || '经营网点'}</button><span>/</span><span className={location?.versionName ? 'current' : ''}>{location?.versionName || '价格版本'}</span></nav>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!detail && <div className="express-workspace-overview" aria-label="快递价格汇总"><div><strong>{carriers?.length ?? '—'}</strong><span>快递公司</span></div><div><strong>{carriers ? carriers.reduce((count, c) => count + c.branches.length, 0) : '—'}</strong><span>经营网点</span></div><div><strong>{carriers ? carriers.flatMap(c => c.branches).filter(b => b.versions.some(v => v.isCurrent && v.cooperationStatus === 'active')).length : '—'}</strong><span>合作中版本</span></div><div><strong>{runCount ?? '—'}</strong><span>建议记录</span></div></div>}
  </>;
  return <ExpressWorkspaceContext.Provider value={context}><div className="express-host-workspace"><TabHost tabs={tabs} beforeNavigation={beforeNavigation} hideNavigation={detail} /></div></ExpressWorkspaceContext.Provider>;
}
