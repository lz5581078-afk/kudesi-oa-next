import { useEffect, useState } from 'react';
import { createChecker, formatYuan, getResourceDef, permissionOwner, resourcePermission } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { resourceApi, type ResourceDto } from './api';
import { displayValue } from './format';

type Snapshot = Record<string, ResourceDto[]>;

const num = (d: ResourceDto, k: string) => (typeof d.data[k] === 'number' ? (d.data[k] as number) : undefined);
const show = (v: unknown, fmt: (x: number) => string = String) => (typeof v === 'number' ? fmt(v) : '—');

function Grid({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <span key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></span>
      ))}
    </dl>
  );
}

/** 店铺详情里的“经营数据”：只读，展示各类数据的最新一次快照（旧系统 StoreMetricsSection）。 */
export function StoreMetricsPanel({ store }: { store: ResourceDto }) {
  const { user } = useAuth();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [dim, setDim] = useState('');
  useEffect(() => {
    const check = user ? createChecker(user.permissions) : () => false;
    const types = ['store-daily-metrics', 'store-scores', 'store-promotions', 'store-funds'].filter((t) => check(resourcePermission(permissionOwner(t), 'view')));
    Promise.all(types.map((t) => resourceApi.list(t, { pageSize: 200, showHidden: true, fieldKey: 'storeId', fieldValue: store.id }).then((r) => [t, r.items] as const)))
      .then((pairs) => setSnap(Object.fromEntries(pairs)))
      .catch(() => setSnap({}));
  }, [store.id, user]);
  if (!snap) return <p className="muted">加载中…</p>;

  const latest = (t: string, dateKey: string) => {
    const rows = snap[t] ?? [];
    const d = rows.map((r) => String(r.data[dateKey] ?? '')).sort().pop();
    return { date: d, rows: d ? rows.filter((r) => r.data[dateKey] === d) : [] };
  };
  const metric = latest('store-daily-metrics', 'day').rows[0];
  const scores = latest('store-scores', 'snapshotDate');
  const promos = latest('store-promotions', 'day');
  const fund = latest('store-funds', 'snapshotDate').rows[0];
  const scoreDef = getResourceDef('store-scores')!;
  const dimField = scoreDef.fields.find((f) => f.key === 'dimension')!;
  const dims = dimField.options!.filter((o) => scores.rows.some((r) => r.data.dimension === o.value));
  const activeDim = dim && dims.some((d) => d.value === dim) ? dim : dims[0]?.value;
  const none = !metric && !scores.rows.length && !promos.rows.length && !fund;
  const spend = promos.rows.reduce((a, r) => a + (num(r, 'spend') ?? 0), 0);
  const gmv = promos.rows.reduce((a, r) => a + (num(r, 'gmv') ?? 0), 0);

  return (
    <div>
      {none && <p className="muted">经营数据还没有录入。可以在“店铺经营数据”里手工录入或导入，这里只读展示每类数据的最新一次。</p>}
      {metric && (
        <section>
          <h2 className="section-title">经营信息 <small className="muted">{String(metric.data.day)}</small></h2>
          <Grid items={[
            ['销售额', show(metric.data.sales, formatYuan)], ['订单数', show(metric.data.orders)], ['推广费', show(metric.data.adCost, formatYuan)],
            ['访客数', show(metric.data.visitors)], ['商品浏览量', show(metric.data.productViews)], ['商品评价数', show(metric.data.productReviews)],
            ['利润', show(metric.data.profit, formatYuan)],
          ]} />
        </section>
      )}
      {scores.rows.length > 0 && (
        <section>
          <h2 className="section-title">店铺评分 <small className="muted">{scores.date}</small></h2>
          <div className="tab-group" role="tablist" aria-label="评分类别">
            {dims.map((d) => <button key={d.value} type="button" role="tab" aria-selected={activeDim === d.value} className={activeDim === d.value ? 'chip active' : 'chip'} onClick={() => setDim(d.value)}>{d.label}</button>)}
          </div>
          <table className="data-table">
            <thead><tr><th>指标</th><th>数值/等级</th><th>行业均值/目标</th></tr></thead>
            <tbody>{scores.rows.filter((r) => r.data.dimension === activeDim).map((r) => <tr key={r.id}><td>{String(r.data.metric ?? '')}</td><td>{String(r.data.value ?? '—')}</td><td>{String(r.data.benchmark ?? '—')}</td></tr>)}</tbody>
          </table>
        </section>
      )}
      {promos.rows.length > 0 && (
        <section>
          <h2 className="section-title">推广中心 <small className="muted">{promos.date}</small></h2>
          <Grid items={[['推广总花费', formatYuan(spend)], ['推广成交金额', formatYuan(gmv)], ['投产比', spend > 0 ? `${Math.round((gmv / spend) * 100)}%` : '—']]} />
          <table className="data-table">
            <thead><tr><th>推广计划</th><th>花费</th><th>成交额</th><th>订单</th><th>点击/展现</th><th>转化率</th></tr></thead>
            <tbody>{promos.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.data.itemUrl ? <a href={String(r.data.itemUrl)} target="_blank" rel="noreferrer">{String(r.data.campaign)}</a> : String(r.data.campaign)}</td>
                <td>{show(r.data.spend, formatYuan)}</td><td>{show(r.data.gmv, formatYuan)}</td><td>{show(r.data.orders)}</td>
                <td>{show(r.data.clicks)} / {show(r.data.impressions)}</td><td>{r.data.conversionRate !== undefined ? `${String(r.data.conversionRate)}%` : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
      <section>
        <h2 className="section-title">店铺资金 {fund && <small className="muted">快照 {String(fund.data.snapshotDate)}</small>}</h2>
        <Grid items={[
          ['保证金', show(fund?.data.deposit, formatYuan)],
          ['冻结资金', show(fund?.data.frozen, formatYuan)],
          ['货款（可提现）', show(fund?.data.withdrawable, formatYuan)],
          ['推广费余额', show(fund?.data.promotion, formatYuan)],
        ]} />
      </section>
    </div>
  );
}
