import { clearLiveRoom } from '../../auth/liveRoomIntent';
import { useEffect,useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { liveApi, type Workbench, type ScheduleRow } from './liveApi';
import { errText } from './liveFormat';
import { StartDialog } from './StartDialog';
import { SessionDetailDialog } from './SessionDetailDialog';
import './live.css';
/** Shared action surface for a role desk and a fixed room QR. */
export function LiveCheckinPanel({roomId,companyId}:{roomId?:number;companyId?:number}){
  const {user}=useAuth();
  const [data,setData]=useState<Workbench|null>(null),[error,setError]=useState(''),[starting,setStarting]=useState<{schedule:ScheduleRow|null}|null>(null),[opened,setOpened]=useState<number|null>(null);
  const mismatch=!!companyId&&companyId!==user?.companyId;
  function load(){if(mismatch)return;liveApi.checkinContext(roomId).then(d=>{setData(d);setError('');}).catch(e=>setError(errText(e)));}
  useEffect(()=>{if(roomId&&!mismatch)clearLiveRoom();load();const t=setInterval(load,30_000);return()=>clearInterval(t);},[roomId,companyId,user?.companyId]);
  if(mismatch)return <p role="alert" className="notice error">这个直播间属于另一家公司，请使用对应公司的本人飞书账号登录。</p>;
  return <section className="card live-section live-checkin-panel"><h2>{roomId?'直播间扫码上下播':'本场上下播'}</h2>{error&&<p role="alert" className="notice error">{error}</p>}
    {!data&&!error&&<p role="status">正在读取本人排班和场次…</p>}
    {data&&<><p className="muted">{user?.name} · 工作台和飞书扫码使用同一场次，实际点击时间计时。</p>
    <div className="live-checkin-actions">{data.active.map(s=><div key={s.id}><p>{s.roomName} · {s.statusLabel}</p>{s.checkinMode&&s.status==='live'&&!s.reportDeadline&&<button className="secondary-button live-clock-button" onClick={()=>setOpened(s.id)}>核对信息 / 本人上播</button>}<button className="primary-button live-clock-button" onClick={()=>setOpened(s.id)}>{s.reportsLocked?'查看审核场次':'下播 / 查看本场'}</button></div>)}
    {(data.identity.isAnchor||data.identity.isControl)&&<>
      {data.schedules.filter(s=>s.status==='scheduled'&&s.canStart&&s.mineRole!=='operator').map(s=><button className="primary-button live-clock-button" key={s.id} onClick={()=>setStarting({schedule:s})}>开始直播 · {s.roomName}<br/>{s.date} {s.startTime}–{s.endTime}</button>)}
      <button className="secondary-button live-clock-button" onClick={()=>setStarting({schedule:null})}>读取排班 / 无排班开播</button>
    </>}</div></>}
    {starting&&data&&<StartDialog roomId={roomId} schedule={starting.schedule} identity={data.identity} onClose={()=>setStarting(null)} onDone={id=>{setStarting(null);setOpened(id);load();}}/>}
    {opened&&<SessionDetailDialog id={opened} onClose={()=>setOpened(null)} onChanged={load}/>}
  </section>;
}
