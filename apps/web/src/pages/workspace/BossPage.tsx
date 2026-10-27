import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BossDashboard } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { money } from '../finance/common';
import { SummaryCards } from './SummaryCards';
import { workspaceApi } from './workspaceApi';

const SEV: Record<string, [string, string]> = { urgent: ['紧急', 'bad'], important: ['重要', 'warn'], normal: ['一般', ''] };
const clock = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

/** 老板总控台：先看要处理的事，再看今日经营、异常、人员兜底排行、店铺利润和趋势。 */
export function BossPage() {
  const [d, setD] = useState<BossDashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    workspaceApi.boss().then((x) => { setD(x); setError(''); }).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  // 页面开着时每分钟自动更新一次（隐藏的标签页不刷新）
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);
  const missing = d ? (Object.entries(d.modules) as Array<[string, boolean]>).filter(([, on]) => !on) : [];
  const noData = d && !d.today.hasData;
  return (
    <div className="ws-page" aria-busy={loading}>
      <div className="page-head between">
        <div><h1>老板总控台</h1><p className="muted">先看要你处理的事，再看今天的经营数字；点任何数字可查看明细。</p></div>
        <div className="toolbar-inline">
          <span className="muted" role="status">{loading ? '正在更新…' : d ? `数据截至 ${clock(d.asOf)}` : ''}</span>
          <button type="button" className="secondary-button" disabled={loading} onClick={load}>刷新</button>
        </div>
      </div>
      {error && <div role="alert" className="notice error toast-line"><span>{error}</span><button type="button" className="link-button" onClick={load}>重试</button></div>}
      {!d && !error && <p className="muted" role="status">正在读取…</p>}
      {d && (
        <>
          <h2 className="section-title">需要你处理</h2>
          <SummaryCards label="需要你处理" cards={d.attention} />
          {missing.length > 0 && <p className="muted ws-pad">部分汇总还没有接入：{missing.map(([k]) => ({ supervision: '兜底监督', 'after-sales': '售后', live: '直播' } as Record<string, string>)[k]).join('、')}（对应模块上线后自动出现数据）。</p>}
          <h2 className="section-title">今日经营</h2>
          <div className="ws-cards two">
            <div className="ws-card normal"><span>今日销售额</span><strong>{money(d.today.salesCents)}</strong><small>{noData ? '今日暂无店铺经营数据（尚未录入/导入，或确实没有销售）' : '含全部店铺'}</small></div>
            <div className="ws-card normal"><span>今日利润</span><strong>{d.today.profitCents === null ? '—' : money(d.today.profitCents)}</strong><small>{d.today.profitCents === null ? '没有查看成本的权限' : noData ? '今日暂无数据' : '销售额扣退款、推广、平台费、采购及其他成本'}</small></div>
          </div>
          <div className="ws-two">
            <section className="card ws-section">
              <div className="ws-head"><h2>全公司异常 · {d.exceptions.total}</h2></div>
              {!d.exceptions.available ? <div className="ws-empty muted"><strong>暂无该模块</strong><span>兜底监督上线后，开放的异常会汇总到这里。</span></div>
                : d.exceptions.rows.length === 0 ? <div className="ws-empty muted"><strong>目前没有未处理的异常</strong><span>有新的异常会自动出现在这里。</span></div>
                : <ul className="ws-task-list">{d.exceptions.rows.slice(0, 8).map((e) => (
                  <li key={e.id}><div className="ws-task"><span className="ws-task-main"><strong>{e.title}</strong><small>{e.ownerName || '未分配'} · {e.storeName || '公司级'}{e.escalatedLevel ? ` · 已升级到 L${e.escalatedLevel}` : ''}</small></span><span className={`pill ${SEV[e.severity]?.[1] ?? ''}`}>{SEV[e.severity]?.[0] ?? '一般'}</span></div></li>
                ))}{d.exceptions.rows.length > 8 && <li className="muted ws-pad">仅显示最紧急的 8 条，共 {d.exceptions.rows.length} 条</li>}</ul>}
            </section>
            <section className="card ws-section">
              <div className="ws-head"><h2>人员兜底排行（超时多的在前）</h2><Link to="/flow/overview">流程总览</Link></div>
              {d.people.length === 0 ? <div className="ws-empty muted"><strong>目前没有人员有待办、超时或异常</strong></div> : (
                <div className="table-scroll"><table className="data-table"><thead><tr><th>人员</th><th className="num">超时</th><th className="num">异常</th><th className="num">待办</th></tr></thead>
                  <tbody>{d.people.slice(0, 10).map((p) => <tr key={p.userId}><td>{p.name}{p.position && <small className="muted"> · {p.position}</small>}</td><td className={`num${p.overdue ? ' neg' : ''}`}>{p.overdue}</td><td className={`num${p.exceptions ? ' neg' : ''}`}>{p.exceptions}</td><td className="num">{p.pending}</td></tr>)}</tbody></table></div>
              )}
            </section>
          </div>
          <div className="ws-two">
            <section className="card ws-section">
              <div className="ws-head"><h2>店铺利润排行 · 近 7 天</h2><Link to="/resource/stores">全部店铺</Link></div>
              {d.stores.length === 0 ? <div className="ws-empty muted"><strong>近 7 天没有店铺经营数据</strong></div> : (
                <>
                  <p className="ws-pad" role="status">近 7 天合计：销售 {money(d.stores.reduce((s, r) => s + r.salesCents, 0))}{d.stores[0].profitCents !== null && <>，利润 {money(d.stores.reduce((s, r) => s + (r.profitCents ?? 0), 0))}</>}</p>
                  <div className="table-scroll"><table className="data-table"><thead><tr><th>店铺</th><th className="num">销售额</th>{d.stores[0].profitCents !== null && <th className="num">利润</th>}</tr></thead>
                    <tbody>{d.stores.map((s) => <tr key={s.storeId}><td>{s.name}{s.platform && <small className="muted"> · {s.platform}</small>}</td><td className="num">{money(s.salesCents)}</td>{s.profitCents !== null && <td className={`num${s.profitCents < 0 ? ' neg' : ''}`}>{money(s.profitCents)}</td>}</tr>)}</tbody></table></div>
                </>
              )}
            </section>
            <section className="card ws-section">
              <div className="ws-head"><h2>经营趋势 · 近 14 天</h2><Link to="/finance/overview">财务明细</Link></div>
              <Trend rows={d.trend} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Trend({ rows }: { rows: BossDashboard['trend'] }) {
  if (rows.length === 0) return <div className="ws-empty muted"><strong>近 14 天没有店铺经营数据</strong></div>;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.salesCents, Math.abs(r.profitCents ?? 0))));
  const step = 28, h = 130, w = Math.max(rows.length * step, 260);
  return (
    <svg role="img" aria-label="经营趋势" width={w} height={h + 20} style={{ maxWidth: '100%' }}>
      {rows.map((r, i) => {
        const x = i * step + 4, sh = (r.salesCents / max) * h, ph = r.profitCents === null ? 0 : (Math.abs(r.profitCents) / max) * h;
        return (
          <g key={r.date}>
            <title>{`${r.date} 销售 ${money(r.salesCents)}${r.profitCents === null ? '' : ` 利润 ${money(r.profitCents)}`}`}</title>
            <rect x={x} y={h - sh} width={10} height={sh} fill="#3b82f6" />
            {r.profitCents !== null && <rect x={x + 11} y={h - ph} width={10} height={ph} fill={r.profitCents < 0 ? '#dc2626' : '#16a34a'} />}
            <text x={x + 10} y={h + 14} fontSize="10" textAnchor="middle">{r.date.slice(8)}</text>
          </g>
        );
      })}
    </svg>
  );
}
