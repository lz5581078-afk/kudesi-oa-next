import { useCallback, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, BriefcaseBusiness, RefreshCw } from 'lucide-react';
import type { NavPage, SummaryCard } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { DeskApplications } from './DeskApplications';
import { FlowSection } from './FlowSection';
import { PersonalTaskPanel } from './PersonalTaskPanel';
import { SummaryCards } from './SummaryCards';
import './roleDesk.css';

export interface DeskView {
  title: string;
  subtitle: string;
  links: NavPage[];
  linksHint?: string;
  skuApplication?: boolean;
  cards: SummaryCard[];
  pending: string[];
  blank?: boolean;
  top?: ReactNode | ((refreshKey: number) => ReactNode);
  side?: ReactNode | ((refreshKey: number) => ReactNode);
}

export function RoleDesk({ view }: { view: DeskView }) {
  const { user, can } = useAuth();
  const [tick, setTick] = useState(0);
  const refresh = () => setTick(t => t + 1);
  const [counts, setCounts] = useState<{ todo: number | null; overdue: number | null; mine: number | null }>({ todo: null, overdue: null, mine: null });
  const onCounts = useCallback((c: typeof counts) => setCounts(cur => ({ todo: c.todo ?? cur.todo, overdue: c.overdue ?? cur.overdue, mine: c.mine ?? cur.mine })), []);
  const base: SummaryCard[] = [
    { key: 'todo', label: '待我处理', value: counts.todo, tone: (counts.todo ?? 0) > 0 ? 'warn' : 'normal', page: 'workbench.todos' },
    { key: 'overdue', label: '已超时', value: counts.overdue, tone: (counts.overdue ?? 0) > 0 ? 'bad' : 'normal', page: 'workbench.todos' },
    { key: 'mine', label: '我的申请', value: counts.mine, page: 'workbench.started' },
  ];

  return (
    <div className="ws-page desk-reference">
      <header className="desk-heading">
        <span className="desk-role-icon"><BriefcaseBusiness size={24} /></span>
        <div><h1>{view.title}</h1><p className="muted">{view.subtitle}</p></div>
        <button type="button" className="secondary-button" onClick={refresh}><RefreshCw size={16} /> 刷新工作台</button>
      </header>
      {typeof view.top === 'function' ? view.top(tick) : view.top}
      {view.blank && <section className="card ws-section"><div className="ws-head"><h2>专属业务</h2></div><p className="muted ws-pad">暂无配置</p></section>}
      {view.links.length > 0 && <section className="card ws-section desk-business" aria-label="岗位常用业务">
        <div className="ws-head"><h2>常用业务</h2>{view.linksHint && <span className="muted">{view.linksHint}</span>}</div>
        <div className="desk-action-list">
          {view.links.map(link => <Link key={link.path} to={link.path}>{link.label}<ArrowUpRight size={15} /></Link>)}
        </div>
      </section>}
      <SummaryCards label="今日待办概览" cards={[...base, ...view.cards]} />
      <div className="desk-columns">
        <FlowSection isCompanyAdmin={user?.permissions?.isCompanyAdmin} refreshKey={tick} onCounts={onCounts} />
        <aside className="desk-side">
          <PersonalTaskPanel refreshKey={tick} />
          {can('flow.apply.view') && <DeskApplications sku={!!view.skuApplication} purchase={can('flow.purchase.view')} exclusive={can('flow.exclusive.view')} refreshKey={tick} onSubmitted={refresh} />}
          {typeof view.side === 'function' ? view.side(tick) : view.side}
          {view.pending.length > 0 && <section className="card ws-section">
            <div className="ws-head"><h2>待接入业务</h2></div>
            <ul className="desk-pending">{view.pending.map(item => <li key={item}><span>{item}</span><span className="pill">未接入</span></li>)}</ul>
          </section>}
        </aside>
      </div>
    </div>
  );
}
