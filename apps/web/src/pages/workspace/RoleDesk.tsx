import { useCallback, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { NavPage, SummaryCard } from '@kudesi/shared';
import { FlowSection } from './FlowSection';
import { PersonalTaskPanel } from './PersonalTaskPanel';
import { SummaryCards } from './SummaryCards';

export interface DeskView {
  title: string;
  subtitle: string;
  links: NavPage[];
  linksHint?: string;
  cards: SummaryCard[];
  pending: string[];
  blank?: boolean;
  /** 放在概览卡片和常用业务之间的专属区块（如运营的每日经营） */
  top?: ReactNode;
}

/** 工作台主体：今日概览 → 常用业务 → 流程与待办 → 个人任务。岗位工作台和个人工作台共用。 */
export function RoleDesk({ view }: { view: DeskView }) {
  const [tick, setTick] = useState(0);
  const [counts, setCounts] = useState<{ todo: number | null; overdue: number | null; mine: number | null }>({ todo: null, overdue: null, mine: null });
  const onCounts = useCallback((c: { todo: number | null; overdue: number | null; mine: number | null }) => setCounts((cur) => ({ todo: c.todo ?? cur.todo, overdue: c.overdue ?? cur.overdue, mine: c.mine ?? cur.mine })), []);
  const base: SummaryCard[] = [
    { key: 'todo', label: '待我处理', value: counts.todo, tone: (counts.todo ?? 0) > 0 ? 'warn' : 'normal', page: 'workbench.todos' },
    { key: 'overdue', label: '已超时', value: counts.overdue, tone: (counts.overdue ?? 0) > 0 ? 'bad' : 'normal', page: 'workbench.todos' },
    { key: 'mine', label: '我的申请', value: counts.mine, hint: counts.mine === null ? '切到“我的申请”后显示' : undefined, page: 'workbench.started' },
  ];
  return (
    <div className="ws-page">
      <div className="page-head between">
        <div><h1>{view.title}</h1><p className="muted">{view.subtitle}</p></div>
        <button type="button" className="secondary-button" onClick={() => setTick((t) => t + 1)}>刷新工作台</button>
      </div>
      <SummaryCards label="今日待办概览" cards={[...base, ...view.cards]} />
      {view.top}
      {view.blank && <section className="card ws-section"><div className="ws-head"><h2>专属业务</h2></div><p className="muted ws-pad">这个岗位还没有配置专属业务；常用的流程与任务在下面。</p></section>}
      {(view.links.length > 0 || view.pending.length > 0) && (
        <section className="card ws-section" aria-label="岗位常用业务">
          <div className="ws-head"><h2>常用业务</h2>{view.linksHint && <span className="muted">{view.linksHint}</span>}</div>
          <div className="ws-links">
            {view.links.map((l) => <Link key={l.path} to={l.path} className="ws-link"><span>{l.label}</span><small>{l.group ?? ''}</small></Link>)}
            {view.links.length === 0 && <span className="muted">暂无已授权的业务入口</span>}
          </div>
          {view.pending.length > 0 && <p className="muted ws-pad">待接入业务：{view.pending.join('、')}（新系统暂未提供）</p>}
        </section>
      )}
      <div className="ws-layout">
        <FlowSection refreshKey={tick} onCounts={onCounts} />
        <PersonalTaskPanel refreshKey={tick} />
      </div>
      <p className="muted ws-foot">发起新申请请到 <Link to="/flow/apply">申请中心</Link>；新建、指派任务请到 <Link to="/workbench/tasks">任务中心</Link>。</p>
    </div>
  );
}
