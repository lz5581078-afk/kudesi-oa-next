import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { todayInChina, type DailyBusiness } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { money } from '../finance/common';
import { workspaceApi } from './workspaceApi';

const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ppm = (v: number | null) => (v === null ? '—' : `${(v / 1_000_000).toFixed(2)}%`);

/** 运营工作台“每日经营”：选一天看各店铺营业额、推广费、利润、利润率，并提醒这天还没有数据的店铺。 */
export function DailyBusinessPanel() {
  const yesterday = shift(todayInChina(), -1);
  const [date, setDate] = useState(yesterday);
  const [d, setD] = useState<DailyBusiness | null>(null);
  const [error, setError] = useState('');
  const [showMissing, setShowMissing] = useState(false);
  useEffect(() => {
    setD(null);
    workspaceApi.daily(date).then((x) => { setD(x); setError(''); }).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, [date]);
  const cell = (label: string, value: string) => <div className="ws-card normal"><span>{label}</span><strong>{value}</strong></div>;
  return (
    <section className="card ws-section" aria-label="每日经营">
      <div className="ws-head">
        <h2>每日经营</h2>
        <div className="toolbar-inline">
          <button type="button" className="secondary-button small" aria-label="前一天" onClick={() => setDate(shift(date, -1))}>‹</button>
          <input type="date" aria-label="经营日期" value={date} max={todayInChina()} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button type="button" className="secondary-button small" aria-label="后一天" disabled={date >= todayInChina()} onClick={() => setDate(shift(date, 1))}>›</button>
          {d && d.missing.length > 0 && <button type="button" className="chip" onClick={() => setShowMissing((v) => !v)}>{d.missing.length} 家店铺当天没有数据</button>}
        </div>
      </div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {!d && !error && <p className="muted ws-pad" role="status">正在读取…</p>}
      {d && (
        <>
          {showMissing && <p className="ws-pad" role="status">没有 {d.date} 数据的店铺：{d.missing.map((m) => m.name).join('、')}。去 <Link to="/resource/stores">店铺档案</Link> 的经营数据里录入或导入。</p>}
          <div className="ws-cards" style={{ padding: '0 16px 8px' }}>
            {cell('营业额', money(d.totals.salesCents))}
            {cell('推广费', money(d.totals.adCostCents))}
            {cell('利润', d.totals.profitCents === null ? '—' : money(d.totals.profitCents))}
            {cell('利润率', ppm(d.totals.marginPpm))}
          </div>
          {d.stores.length === 0
            ? <div className="ws-empty muted"><strong>{d.date} 还没有店铺经营数据</strong><span>数据录入或导入后会显示在这里。</span></div>
            : <div className="table-scroll"><table className="data-table stack-mobile"><thead><tr><th>店铺</th><th className="num">营业额</th><th className="num">推广费</th><th className="num">利润</th><th className="num">利润率</th></tr></thead>
              <tbody>{d.stores.map((s) => <tr key={s.storeId}><td className="cell-title">{s.name}{s.platform && <small className="muted"> · {s.platform}</small>}</td><td data-label="营业额" className="num">{money(s.salesCents)}</td><td data-label="推广费" className="num">{money(s.adCostCents)}</td><td data-label="利润" className="num">{s.profitCents === null ? '—' : money(s.profitCents)}</td><td data-label="利润率" className="num">{ppm(s.marginPpm)}</td></tr>)}</tbody></table></div>}
        </>
      )}
    </section>
  );
}
