import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { CommissionsTab, WagesTab } from './LedgerTabs';
import { OverviewTab } from './OverviewTab';
import { RulesTab } from './RulesTab';
import { SchedulesTab } from './SchedulesTab';
import { SessionDetailDialog } from './SessionDetailDialog';
import { SessionsTab } from './SessionsTab';
import { SettlementsTab } from './SettlementsTab';

const TAB_KEY = 'kudesi.live.tab';
const TABS = [
  ['overview', '全览'], ['schedules', '排场'], ['sessions', '场次记录'], ['review', '待审核'], ['commissions', '提成记录'], ['wages', '主播工资'], ['settlements', '提成结算'], ['rules', '提成规则'],
] as const;
type TabKey = (typeof TABS)[number][0];

/** 直播管理：全览、排场、场次、审核、提成工资、月结和规则，按权限显示页签（记住上次打开的页签）。 */
export function LiveManagePage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const canView = can('features.live.view') || can('live.manage');
  const canAll = can('live.commissions.view');
  const visible = TABS.filter(([k]) => (k === 'commissions' || k === 'wages' ? true : k === 'settlements' ? canAll || can('live.manage') : canView));
  const remembered = (() => { try { return localStorage.getItem(TAB_KEY); } catch { return null; } })();
  const wanted = params.get('tab') ?? remembered;
  const current: TabKey = (visible.find(([k]) => k === wanted)?.[0] ?? visible[0]?.[0] ?? 'overview') as TabKey;
  const [openId, setOpenId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const pick = (k: TabKey) => {
    try { localStorage.setItem(TAB_KEY, k); } catch { /* 本机存不了就不记 */ }
    setParams(k === visible[0]?.[0] ? {} : { tab: k }, { replace: true });
  };
  return (
    <div className="live-page">
      <div className="page-head"><div><h1>直播管理</h1><p className="muted">排场、场次、审核、提成与月结。主播、中控的日常操作在「我的直播」。</p></div></div>
      <div className="tab-group host-tabs" role="tablist" aria-label="直播管理分区">
        {visible.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={k === current} className={k === current ? 'chip active' : 'chip'} onClick={() => pick(k)}>{label}</button>)}
      </div>
      {current === 'overview' && <OverviewTab onOpenSession={setOpenId} />}
      {current === 'schedules' && <SchedulesTab />}
      {current === 'sessions' && <SessionsTab onOpen={setOpenId} refreshKey={tick} />}
      {current === 'review' && <SessionsTab presetStatus="submitted" onOpen={setOpenId} refreshKey={tick} />}
      {current === 'commissions' && <CommissionsTab canAll={canAll} onOpen={setOpenId} />}
      {current === 'wages' && <WagesTab canAll={canAll} onOpen={setOpenId} />}
      {current === 'settlements' && <SettlementsTab onOpenSession={setOpenId} />}
      {current === 'rules' && <RulesTab />}
      {openId !== null && <SessionDetailDialog id={openId} onClose={() => setOpenId(null)} onChanged={() => setTick((t) => t + 1)} />}
    </div>
  );
}
