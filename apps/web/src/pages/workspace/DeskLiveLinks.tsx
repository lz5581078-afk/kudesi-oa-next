import { ArrowUpRight, Radio } from 'lucide-react';
import { Link } from 'react-router-dom';
import { navPageByKey, type DeskPosition } from '@kudesi/shared';

export function DeskLiveLinks({ position, can, isAdmin }: {
  position: DeskPosition;
  can: (key: string) => boolean;
  isAdmin: boolean;
}) {
  const page = navPageByKey('features.live');
  if (!page || !can(page.permission)) return null;
  const type = position.workspaceType;
  const profile = position.referenceProfile;
  const canManage = can('live.manage');
  const hr = profile === 'hr_admin' || profile === 'hr_manager';
  const content = ['design', 'content', 'content_manager'].includes(profile ?? '');
  const operating = type === 'operations' && !content;
  const leader = position.level !== 'staff' || isAdmin;
  const links: Array<[string, string]> = [];

  if (hr || (operating && leader) || (type === 'boss' && profile !== 'assistant')) {
    links.push(['overview', '直播全览'], ['schedules', '排场']);
  }
  if (hr) {
    links.push(['daily', '日常工作排班'], ['review', '待审核']);
    if (canManage) links.push(['manual', '人事补报'], ['qr', '上下播二维码']);
  }
  if ((type === 'finance' || type === 'cashier' || type === 'boss' || hr) && (canManage || can('live.commissions.view'))) {
    if (type !== 'cashier') links.push(['wages', '主播工资'], ['control', '中控工资'], ['operator', '运营提成']);
    links.push(['daily-wages', '日常工作工资'], ['settlements', '工资结算']);
  }
  if (content || operating || type === 'live_anchor' || type === 'live_control') links.push(['scripts', '话术中心']);
  if (!links.length) return null;

  return <section className="card ws-section" aria-label="直播业务">
    <div className="ws-head"><h2><Radio size={17} /> 直播业务</h2></div>
    <div className="desk-action-list">
      {links.map(([tab, label]) => <Link key={tab} to={`${page.path}?tab=${tab}`}>{label}<ArrowUpRight size={15} /></Link>)}
    </div>
  </section>;
}
