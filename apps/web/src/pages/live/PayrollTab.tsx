import { LIVE_PLATFORMS } from '@kudesi/shared';
import { useCallback, useEffect, useState } from 'react';
import { downloadText, toCsv } from '../../resources/csv';
import { liveApi, type Commissions, type Wages } from './liveApi';
import { productText } from './liveProducts';
import { errText, hm, minutesText, money, ratePct, todayText, yuanText } from './liveFormat';
export function PayrollTab({
  role,
  onOpen,
}: {
  role: 'anchor' | 'control' | 'operator';
  onOpen: (id: number) => void;
}) {
  const [month, setMonth] = useState(todayText().slice(0, 7)),
    [mode, setMode] = useState('month'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [personId, setPersonId] = useState('');
  const [data, setData] = useState<{ comm: Commissions; wages: Wages } | null>(null),
    [error, setError] = useState('');
  const load = useCallback(() => {
    if (mode === 'range' && (!from || !to)) return;
    const q = mode === 'month' ? { month, role } : { from, to, role };
    let active = true;
    Promise.all([liveApi.commissions(q), liveApi.wages(q)])
      .then(([comm, wages]) => {
        if (active) {
          setData({ comm, wages });
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(errText(e));
      });
    return () => {
      active = false;
    };
  }, [month, mode, from, to, role]);
  useEffect(load, [load]);
  useEffect(() => {
    setPersonId('');
    setData(null);
  }, [role]);
  const usedWages=new Set<number>();
  const allRows = (data?.comm.rows ?? []).map((r) => {
    const w = data?.wages.rows.find(
      (w) => !usedWages.has(w.id) && w.sessionId === r.sessionId && w.userId === r.userId && (w.role ?? 'anchor') === r.role,
    );
    if(w)usedWages.add(w.id);
    return {
      ...r,
      wageCents: w?.amountCents ?? 0,
      minutes: w?.minutes ?? 0,
      hourlyRateCents: w?.hourlyRateCents ?? 0,
      totalCents: r.amountCents + (w?.amountCents ?? 0),
    };
  });
  const rows = allRows.filter((r) => !personId || String(r.userId) === personId);
  const people = [...new Map(allRows.map((r) => [r.userId, r.userName])).entries()];
  const summary = new Map<number, { name: string; count: number; minutes: number; wage: number; commission: number }>();
  const countedSessions=new Set<string>();
  for (const r of rows) {
    const p = summary.get(r.userId) ?? { name: r.userName, count: 0, minutes: 0, wage: 0, commission: 0 };
    const key=`${r.userId}:${r.sessionId}`;if(!countedSessions.has(key)){p.count++;countedSessions.add(key);}
    p.minutes += r.minutes;
    p.wage += r.wageCents;
    p.commission += r.amountCents;
    summary.set(r.userId, p);
  }
  function exportCsv() {
    downloadText(
      '直播工资明细.csv',
      toCsv([
        [
          '日期',
          '房间',
          '平台',
          '人员',
          '角色',
          '计薪分钟',
          '时薪',
          '时间工资',
          '销售额',
          '提成比例',
          '提成',
          '合计',
          '场次编号',
          '直播开始时间',
          '直播结束时间',
          '场次产品',
        ],
        ...rows.map((r) => [
          r.date,
          r.roomName,
          LIVE_PLATFORMS[r.platform??'']??'历史场次',
          r.userName,
          r.roleLabel,
          String(r.minutes),
          yuanText(r.hourlyRateCents),
          yuanText(r.wageCents),
          yuanText(r.finalSalesCents),
          ratePct(r.rateUnits),
          yuanText(r.amountCents),
          yuanText(r.totalCents),
          String(r.sessionId),
          r.startAt,
          r.endAt ?? '',
          productText(r.products),
        ]),
      ]),
    );
  }
  return (
    <div className="live-page">
      <div className="live-filter card">
        <label className="live-field">
          查看方式
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="month">按月</option>
            <option value="range">按日期范围</option>
          </select>
        </label>
        {mode === 'month' ? (
          <label className="live-field">
            月份
            <input type="month" aria-label="工资月份" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
        ) : (
          <>
            <label className="live-field">
              开始日期
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="live-field">
              结束日期
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
        {data?.comm.scope === 'all' && (
          <label className="live-field">
            人员
            <select aria-label="工资人员" value={personId} onChange={(e) => setPersonId(e.target.value)}>
              <option value="">全部人员</option>
              {people.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="secondary-button" onClick={exportCsv} disabled={!data}>
          导出明细
        </button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted" role="status">正在读取工资与提成…</p>}
      {data && (
        <p className="muted">
          {data.comm.scope === 'all' ? '全部人员' : '仅本人'} · 已审核工资与提成，最终应发以工资结算单为准。
        </p>
      )}
      <div className="live-cards">
        <div className="card live-stat">
          <span>时间工资</span>
          <strong>{money(rows.reduce((n, r) => n + r.wageCents, 0))}</strong>
        </div>
        <div className="card live-stat">
          <span>提成</span>
          <strong>{money(rows.reduce((n, r) => n + r.amountCents, 0))}</strong>
        </div>
        <div className="card live-stat">
          <span>工资与提成合计（结算前）</span>
          <strong>{money(rows.reduce((n, r) => n + r.totalCents, 0))}</strong>
        </div>
      </div>
      <section className="card live-section">
        <h2>按人员汇总</h2>
        <div className="live-scroll">
          <table className="data-table live-responsive-table" aria-label="工资汇总">
            <thead>
              <tr>
                <th>人员</th>
                <th>场次</th>
                <th>计薪时长</th>
                <th>时间工资</th>
                <th>提成</th>
                <th>合计</th>
              </tr>
            </thead>
            <tbody>
              {data && !summary.size && <tr><td colSpan={6} className="live-empty">该期间暂无已审核的工资与提成。</td></tr>}
              {[...summary].map(([id, p]) => (
                <tr key={id}>
                  <td data-label="人员">{p.name}</td>
                  <td data-label="场次">{p.count}</td>
                  <td data-label="计薪时长">{minutesText(p.minutes)}</td>
                  <td data-label="时间工资">{money(p.wage)}</td>
                  <td data-label="提成">{money(p.commission)}</td>
                  <td data-label="合计">
                    <strong>{money(p.wage + p.commission)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card live-section">
        <h2>场次工资明细</h2>
        <p className="muted pad">每场计时工资仅计算一次；各平台分别列示营业额、比例与提成。</p>
        {data && !rows.length && <p className="muted pad">该期间暂无已审核记录</p>}
        <div className="live-scroll">
          <table className="data-table live-responsive-table" aria-label="工资提成明细">
            <thead>
              <tr>
                <th>日期 / 时间 / 直播间 / 产品</th>
                <th>人员</th>
                <th>时长 / 时薪</th>
                <th>时间工资</th>
                <th>销售额 / 比例</th>
                <th>提成</th>
                <th>合计</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="live-payroll-session" data-label="日期 / 时间 / 直播间 / 产品">
                    <span className="live-payroll-date">{r.date} <strong>{hm(r.startAt,r.date)}–{r.endAt?hm(r.endAt,r.date):'下播时间未记录'}</strong></span>
                    <span>{r.roomName} · {LIVE_PLATFORMS[r.platform??'']??'历史场次'} · <small>产品：{productText(r.products)}</small></span>
                  </td>
                  <td data-label="人员">{r.userName}</td>
                  <td data-label="时长 / 时薪">
                    {minutesText(r.minutes)}
                    <br />
                    {money(r.hourlyRateCents)}/时
                  </td>
                  <td data-label="时间工资">{money(r.wageCents)}</td>
                  <td data-label="销售额 / 比例">
                    {money(r.finalSalesCents)}
                    <br />
                    {ratePct(r.rateUnits)}
                  </td>
                  <td data-label="提成">{money(r.amountCents)}</td>
                  <td data-label="合计">
                    <strong>{money(r.totalCents)}</strong>
                  </td>
                  <td data-label="操作">
                    <button className="link-button" onClick={() => onOpen(r.sessionId)}>
                      场次详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
