import { useCallback, useEffect, useState } from 'react';
import { downloadText, toCsv } from '../../resources/csv';
import { liveApi, type Commissions, type Person, type Wages } from './liveApi';
import { errText, minutesText, money, ratePct, roi, todayText, yuanText } from './liveFormat';

function useLedger<T>(fetcher: (p: Record<string, unknown>) => Promise<T>, canAll: boolean) {
  const [month, setMonth] = useState(todayText().slice(0, 7));
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('');
  const [d, setD] = useState<T | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { if (canAll) liveApi.people().then(setPeople).catch(() => setPeople([])); }, [canAll]);
  const load = useCallback(() => { fetcher({ month, userId: userId || undefined, role: role || undefined }).then((x) => { setD(x); setError(''); }).catch((e) => setError(errText(e, '读取失败'))); }, [fetcher, month, userId, role]);
  useEffect(load, [load]);
  return { month, setMonth, userId, setUserId, role, setRole, d, people, error, load };
}

const exportCsv = (name: string, rows: string[][]) => downloadText(name, toCsv(rows));

/** 提成记录：按月，汇总到人+角色，明细可导出；有全员权限看全部，其余只看本人。 */
export function CommissionsTab({ canAll, onOpen }: { canAll: boolean; onOpen: (sessionId: number) => void }) {
  const fetcher = useCallback((p: Record<string, unknown>) => liveApi.commissions(p), []);
  const l = useLedger<Commissions>(fetcher, canAll);
  const { d } = l;
  return (
    <div className="live-page">
      <section className="card live-section" aria-label="提成记录">
        <div className="live-filter">
          <label className="live-field">月份<input aria-label="提成月份" type="month" value={l.month} onChange={(e) => l.setMonth(e.target.value)} /></label>
          {canAll && <label className="live-field">人员<select aria-label="提成人员" value={l.userId} onChange={(e) => l.setUserId(e.target.value)}><option value="">全部</option>{l.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
          <label className="live-field">角色<select aria-label="提成角色" value={l.role} onChange={(e) => l.setRole(e.target.value)}><option value="">全部</option><option value="anchor">主播</option><option value="control">中控</option><option value="operator">运营</option></select></label>
          <button type="button" className="secondary-button" disabled={!d?.rows.length} onClick={() => d && exportCsv(`直播提成-${d.month}.csv`, [['日期', '直播间', '人员', '角色', '最终销售额', '投流', '投产', '比例', '提成', '场次编号'], ...d.rows.map((r) => [r.date, r.roomName, r.userName, r.roleLabel, yuanText(r.finalSalesCents), yuanText(r.adSpendCents), roi(r.roiScaled), ratePct(r.rateUnits), yuanText(r.amountCents), String(r.sessionId)])])}>导出 CSV</button>
        </div>
        {l.error && <div role="alert" className="notice error m">{l.error}</div>}
        {d && <p className="pad muted">{d.scope === 'all' ? '全部人员' : '仅本人'} · {d.month} 合计 <strong>{money(d.totalCents)}</strong></p>}
        {d && d.summary.length > 0 && (
          <div className="live-scroll"><table className="data-table" aria-label="提成汇总"><thead><tr><th>人员</th><th>角色</th><th className="num">场次</th><th className="num">销售额</th><th className="num">提成</th></tr></thead>
            <tbody>{d.summary.map((s) => <tr key={`${s.userId}${s.role}`}><td>{s.name}</td><td>{s.roleLabel}</td><td className="num">{s.sessions}</td><td className="num">{money(s.salesCents)}</td><td className="num">{money(s.amountCents)}</td></tr>)}</tbody></table></div>
        )}
        {d && d.rows.length === 0 && <p className="muted pad" role="status">这个月没有已审核的提成记录。</p>}
        {d && d.rows.length > 0 && (
          <div className="live-scroll"><table className="data-table" aria-label="提成明细"><thead><tr><th>日期</th><th>直播间</th><th>人员</th><th>角色</th><th className="num">最终销售额</th><th className="num">投产</th><th className="num">比例</th><th className="num">提成</th><th /></tr></thead>
            <tbody>{d.rows.map((r) => <tr key={r.id}><td>{r.date}</td><td>{r.roomName}</td><td>{r.userName}</td><td>{r.roleLabel}</td><td className="num">{money(r.finalSalesCents)}</td><td className="num">{roi(r.roiScaled)}{r.belowRoi ? ' ↓' : ''}</td><td className="num">{ratePct(r.rateUnits)}</td><td className="num">{money(r.amountCents)}</td><td><button type="button" className="link-button" onClick={() => onOpen(r.sessionId)}>场次</button></td></tr>)}</tbody></table></div>
        )}
      </section>
    </div>
  );
}

/** 主播工资记录：按月汇总与明细，权限同提成。 */
export function WagesTab({ canAll, onOpen }: { canAll: boolean; onOpen: (sessionId: number) => void }) {
  const fetcher = useCallback((p: Record<string, unknown>) => liveApi.wages(p), []);
  const l = useLedger<Wages>(fetcher, canAll);
  const { d } = l;
  return (
    <div className="live-page">
      <section className="card live-section" aria-label="主播工资记录">
        <div className="live-filter">
          <label className="live-field">月份<input aria-label="工资月份" type="month" value={l.month} onChange={(e) => l.setMonth(e.target.value)} /></label>
          {canAll && <label className="live-field">主播<select aria-label="工资人员" value={l.userId} onChange={(e) => l.setUserId(e.target.value)}><option value="">全部</option>{l.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
          <button type="button" className="secondary-button" disabled={!d?.rows.length} onClick={() => d && exportCsv(`主播工资-${d.month}.csv`, [['日期', '直播间', '主播', '上播', '下播', '分钟', '时薪', '工资', '说明', '场次编号'], ...d.rows.map((r) => [r.date, r.roomName, r.userName, r.startAt, r.endAt, String(r.minutes), yuanText(r.hourlyRateCents), yuanText(r.amountCents), r.note, String(r.sessionId)])])}>导出 CSV</button>
        </div>
        {l.error && <div role="alert" className="notice error m">{l.error}</div>}
        {d && <p className="pad muted">{d.scope === 'all' ? '全部主播' : '仅本人'} · {d.month} 合计 <strong>{money(d.totalCents)}</strong></p>}
        {d && d.summary.length > 0 && (
          <div className="live-scroll"><table className="data-table" aria-label="工资汇总"><thead><tr><th>主播</th><th className="num">场次</th><th className="num">时长</th><th className="num">工资</th></tr></thead>
            <tbody>{d.summary.map((s) => <tr key={s.userId}><td>{s.name}</td><td className="num">{s.sessions}</td><td className="num">{minutesText(s.minutes)}</td><td className="num">{money(s.amountCents)}</td></tr>)}</tbody></table></div>
        )}
        {d && d.rows.length === 0 && <p className="muted pad" role="status">这个月没有主播工资记录。</p>}
        {d && d.rows.length > 0 && (
          <div className="live-scroll"><table className="data-table" aria-label="工资明细"><thead><tr><th>日期</th><th>直播间</th><th>主播</th><th>上播–下播</th><th className="num">时长</th><th className="num">时薪</th><th className="num">工资</th><th /></tr></thead>
            <tbody>{d.rows.map((r) => <tr key={r.id}><td>{r.date}</td><td>{r.roomName}</td><td>{r.userName}</td><td>{r.startAt.slice(11)}–{r.endAt.slice(11)}</td><td className="num">{minutesText(r.minutes)}</td><td className="num">{money(r.hourlyRateCents)}{r.rateSource === 'manual' ? '（手填）' : ''}</td><td className="num">{money(r.amountCents)}</td><td><button type="button" className="link-button" onClick={() => onOpen(r.sessionId)}>场次</button></td></tr>)}</tbody></table></div>
        )}
      </section>
    </div>
  );
}
