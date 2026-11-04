import { PersonPhotoName } from './PersonPhotoName';
import { useEffect, useState } from 'react';
import { liveAddDays } from '@kudesi/shared';
import { liveApi, type ScheduleRow } from './liveApi';
import { errText, nowText, todayText } from './liveFormat';

export function ManualSchedulePicker({onPick}: {onPick:(row: ScheduleRow)=>void}) {
  const [date,setDate] = useState('');
  const [rows,setRows] = useState<ScheduleRow[]|null>(null);
  const [error,setError] = useState('');
  const [retry,setRetry] = useState(0);
  useEffect(()=>{
    let current=true;
    setRows(null); setError('');
    const today=todayText();
    liveApi.schedules({from:date || liveAddDays(today,-6),to:date || today}).then(list=>{
      if(current) setRows(list.rows.filter(s=>s.status!=='cancelled' && s.start.slice(0,16)<=nowText() &&
        (s.sessionId ? ['live','pending_report','returned'].includes(s.sessionStatus ?? '') : s.status==='scheduled')).sort((a,b)=>b.start.localeCompare(a.start)));
    }).catch(e=>{if(current)setError(errText(e));});
    return ()=>{current=false;};
  },[date,retry]);
  return <fieldset className="live-manual-picker"><legend>从漏报排场补录</legend>
    <p>默认显示近七天已到开播时间、仍可补报的排场。更早的排场可按日期查找。</p>
    <label className="live-field">排场日期<input type="date" max={todayText()} value={date} onChange={e=>setDate(e.target.value)}/></label>
    {error ? <p role="alert" className="notice error">{error} <button className="secondary-button small" onClick={()=>setRetry(n=>n+1)}>重试</button></p> : !rows ? <p role="status">正在查询排场…</p> :
      !rows.length ? <p>这段时间没有可补报的排场。</p> :
      <div className="live-scroll"><table className="data-table live-responsive-table" aria-label="可补报排班"><thead><tr><th>排场时段</th><th>直播间</th><th>主播 / 运营</th><th>填报情况</th><th>操作</th></tr></thead>
      <tbody>{rows.map(s=><tr key={s.id}><td data-label="排场时段">{s.start.slice(0,16)} 至 {s.end.slice(0,16)}</td><td data-label="直播间">{s.roomName}</td><td data-label="主播 / 运营"><PersonPhotoName personId={s.anchor.id} name={s.anchor.name}/> / {s.operator?.name || '无'}</td><td data-label="填报情况">{s.sessionId?'已有开播记录，可补报':'未登记开播'}</td><td data-label="操作"><button className="secondary-button small" onClick={()=>onPick(s)}>补录这次排场</button></td></tr>)}</tbody></table></div>}
  </fieldset>;
}
