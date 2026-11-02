import { NotificationsTab } from './NotificationsTab';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { AppbarHint, useAppbarBare, useHasAppbarSlot } from '../../layout/AppbarSlot';
import './liveHeader.css';
import './liveWorkspace.css';
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
  ['overview', '全览'], ['schedules', '排场'], ['sessions', '场次记录'], ['review', '待审核'], ['wages', '主播工资'], ['control', '中控工资'], ['operator', '运营提成'], ['settlements', '工资结算'], ['manual', '人事补报'], ['rules', '提成规则'], ['notifications', '通知设置'],
] as const;
type TabKey = (typeof TABS)[number][0];

const SECTION_HELP: Record<string, string> = {
  schedules: '先确定时间与人员，再选择平台账号、店铺和在卖产品。',
  sessions: '查看各场直播的填报、逐店业绩与审核结果。',
  review: '核对各角色和店铺的业绩，再确认本场计时工资与分平台提成。',
  wages: '按人员汇总主播计时工资与各平台提成，可追溯到每一场直播。',
  control: '查看中控计时工资与提成，场次工资只计算一次。',
  operator: '查看运营提成与场次明细，传统运营担任中控的提成归入本人台账。',
  settlements: '选择结算期间，核对退款，再提交工资结算审批。',
  manual: '补录试播、漏报或接口异常场次，保存核对后提交审核。',
  rules: '管理生效版本与销售额档位，历史核算保留当时的规则快照。',
  notifications: '设置直播提醒、经营日报和接口异常的接收范围。',
};

/** 直播管理：全览、排场、场次、审核、提成工资、月结和规则，按权限显示页签（记住上次打开的页签）。 */
export function LiveManagePage() {
  useAppbarBare();
  const hasAppbar = useHasAppbarSlot();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const canView = can('features.live.view') || can('live.manage');
  const canAll = can('live.commissions.view');
  const visible = TABS.filter(([k]) => (['wages','control','operator'].includes(k) ? true : ['manual','notifications'].includes(k)?can('live.manage'): k === 'settlements' ? canAll || can('live.manage') : canView));
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
    <div className={`live-page ${current === 'overview' ? '' : 'live-management'}`}>
      <AppbarHint><span className="live-header-summary" title="房间排场、业绩审核、工资及售后结算；主播、中控日常操作请到「我的直播」。">排场 · 审核 · 工资结算<span className="live-header-guide">；主播、中控请到「我的直播」</span></span></AppbarHint>
      {!hasAppbar && current === 'overview' && <h1 className="live-header-fallback">直播管理</h1>}
      {canAll || can('live.manage') ? <SourceStatusNotice /> : null}
      <div className="tab-group host-tabs" role="tablist" aria-label="直播管理分区">
        {visible.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={k === current} className={k === current ? 'chip active' : 'chip'} onClick={() => pick(k)}>{label}</button>)}
      </div>
      {current !== 'overview' && <label className="live-mobile-nav"><span>切换页面</span><select aria-label="直播管理页面" value={current} onChange={event=>pick(event.target.value as TabKey)}>{visible.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>}
      {current !== 'overview' && <header className="live-workspace-heading"><div><p>直播管理</p><h1>{visible.find(([key]) => key === current)?.[1]}</h1><span>{SECTION_HELP[current]}</span></div><span className="live-workspace-mark">{['wages','control','operator','settlements'].includes(current) ? '核算与结算' : ['manual','sessions','review'].includes(current) ? '业绩与审核' : '直播工作区'}</span></header>}
      {current === 'overview' && <OverviewTab onOpenSession={setOpenId} />}
      {current !== 'overview' && <div className="live-workspace" role="tabpanel" aria-label={visible.find(([key]) => key === current)?.[1]}>
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
      </div>}
      {openId !== null && <SessionDetailDialog id={openId} onClose={() => setOpenId(null)} onChanged={() => setTick((t) => t + 1)} />}
    </div>
  );
}
