import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Landmark, Store, WalletCards } from 'lucide-react';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { money } from './common';
import { financeApi, type Overview } from './financeApi';
import { QueryPage, QueryPanel, QueryTable, type Col } from './query/QueryKit';
import './financeOverview.css';

/** 经营中心按店铺日报展示利润，单据台账保持独立；不把两种口径互换。 */
export function FinanceOverviewPage() {
  const { user } = useAuth();
  return <OverviewContent key={JSON.stringify([user?.companyId, user?.id, user?.permissions])}/>;
}
function OverviewContent() {
  const [data, setData] = useState<Overview | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true; setData(null); setError('');
    financeApi.overview('all').then(result => { if (alive) setData(result); }).catch(error => { if (alive) setError(error instanceof ApiError ? error.message : '财务经营数据加载失败'); });
    return () => { alive = false; };
  }, [retry]);
  const stores = useMemo(() => data ? [...data.stores].sort((a,b) => a.profitCents === null || b.profitCents === null ? a.name.localeCompare(b.name, 'zh-CN') : b.profitCents - a.profitCents) : null, [data]);
  const storeCols = useMemo<Array<Col<Overview['stores'][number]>>>(() => [
    { key:'store', head:'店铺', cell:row => `${row.platformLabel || row.platform || ''} / ${row.name}`, csv:row => `${row.platformLabel || row.platform || ''} / ${row.name}` },
    { key:'license', head:'主体', cell:row => row.licenseName || '', csv:row => row.licenseName || '' },
    { key:'sales', head:'销售额', cell:row => reportMoney(row.salesCents), csv:row => row.salesCents / 100 },
    { key:'profit', head:'利润', cell:row => reportMoney(row.profitCents), csv:row => row.profitCents === null ? '' : row.profitCents / 100 },
  ], []);
  const ledgerCols = useMemo<Array<Col<Overview['ledger'][number]>>>(() => [
    { key:'date', head:'日期', cell:row => row.date, csv:row => row.date },
    { key:'direction', head:'方向', cell:row => row.direction === 'in' ? '收入' : '支出', csv:row => row.direction === 'in' ? '收入' : '支出' },
    { key:'kind', head:'分类', cell:row => kindLabel(row.kind), csv:row => kindLabel(row.kind) },
    { key:'store', head:'店铺', cell:row => row.storeName || '-', csv:row => row.storeName || '' },
    { key:'amount', head:'金额', cell:row => reportMoney(row.amountCents), csv:row => row.amountCents / 100 },
    { key:'source', head:'来源', cell:row => row.source || '', csv:row => row.source || '' },
  ], []);
  const ledger = useMemo(() => data?.ledger.slice(0,20).map((row,index) => ({ ...row, tableKey:index })) ?? null, [data]);
  return <QueryPage className="finance-overview-reference" title="财务经营中心" subtitle="经营财务先落地：收入、费用、提现、余额、店铺利润和来源流程追溯。">
    {error && <div role="alert" className="notice error">{error}<button type="button" className="link-button" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
    {!error && <><div className="finance-overview-two-col">
      <QueryPanel title="利润趋势" icon={<Landmark size={18}/>}>
        {!data ? <p className="muted" role="status">正在读取店铺经营数据…</p> : <StoreProfitChart rows={data.storeTrend || []}/>}
      </QueryPanel>
      <QueryPanel title="店铺利润" icon={<Store size={18}/>}>
        <QueryTable cols={storeCols} rows={stores} rowKey={row => row.storeId} empty="暂无数据" caption="店铺利润" foot={false} controls={{ storageKey:'oa.finance.overview.store-columns.v1' }}/>
      </QueryPanel>
    </div>
    <QueryPanel title="财务台账" icon={<WalletCards size={18}/>}>
      <QueryTable cols={ledgerCols} rows={ledger} rowKey={row => row.tableKey} empty="暂无数据" caption="财务台账" foot={false} controls={{ storageKey:'oa.finance.overview.ledger-columns.v1' }}/>
    </QueryPanel></>}
  </QueryPage>;
}
const reportMoney = (value: number | null) => typeof value === 'number' && value < 0 ? `-${money(-value)}` : money(value);
const kindLabel = (kind: string) => ({ revenue:'销售收入', expense:'费用', finance_cost:'财务费用', other_income:'其他收入' }[kind] || kind);
function StoreProfitChart({ rows }: { rows: NonNullable<Overview['storeTrend']> }) {
  const data = rows.map(row => ({ date:row.date, profit:row.profitCents === null ? null : row.profitCents / 100, cost:row.costCents === null ? null : row.costCents / 100 }));
  return <div className="finance-store-profit-chart" role="img" aria-label="店铺利润和成本趋势"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data}><CartesianGrid strokeDasharray="3 3" stroke="#d8dee9"/><XAxis dataKey="date" tickFormatter={value => String(value).slice(5,10)}/><YAxis/><Tooltip formatter={value => reportMoney(Number(value) * 100)}/><Area type="monotone" dataKey="profit" stroke="#0e8062" fill="#b9ddca" name="利润"/><Area type="monotone" dataKey="cost" stroke="#f59e0b" fill="#fde68a" name="成本"/></AreaChart></ResponsiveContainer></div>;
}
