import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { resourceApi, type RevenueResult, type RevenueTotals } from './api';
import { formatYuan } from '@kudesi/shared';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function presets() {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return {
    today: [iso(now), iso(now)],
    week: [iso(monday), iso(now)],
    month: [iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)],
  } as Record<string, [string, string]>;
}

const COLS: Array<[keyof RevenueTotals, string, boolean]> = [
  ['sales', '销售额', true], ['refund', '退款', true], ['adCost', '推广费', true], ['platformFee', '平台费', true],
  ['purchaseCost', '采购成本', true], ['otherCost', '其他成本', true], ['profit', '利润', true], ['orders', '订单数', false],
];

/** 营业执照营收：汇总它名下各店铺的“店铺经营数据”。数据来源现在是手工录入/导入，以后接入接口后这里不用改。 */
export function RevenuePanel({ licenseId }: { licenseId: number }) {
  const p = presets();
  const [range, setRange] = useState<[string, string]>(p.month);
  const [data, setData] = useState<RevenueResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!range[0] || !range[1] || range[0] > range[1]) return;
    let live = true;
    setError('');
    resourceApi.licenseRevenue(licenseId, range[0], range[1]).then((r) => live && setData(r)).catch((e) => live && setError(e instanceof ApiError ? e.message : '加载失败'));
    return () => { live = false; };
  }, [licenseId, range]);

  return (
    <section>
      <h2 className="section-title">营收</h2>
      <div className="row-actions" role="group" aria-label="时间范围">
        {([['today', '今日'], ['week', '本周'], ['month', '本月']] as const).map(([k, label]) => (
          <button key={k} type="button" className={range[0] === p[k][0] && range[1] === p[k][1] ? 'secondary-button small active' : 'secondary-button small'} onClick={() => setRange(p[k])}>{label}</button>
        ))}
        <input type="date" aria-label="开始日期" value={range[0]} onChange={(e) => setRange([e.target.value, range[1]])} />
        <span className="muted">至</span>
        <input type="date" aria-label="结束日期" value={range[1]} onChange={(e) => setRange([range[0], e.target.value])} />
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {data && (
        <>
          <p className="muted">共 {data.stores.length} 个店铺。数据来自“店铺经营数据”（手工录入或导入），尚未接入平台接口。</p>
          {data.stores.length === 0 && <p className="muted">这个执照下还没有店铺</p>}
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>店铺</th>{COLS.map(([, l]) => <th key={l}>{l}</th>)}</tr>
              </thead>
              <tbody>
                {data.stores.map((s) => (
                  <tr key={s.storeId}><td>{s.name}</td>{COLS.map(([k, , money]) => <td key={k}>{money ? formatYuan(s[k]) : s[k]}</td>)}</tr>
                ))}
                <tr><th>合计</th>{COLS.map(([k, , money]) => <th key={k}>{money ? formatYuan(data.total[k]) : data.total[k]}</th>)}</tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
