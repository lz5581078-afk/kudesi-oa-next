import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { findPageByPath, type HomeDto } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { money } from '../finance/common';
import { fmtTime } from '../flow/flowApi';

/** 只有当前人真的能打开的页面才渲染成链接，否则只显示文字（链接目标一律来自导航注册表）。 */
export function PageLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const { can } = useAuth();
  const found = findPageByPath(to.split('?')[0]);
  if (!found || !found.page.ready || !(found.page.open || can(found.page.permission))) return <span className={className}>{children}</span>;
  return <Link to={to} className={className}>{children}</Link>;
}

function Card({ id, title, more, children }: { id: string; title: string; more?: ReactNode; children: ReactNode }) {
  return (
    <section className="card home-card" aria-label={title} data-widget={id}>
      <div className="home-card-head"><h2>{title}</h2>{more}</div>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="muted home-empty">{children}</p>;
const Count = ({ label, value, tone, to }: { label: string; value: number; tone?: 'warn' | 'bad'; to: string }) => (
  <PageLink to={to} className="home-count">
    <strong className={value > 0 && tone ? `home-count-${tone}` : undefined}>{value}</strong>
    <span className="muted">{label}</span>
  </PageLink>
);
const Due = ({ at, overdue }: { at: string | null; overdue: boolean }) => (at ? <span className={overdue ? 'pill bad' : 'muted'}>{fmtTime(at)}{overdue && ' 已逾期'}</span> : <span className="muted">不限时</span>);

type Data = HomeDto;

export function TodosCard({ data }: { data: NonNullable<Data['todos']> }) {
  return (
    <Card id="todos" title="我的待办" more={<PageLink to="/workbench/todos">全部待办</PageLink>}>
      <div className="home-counts">
        <Count label="待办理" value={data.pending} to="/workbench/todos" />
        <Count label="已逾期" value={data.overdue} tone="bad" to="/workbench/todos" />
        <Count label="被退回" value={data.returned} tone="warn" to="/workbench/todos" />
        <Count label="抄送我的" value={data.cc} to="/workbench/cc" />
      </div>
      {data.rows.length === 0 ? <Empty>没有待办，歇一会儿</Empty> : (
        <ul className="home-list">
          {data.rows.map((r) => (
            <li key={r.id}>
              <span>
                {r.returned && <span className="pill warn">被退回</span>}{' '}
                <PageLink to={r.runId ? `/workbench/todos?run=${r.runId}` : '/workbench/todos'}>{r.title}</PageLink>
                <small className="muted"> {r.templateLabel}{r.stepName ? ` · ${r.stepName}` : ''}</small>
              </span>
              <Due at={r.dueAt} overdue={r.overdue} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function StartedCard({ data }: { data: NonNullable<Data['started']> }) {
  return (
    <Card id="started" title="我发起的" more={<PageLink to="/workbench/started">全部</PageLink>}>
      <p className="home-figure"><strong>{data.running}</strong> <span className="muted">条办理中</span></p>
      {data.rows.length === 0 ? <Empty>没有办理中的申请</Empty> : (
        <ul className="home-list">
          {data.rows.map((r) => (
            <li key={r.id}>
              <span><PageLink to={`/workbench/started?run=${r.id}`}>{r.title}</PageLink><small className="muted"> {r.templateLabel} · {r.stepName ?? '—'}{r.handlers.length ? `（${r.handlers.join('、')}）` : ''}</small></span>
              <Due at={r.dueAt} overdue={r.overdue} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function TasksCard({ data }: { data: NonNullable<Data['tasks']> }) {
  return (
    <Card id="tasks" title="我指派的任务" more={<PageLink to="/workbench/tasks">任务中心</PageLink>}>
      <div className="home-counts">
        <Count label="未完成" value={data.open} to="/workbench/tasks" />
        <Count label="已逾期" value={data.overdue} tone="bad" to="/workbench/tasks" />
      </div>
      {data.open === 0 && <Empty>没有未完成的指派任务</Empty>}
    </Card>
  );
}

export function ApplyCard({ data }: { data: NonNullable<Data['apply']> }) {
  return (
    <Card id="apply" title="发起申请" more={<PageLink to="/flow/apply">申请中心</PageLink>}>
      {data.templates.length === 0 ? <Empty>暂无可发起的流程</Empty> : (
        <ul className="home-list">
          {data.templates.map((t) => (
            <li key={t.key}><span><PageLink to="/flow/apply">{t.label}</PageLink><small className="muted"> {t.description}</small></span></li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function FlowAlertsCard({ data }: { data: NonNullable<Data['flowAlerts']> }) {
  return (
    <Card id="flowAlerts" title="逾期未办结的流程" more={<PageLink to="/flow/overview">流程总览</PageLink>}>
      <p className="home-figure"><strong className={data.overdue > 0 ? 'home-count-bad' : undefined}>{data.overdue}</strong> <span className="muted">条已超过时限</span></p>
      {data.rows.length === 0 ? <Empty>没有逾期的流程</Empty> : (
        <ul className="home-list">
          {data.rows.map((r) => (
            <li key={r.id}>
              <span><PageLink to={`/flow/overview?run=${r.id}`}>{r.title}</PageLink><small className="muted"> {r.requesterName} · {r.stepName ?? '—'}{r.handlers.length ? `（${r.handlers.join('、')}）` : ''}</small></span>
              <Due at={r.dueAt} overdue={r.overdue} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function PeopleCard({ data }: { data: NonNullable<Data['people']> }) {
  return (
    <Card id="people" title="人员逾期排行" more={<PageLink to="/flow/overview">流程总览</PageLink>}>
      {data.rows.length === 0 ? <Empty>没有人有逾期的待办</Empty> : (
        <table className="data-table home-table">
          <thead><tr><th>人员</th><th className="num">待办</th><th className="num">逾期</th></tr></thead>
          <tbody>{data.rows.map((p) => <tr key={p.userId}><td>{p.name}</td><td className="num">{p.pending}</td><td className="num"><span className="pill bad">{p.overdue}</span></td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

export function FinanceCard({ data }: { data: NonNullable<Data['finance']> }) {
  const max = Math.max(1, ...data.trend.map((t) => t.revenueCents));
  return (
    <Card id="finance" title={`本月经营（${data.month}）`} more={<PageLink to="/finance/overview">财务经营</PageLink>}>
      <div className="home-kpis">
        <div><span className="muted">收入</span><strong>{money(data.revenueCents)}</strong></div>
        <div><span className="muted">费用</span><strong>{money(data.expenseCents)}</strong></div>
        {data.netProfitCents !== null && <div><span className="muted">净利润</span><strong>{money(data.netProfitCents)}</strong></div>}
        {data.bankCents !== null && <div><span className="muted">银行余额</span><PageLink to="/finance/cash-bank"><strong>{money(data.bankCents)}</strong></PageLink></div>}
        <div><span className="muted">应收</span><strong>{money(data.receivableCents)}</strong></div>
        <div><span className="muted">应付</span><strong>{money(data.payableCents)}</strong></div>
        <div><span className="muted">草稿 / 已开立</span><PageLink to="/finance/drafts"><strong>{data.drafts} / {data.issued}</strong></PageLink></div>
      </div>
      {data.trend.length === 0 ? <Empty>本月还没有收入或费用记录</Empty> : (
        <div className="home-trend" role="img" aria-label={`近 ${data.trend.length} 个记录日的收入趋势`}>
          {data.trend.map((t) => <span key={t.date} title={`${t.date} 收入 ${money(t.revenueCents)}`} style={{ height: `${Math.max(4, Math.round((t.revenueCents / max) * 100))}%` }} />)}
        </div>
      )}
    </Card>
  );
}

export function StoresCard({ data }: { data: NonNullable<Data['stores']> }) {
  const showProfit = data.rows.some((r) => r.profitCents !== null);
  return (
    <Card id="stores" title="店铺销售排行" more={<PageLink to="/finance/overview">财务经营</PageLink>}>
      {data.rows.length === 0 ? <Empty>还没有店铺经营数据</Empty> : (
        <table className="data-table home-table">
          <thead><tr><th>店铺</th><th className="num">销售额</th>{showProfit && <th className="num">利润</th>}</tr></thead>
          <tbody>{data.rows.map((s) => <tr key={s.storeId}><td>{s.platform ? `${s.platform} / ` : ''}{s.name}</td><td className="num">{money(s.salesCents)}</td>{showProfit && <td className="num">{money(s.profitCents)}</td>}</tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

export function StockCard({ data }: { data: NonNullable<Data['stock']> }) {
  return (
    <Card id="stock" title="库存缺货" more={<PageLink to="/finance/inventory">库存查询</PageLink>}>
      <p className="home-figure"><strong className={data.outCount > 0 ? 'home-count-bad' : undefined}>{data.outCount}</strong> <span className="muted">个商品已无库存</span></p>
      {data.rows.length === 0 ? <Empty>没有缺货商品</Empty> : (
        <ul className="home-list">
          {data.rows.map((r, i) => <li key={`${r.code}-${r.warehouseName}-${i}`}><span>{r.productName}<small className="muted"> {r.code} · {r.warehouseName}</small></span><span className="pill bad">{r.qty}{r.unit}</span></li>)}
        </ul>
      )}
    </Card>
  );
}

export function ResourceAlertsCard({ data }: { data: NonNullable<Data['resourceAlerts']> }) {
  return (
    <Card id="resourceAlerts" title="资料预警" more={<PageLink to="/resource/overview">资料总览</PageLink>}>
      {data.abnormal.length > 0 && (
        <div className="pill-row home-abnormal">
          {data.abnormal.map((a) => <PageLink key={a.type} to={`/resource/${a.type}`}><span className="pill warn">{a.label}异常 {a.abnormal}</span></PageLink>)}
        </div>
      )}
      {data.alerts.length === 0 ? <Empty>{data.abnormal.length ? '没有即将到期的事项' : '没有异常，也没有即将到期的事项'}</Empty> : (
        <ul className="home-list">
          {data.alerts.map((a) => (
            <li key={`${a.type}-${a.id}-${a.label}`}>
              <span><PageLink to={`/resource/${a.type}`}>{a.title}</PageLink><small className="muted"> {a.typeLabel} · {a.label}</small></span>
              {a.days < 0 ? <span className="pill bad">已过 {-a.days} 天</span> : <span className="pill warn">{a.days} 天</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
