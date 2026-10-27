import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { todayInChina } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { DOC_TYPE_MAP } from '@kudesi/shared';
import { money } from './common';
import { DocDetail } from './DocDetail';
import { financeApi, type Overview } from './financeApi';
import { writeStored } from './fin-ui';

const month0 = () => todayInChina().slice(0, 7);
const monthBefore = () => { const [y, m] = month0().split('-').map(Number); const t = new Date(Date.UTC(y, m - 2, 1)); return t.toISOString().slice(0, 7); };
const monthRange = (month: string): [string, string] => { if (month === 'all') return ['', '']; const [y, m] = month.split('-').map(Number); return [`${month}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)]; };
const rate = (num: number | null, den: number) => (num === null || den <= 0 ? '—' : `${((num / den) * 100).toFixed(1)}%`);

/** 财务经营：本月（或全部时间）收入、成本、费用、利润，往来余额，待处理单据。没有成本权限的人看不到成本和利润。 */
export function FinanceOverviewPage() {
  const [month, setMonth] = useState(month0());
  const all = month === 'all';
  const [d, setD] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const navigate = useNavigate();
  useEffect(() => {
    setError('');
    financeApi.overview(month).then(setD).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [month, tick]);
  /** 把当前期间和收支方向写进经营历程的筛选条件，再跳过去 */
  const openJourney = (direction: '' | 'in' | 'out') => {
    const [from, to] = monthRange(month);
    writeStored('oa.finance.history.filters.v1', { datePreset: 'custom', from, to, status: '', docType: '', direction, mine: false, audited: '' });
    navigate('/finance/history');
  };
  const Stat = ({ label, value, tone, hint, onClick }: { label: string; value: string; tone?: string; hint?: string; onClick?: () => void }) => {
    const body = <><div className="muted">{label}</div><div className={`strong ${tone ?? ''}`}>{value}</div>{hint && <small className="muted">{hint}</small>}</>;
    return onClick ? <button type="button" className="stat clickable" aria-label={`${label}，点击查看对应单据`} onClick={onClick}>{body}</button> : <div className="stat">{body}</div>;
  };
  const noData = !!d && d.trend.length === 0 && d.stores.length === 0 && d.ledger.length === 0 && d.revenueCents === 0 && d.expenseCents === 0;
  return (
    <div>
      <div className="page-head between"><h1>财务经营</h1>
        <div className="toolbar">
          <label className="check-line"><input type="checkbox" aria-label="全部时间" checked={all} onChange={(e) => setMonth(e.target.checked ? 'all' : month0())} />全部时间</label>
          <div className="chips" role="group" aria-label="期间快捷选择">
            <button type="button" className={`chip${!all && month === month0() ? ' active' : ''}`} onClick={() => setMonth(month0())}>本月</button>
            <button type="button" className={`chip${!all && month === monthBefore() ? ' active' : ''}`} onClick={() => setMonth(monthBefore())}>上月</button>
          </div>
          <button type="button" className="secondary-button small" onClick={() => setTick((t) => t + 1)}>刷新数据</button>
          {!all && <input type="month" aria-label="月份" value={month} onChange={(e) => setMonth(e.target.value || month0())} />}
        </div></div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {d && (
        <>
          <h2 className="section-title">{all ? '全部时间' : d.month} 经营情况（按已过账单据）</h2>
          {noData && <div className="empty-state muted">这个期间还没有已过账的经营数据。<button type="button" className="link-button" onClick={() => openJourney('')}>去经营历程看单据</button>，或到「资料」里完善店铺和账户档案。</div>}
          <div className="stats">
            <Stat label="销售收入" value={money(d.revenueCents)} hint="点击查看收入单据" onClick={() => openJourney('in')} />
            <Stat label="销售成本" value={money(d.cogsCents)} />
            <Stat label="毛利" value={money(d.grossProfitCents)} hint={`毛利率 ${rate(d.grossProfitCents, d.revenueCents)}`} />
            <Stat label="费用" value={money(d.expenseCents)} hint="点击查看支出单据" onClick={() => openJourney('out')} />
            <Stat label="其他收入" value={money(d.otherIncomeCents)} />
            <Stat label="净利润" value={money(d.netProfitCents)} hint={`利润率 ${rate(d.netProfitCents, d.revenueCents)}`} tone={d.netProfitCents !== null && d.netProfitCents < 0 ? 'neg' : ''} />
          </div>
          <h2 className="section-title">往来与资金（截至现在）</h2>
          <div className="stats">
            <Stat label="银行余额合计" value={money(d.bankCents)} hint="点击进入现金银行查询" onClick={() => navigate('/finance/cash-bank')} />
            <Stat label="应收账款" value={money(d.receivableCents)} />
            <Stat label="应付账款" value={money(d.payableCents)} />
            <Stat label="预收款" value={money(d.advanceReceiptCents)} />
            <Stat label="预付款" value={money(d.prepaymentCents)} />
          </div>
          <h2 className="section-title">利润趋势（{d.trendBy === 'month' ? '按月' : '按日'}）</h2>
          <Trend rows={d.trend} by={d.trendBy ?? 'day'} />
          <h2 className="section-title">店铺利润（来自店铺经营数据）</h2>
          {d.stores.length === 0 ? <p className="muted">{all ? '还没有店铺经营数据。' : '本月还没有店铺经营数据。'}</p> : (
            <div className="table-scroll"><table className="data-table"><thead><tr><th>店铺</th><th>主体</th><th className="num">销售额</th><th className="num">推广费</th><th className="num">利润</th><th className="num">利润率</th></tr></thead>
              <tbody>{d.stores.map((s) => <tr key={s.storeId}><td>{s.name}</td><td>{s.licenseName || <span className="muted">未关联执照</span>}</td><td className="num">{money(s.salesCents)}</td><td className="num">{money(s.adCostCents)}</td><td className={`num ${s.profitCents !== null && s.profitCents < 0 ? 'neg' : ''}`}>{money(s.profitCents)}</td><td className="num">{rate(s.profitCents, s.salesCents)}</td></tr>)}</tbody></table></div>
          )}
          <h2 className="section-title between"><span>财务台账（{all ? '最近' : '本月最近'} 60 笔）</span><button type="button" className="secondary-button small" onClick={() => openJourney('')}>全部单据 · 经营历程</button></h2>
          {d.ledger.length === 0 ? <p className="muted">{all ? '还没有已过账的收支。' : '本月还没有已过账的收支。'}</p> : (
            <div className="table-scroll"><table className="data-table"><thead><tr><th>日期</th><th>方向</th><th>分类</th><th>店铺</th><th>单据</th><th className="num">金额</th><th>来源</th></tr></thead>
              <tbody>{d.ledger.map((l, i) => <tr key={i}><td>{l.date}</td><td>{l.direction === 'in' ? '收入' : '支出'}</td><td>{l.kind === 'revenue' ? '销售收入' : l.kind === 'expense' ? '费用' : '其他收入'}</td><td>{l.storeName || '-'}</td>
                <td><button type="button" className="link-button" onClick={() => setSelected(l.documentId)}>{DOC_TYPE_MAP.get(l.docType as never)?.label ?? l.docType} {l.docNo}</button></td><td className="num">{money(l.amountCents)}</td><td>{l.source ?? '-'}</td></tr>)}</tbody></table></div>
          )}
          <h2 className="section-title">待处理</h2>
          <p><Link to="/finance/drafts">草稿 {d.drafts} 张，已开立未过账 {d.issued} 张</Link></p>
          <p className="muted">利润为系统内已过账数据；聚水潭订单接入后，会在这里并入平台订单算整体利润。</p>
        </>
      )}
      {selected && <DocDetail key={selected} id={selected} onClose={() => setSelected(null)} onChanged={() => undefined} />}
    </div>
  );
}

/** 简单柱图：每天一根，收入蓝、利润绿/红；没有成本权限时只画收入。 */
function Trend({ rows, by }: { rows: Overview['trend']; by: 'day' | 'month' }) {
  if (rows.length === 0) return <p className="muted">{by === 'month' ? '还没有已过账的收支。' : '本月还没有已过账的收支。'}</p>;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.revenueCents, Math.abs(r.profitCents ?? 0))));
  const step = by === 'month' ? 44 : 28;
  const w = Math.max(rows.length * step, 280), h = 140;
  return (
    <svg role="img" aria-label="利润趋势" width={w} height={h + 20} style={{ maxWidth: '100%' }}>
      {rows.map((r, i) => {
        const x = i * step + 4, rh = (r.revenueCents / max) * h, ph = r.profitCents === null ? 0 : (Math.abs(r.profitCents) / max) * h;
        return (
          <g key={r.date}>
            <title>{`${r.date} 收入 ${money(r.revenueCents)} 利润 ${money(r.profitCents)}`}</title>
            <rect x={x} y={h - rh} width={10} height={rh} fill="#3b82f6" />
            {r.profitCents !== null && <rect x={x + 11} y={h - ph} width={10} height={ph} fill={r.profitCents < 0 ? '#dc2626' : '#16a34a'} />}
            <text x={x + 10} y={h + 14} fontSize="10" textAnchor="middle">{by === 'month' ? r.date.slice(2) : r.date.slice(8)}</text>
          </g>
        );
      })}
    </svg>
  );
}
