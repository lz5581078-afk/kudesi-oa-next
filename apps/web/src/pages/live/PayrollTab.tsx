import { PersonPhotoName, SelectedAnchorProfile } from './PersonPhotoName';
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
  const commissionOnly = role === 'operator';
  const [month, setMonth] = useState(todayText().slice(0, 7)),
    [mode, setMode] = useState('month'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [personId, setPersonId] = useState('');
  const [data, setData] = useState<{ comm: Commissions; wages: Wages | null } | null>(null),
    [error, setError] = useState('');
  const load = useCallback(() => {
    if (mode === 'range' && (!from || !to)) return;
    const q = mode === 'month' ? { month, role } : { from, to, role };
    let active = true;
    Promise.all([liveApi.commissions(q), role === 'operator' ? Promise.resolve(null) : liveApi.wages(q)])
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
    const w = commissionOnly ? undefined : data?.wages?.rows.find(
      (w) => !usedWages.has(w.id) && w.sessionId === r.sessionId && w.userId === r.userId && (w.role ?? 'anchor') === r.role,
    );
    if(w)usedWages.add(w.id);
    return {
      ...r, dailyWorkId:null as number|null,dailyContent:null as string|null,
      wageCents: w?.amountCents ?? 0,
      minutes: commissionOnly ? r.liveMinutes ?? null : w?.minutes ?? 0,
      hourlyRateCents: w?.hourlyRateCents ?? 0,
      totalCents: r.amountCents + (w?.amountCents ?? 0),
    };
  });
  for(const w of data?.wages?.rows??[])if(w.dailyWorkId)allRows.push({dailyContent:w.note,dailyWorkId:w.dailyWorkId,id:w.id,sessionId:0,userId:w.userId,userName:w.userName,role:w.role??role,roleLabel:role==='anchor'?'主播':'中控',date:w.date,roomName:w.roomName,startAt:w.startAt,endAt:w.endAt,douyinName:'',platform:'',finalSalesCents:0,adSpendCents:0,roiScaled:null,belowRoi:false,rateUnits:0,amountCents:0,ruleVersionId:0,wageCents:w.amountCents,minutes:w.minutes,hourlyRateCents:w.hourlyRateCents,totalCents:w.amountCents});
  const rows = allRows.filter((r) => !personId || String(r.userId) === personId);
  const people = [...new Map(allRows.map((r) => [r.userId, r.userName])).entries()];
  const summary = new Map<number, { name: string; count: number; minutes: number; wage: number; commission: number; sales: number; unknownDurations: number }>();
  const countedSessions=new Set<string>();
  for (const r of rows) {
    const p = summary.get(r.userId) ?? { name: r.userName, count: 0, minutes: 0, wage: 0, commission: 0, sales: 0, unknownDurations: 0 };
    const key=`${r.userId}:${r.sessionId}`;
    if(!r.dailyWorkId&&!countedSessions.has(key)){
      p.count++;countedSessions.add(key);
      if(commissionOnly){p.minutes += r.minutes ?? 0;if(r.minutes==null)p.unknownDurations++;}
    }
    if(!commissionOnly)p.minutes += r.minutes ?? 0;
    p.wage += r.wageCents;
    p.commission += r.amountCents;
    p.sales += r.finalSalesCents;
    summary.set(r.userId, p);
  }
  function exportCsv() {
    downloadText(
      commissionOnly ? '运营提成明细.csv' : '直播工资明细.csv',
      toCsv([
        [
          '日期',
          '房间',
          '平台',
          '人员',
          '角色',
          commissionOnly ? '直播分钟' : '计薪分钟',
          ...(!commissionOnly ? ['时薪','时间工资'] : []),
          '销售额',
          '提成比例',
          '提成',
          ...(!commissionOnly ? ['合计'] : []),
          '场次编号',
          '直播开始时间',
          '直播结束时间',
          '场次产品',
        ],
        ...rows.map((r) => [
          r.date,
          r.roomName,
          r.dailyWorkId?'日常工作':LIVE_PLATFORMS[r.platform??'']??'历史场次',
          r.userName,
          r.roleLabel,
          r.minutes == null ? '' : String(r.minutes),
          ...(!commissionOnly ? [yuanText(r.hourlyRateCents),yuanText(r.wageCents)] : []),
          yuanText(r.finalSalesCents),
          ratePct(r.rateUnits),
          yuanText(r.amountCents),
          ...(!commissionOnly ? [yuanText(r.totalCents)] : []),
          r.dailyWorkId?`日常工作#${r.dailyWorkId}`:String(r.sessionId),
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
            {role==='anchor'&&<SelectedAnchorProfile personId={Number(personId)} name={people.find(([id])=>String(id)===personId)?.[1]}/>}
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
      {data && (
        <p className="muted">
          {data.comm.scope === 'all' ? '全部人员' : '仅本人'} · {commissionOnly ? '已审核运营提成' : '已审核工资与提成'}，最终应发以工资结算单为准。
        </p>
      )}
      <div className="live-cards">
        <div className="card live-stat">
          <span>{commissionOnly ? '累计直播时长' : '时间工资'}</span>
          <strong>{commissionOnly ? minutesText([...summary.values()].reduce((n,p)=>n+p.minutes,0)) : money(rows.reduce((n, r) => n + r.wageCents, 0))}</strong>
          {commissionOnly && [...summary.values()].some(p=>p.unknownDurations>0) && <small>部分场次时长未记录</small>}
        </div>
        <div className="card live-stat">
          <span>提成</span>
          <strong>{money(rows.reduce((n, r) => n + r.amountCents, 0))}</strong>
        </div>
        {!commissionOnly && <div className="card live-stat">
          <span>工资与提成合计（结算前）</span>
          <strong>{money(rows.reduce((n, r) => n + r.totalCents, 0))}</strong>
        </div>}
      </div>
      <section className="card live-section">
        <h2>按人员汇总</h2>
        <div className="live-scroll">
          <table className="data-table" aria-label="工资汇总">
            <thead>
              <tr>
                <th>人员</th>
                <th>场次</th>
                <th>{commissionOnly ? '直播时长' : '计薪时长'}</th>
                <th title="当前筛选范围内，已审核场次各平台核定营业额合计">营业额</th>
                {!commissionOnly && <th>时间工资</th>}
                <th>提成</th>
                {!commissionOnly && <th>合计</th>}
              </tr>
            </thead>
            <tbody>
              {[...summary].map(([id, p]) => (
                <tr key={id}>
                  <td>{role==='anchor'?<PersonPhotoName personId={id} name={p.name}/>:p.name}</td>
                  <td>{p.count}</td>
                  <td>{minutesText(p.minutes)}{p.unknownDurations>0 && <small>（{p.unknownDurations}场未记录）</small>}</td>
                  <td>{money(p.sales)}</td>
                  {!commissionOnly && <td>{money(p.wage)}</td>}
                  <td>{money(p.commission)}</td>
                  {!commissionOnly && <td>
                    <strong>{money(p.wage + p.commission)}</strong>
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card live-section">
        <h2>{commissionOnly ? '场次提成明细' : '场次工资明细'}</h2>
        <p className="muted pad">{commissionOnly ? '直播时长按实际上下播时间统计，每人每场汇总一次；' : '每场计时工资仅计算一次；'}各平台分别列示营业额、比例与提成。</p>
        {data && !rows.length && <p className="muted pad">该期间暂无已审核记录</p>}
        <div className="live-scroll">
          <table className="data-table" aria-label="工资提成明细">
            <thead>
              <tr>
                <th>日期 / 时间 / 直播间 / 产品</th>
                <th>人员</th>
                <th>{commissionOnly ? '直播时长' : '时长 / 时薪'}</th>
                {!commissionOnly && <th>时间工资</th>}
                <th>销售额 / 比例</th>
                <th>提成</th>
                {!commissionOnly && <th>合计</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="live-payroll-session">
                    <span className="live-payroll-date">{r.date} <strong>{hm(r.startAt,r.date)}–{r.endAt?hm(r.endAt,r.date):'下播时间未记录'}</strong></span>
                    {r.dailyWorkId?<span>{r.roomName}<small> · {r.dailyContent}</small></span>:<span>{r.roomName} · {LIVE_PLATFORMS[r.platform??'']??'历史场次'} · <small>产品：{productText(r.products)}</small></span>}
                  </td>
                  <td>{r.role==='anchor'?<PersonPhotoName personId={r.userId} name={r.userName}/>:r.userName}</td>
                  <td>
                    {r.minutes==null ? '时长未记录' : minutesText(r.minutes)}
                    {!commissionOnly && <><br />{money(r.hourlyRateCents)}/时</>}
                  </td>
                  {!commissionOnly && <td>{money(r.wageCents)}</td>}
                  <td>
                    {money(r.finalSalesCents)}
                    <br />
                    {ratePct(r.rateUnits)}
                  </td>
                  <td>{money(r.amountCents)}</td>
                  {!commissionOnly && <td>
                    <strong>{money(r.totalCents)}</strong>
                  </td>}
                  <td>
                    <button className="link-button" disabled={!!r.dailyWorkId} onClick={() => onOpen(r.sessionId)}>
                      {r.dailyWorkId?'日常工作':'场次详情'}
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
