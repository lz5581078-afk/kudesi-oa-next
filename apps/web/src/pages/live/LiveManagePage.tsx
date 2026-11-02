import { LiveQr } from './LiveQr';
import { NotificationsTab } from './NotificationsTab';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { AppbarHint, useAppbarBare, useHasAppbarSlot } from '../../layout/AppbarSlot';
import './liveHeader.css';
import { PayrollTab } from './PayrollTab';
import { ManualReportsTab } from './ManualReportsTab';
import { OverviewTab } from './OverviewTab';
import { RulesTab } from './RulesTab';
import { SchedulesTab } from './SchedulesTab';
import { SessionDetailDialog } from './SessionDetailDialog';
import { SourceStatusNotice } from './liveUi';
import { SessionsTab } from './SessionsTab';
import { SettlementsTab } from './SettlementsTab';

const TAB_KEY = 'kudesi.live.tab';
const TABS = [
  ['overview', '全览'], ['schedules', '排场'], ['sessions', '场次记录'], ['review', '待审核'], ['wages', '主播工资'], ['control', '中控工资'], ['operator', '运营提成'], ['settlements', '工资结算'], ['manual', '人事补报'], ['rules', '提成规则'], ['notifications', '通知设置'], ['qr', '上下播二维码'],
] as const;
type TabKey = (typeof TABS)[number][0];

/** 直播管理：全览、排场、场次、审核、提成工资、月结和规则，按权限显示页签（记住上次打开的页签）。 */
export function LiveManagePage() {
  useAppbarBare();
  const hasAppbar = useHasAppbarSlot();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const canView = can('features.live.view') || can('live.manage');
  const canAll = can('live.commissions.view');
  const visible = TABS.filter(([k]) => (['wages','control','operator'].includes(k) ? true : ['manual','notifications','qr'].includes(k)?can('live.manage'): k === 'settlements' ? canAll || can('live.manage') : canView));
  const remembered = (() => { try { return localStorage.getItem(TAB_KEY); } catch { return null; } })();
  const wanted = (params.get('tab')==='commissions'?'wages':params.get('tab')) ?? (remembered==='commissions'?'wages':remembered);
  const current: TabKey = (visible.find(([k]) => k === wanted)?.[0] ?? visible[0]?.[0] ?? 'overview') as TabKey;
  const [openId, setOpenId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const pick = (k: TabKey) => {
    try { localStorage.setItem(TAB_KEY, k); } catch { /* 本机存不了就不记 */ }
    setParams(k === visible[0]?.[0] ? {} : { tab: k }, { replace: true });
  };
  return (
    <div className="live-page">
      <AppbarHint><span className="live-header-summary" title="房间排场、业绩审核、工资及售后结算；主播、中控日常操作请到「我的直播」。">排场 · 审核 · 工资结算<span className="live-header-guide">；主播、中控请到「我的直播」</span></span></AppbarHint>
      {!hasAppbar && <h1 className="live-header-fallback">直播管理</h1>}
      {canAll || can('live.manage') ? <SourceStatusNotice /> : null}
      <div className="tab-group host-tabs" role="tablist" aria-label="直播管理分区">
        {visible.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={k === current} className={k === current ? 'chip active' : 'chip'} onClick={() => pick(k)}>{label}</button>)}
      </div>
      {current === 'overview' && <OverviewTab onOpenSession={setOpenId} />}
      {current === 'schedules' && <SchedulesTab />}
      {current === 'sessions' && <SessionsTab onOpen={setOpenId} refreshKey={tick} />}
      {current === 'review' && <SessionsTab presetStatus="submitted" onOpen={setOpenId} refreshKey={tick} />}
      {current === 'wages' && <PayrollTab role="anchor" onOpen={setOpenId} />}
      {current === 'control' && <PayrollTab role="control" onOpen={setOpenId} />}
      {current === 'operator' && <PayrollTab role="operator" onOpen={setOpenId} />}
      {current === 'manual' && <ManualReportsTab onOpen={setOpenId} />}
      {current === 'settlements' && <SettlementsTab onOpenSession={setOpenId} />}
      {current === 'rules' && <RulesTab />}
      {current === 'notifications' && <NotificationsTab />}
      {current === 'qr' && <LiveQr />}
      {openId !== null && <SessionDetailDialog id={openId} onClose={() => setOpenId(null)} onChanged={() => setTick((t) => t + 1)} />}
    </div>
  );
}
