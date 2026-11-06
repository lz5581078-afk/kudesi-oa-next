import { useEffect, useState } from 'react';
import { RunDetail } from '../flow/RunDetail';
import { dailyWorkApi, type DailyWorkLedger } from './dailyWorkApi';
import { errText, money, todayText } from './liveFormat';

/** 日常工时仍由统一流程核定，此处只提供直播模块入口。 */
export function DailyWorkLedgerPanel({ mode }: { mode: 'review' | 'wages' }) {
  const [month, setMonth] = useState(() => todayText().slice(0, 7));
  const [page, setPage] = useState(1), [tick, setTick] = useState(0);
  const [data, setData] = useState<DailyWorkLedger | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [runId, setRunId] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    dailyWorkApi.ledger(mode, month, page).then(result => { if (active) setData(result); })
      .catch(e => { if (active) { setData(null); setError(errText(e)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode, month, page, tick]);
  return <section className="card live-section" aria-label={mode === 'review' ? '日常工时待审核' : '日常工作工资'}>
    <div className="live-results-head"><h2>{mode === 'review' ? '日常工时待审核' : '日常工作工资'}</h2>
      {mode === 'wages' && <label className="live-field">月份 <input aria-label="工资月份" type="month" value={month} onChange={e => { setMonth(e.target.value); setPage(1); }}/></label>}
      <button type="button" onClick={() => setTick(t => t + 1)}>刷新</button>
    </div>
    {error && <p className="pad" role="alert">{error}</p>}
    {loading ? <p className="pad" role="status">正在加载…</p> : data && <>
      {data.summary && <p className="pad">已核定 {data.total} 条 · 计薪 {data.summary.minutes} 分钟 · 工资 {money(data.summary.amountCents)}。可在“工资结算”统一结算；不含待审核工时。</p>}
      <div className="live-scroll"><table className="data-table"><thead><tr><th>日期 / 人员</th><th>工作内容</th><th>实际时间</th><th>计薪工时</th><th>工资{mode === 'review' ? '（预估）' : ''}</th><th>操作</th></tr></thead><tbody>
        {data.rows.map(row => <tr key={row.id}>
          <td>{row.date}<br/>{row.name} · {row.role === 'anchor' ? '主播' : '中控'}</td>
          <td style={{ maxWidth: 320, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.content}<br/>{row.report}</td>
          <td>{row.startAt ?? '—'}<br/>至 {row.endAt ?? '—'}</td>
          <td>{row.minutes ?? '—'} 分钟</td><td>{row.amountCents === null ? '—' : money(row.amountCents)}</td>
          <td>{row.flowRunId && <button type="button" onClick={() => setRunId(row.flowRunId)}>{mode === 'review' ? '查看审核' : '审核详情'}</button>}</td>
        </tr>)}
      </tbody></table></div>
      {!data.rows.length && <p className="pad">{mode === 'review' ? '暂无待审核日常工时。' : '本月暂无已核定日常工作工资。'}</p>}
      {(data.total > 50 || page > 1) && <div className="pad"><button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button> 第 {page} 页，共 {data.total} 条 <button disabled={page * 50 >= data.total} onClick={() => setPage(p => p + 1)}>下一页</button></div>}
    </>}
    {runId !== null && <RunDetail id={runId} onClose={() => setRunId(null)} onChanged={() => setTick(t => t + 1)}/>}
  </section>;
}
