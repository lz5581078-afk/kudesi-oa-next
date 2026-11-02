import { clearLiveRoom } from '../../auth/liveRoomIntent';
import { useEffect,useRef,useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { liveApi, type CheckinContext, type CheckinSession, type SessionDetail } from './liveApi';
import { errText } from './liveFormat';
import { StartDialog, JoinDialog } from './StartDialog';
import { ReportDialog } from './ReportDialog';
import { CheckinRoleDialog } from './CheckinRoleDialog';
import './live.css';
import './liveCheckin.css';
export function LiveCheckinPanel({roomId,companyId,token,workspaceType}:{roomId?:number;companyId?:number;token?:string;workspaceType?:'live_anchor'|'live_control'|'operations'}){
  const {user}=useAuth();
  const [data,setData]=useState<CheckinContext|null>(null),[error,setError]=useState(''),[mode,setMode]=useState<''|'role'|'start'|'join'|'end'>(''),[joining,setJoining]=useState<CheckinSession|null>(null),[ending,setEnding]=useState<SessionDetail|null>(null),[busy,setBusy]=useState(false);
  const [selectedRoom,setSelectedRoom]=useState('');
  const scanned=companyId!==undefined||token!==undefined||roomId!==undefined;
  const effectiveRoomId=roomId??(selectedRoom?Number(selectedRoom):undefined);
  const channel=useRef<BroadcastChannel|null>(null),loadSequence=useRef(0);
  const mismatch=!!companyId&&companyId!==user?.companyId;
  async function load(){if(mismatch)return;const seq=++loadSequence.current;try{const value=await liveApi.checkinContext(roomId,token,scanned);if(seq===loadSequence.current){setData(value);setError('');}}catch(e){if(seq===loadSequence.current){setData(null);setMode('');setEnding(null);setError(errText(e));}}}
  useEffect(()=>{
    setData(null);setMode('');setEnding(null);if(scanned&&!mismatch)clearLiveRoom();void load();
    const t=setInterval(()=>void load(),15_000),refresh=()=>void load();
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    if(typeof BroadcastChannel!=='undefined'){channel.current=new BroadcastChannel('oa-live-checkin');channel.current.onmessage=refresh;}
    return()=>{loadSequence.current++;clearInterval(t);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);channel.current?.close();channel.current=null;};
  },[roomId,companyId,token,user?.companyId]);
  const operations=workspaceType==='operations'||!workspaceType&&!!data?.identity.isOperations;
  const role=workspaceType==='live_control'||operations?'control':'anchor';
  const running=data?.active.find(s=>s.myCheckin&&!s.myCheckin.endAt&&!s.reportsLocked&&['live','pending_report'].includes(s.status));
  const canStart=!!data&&(data.identity.isAnchor||data.identity.isControl||data.identity.isOperations);
  async function changed(){setMode('');setEnding(null);setBusy(true);channel.current?.postMessage('changed');try{await load();}finally{setBusy(false);}}
  async function click(){
    if(!data||busy)return;setError('');
    if(running){setBusy(true);try{const detail=await liveApi.session(running.id);const actual=running.myCheckin!.role;if(!detail.me.reportRoles.includes(actual))throw new Error('本场已锁定或状态已变化，请刷新查看');setEnding({...detail,me:{...detail.me,reportRoles:[actual]}});setMode('end');}catch(e){setError(errText(e));await load();}finally{setBusy(false);}return;}
    if(scanned&&(!effectiveRoomId||!data.rooms.some(r=>r.id===effectiveRoomId))){setError('请选择上播直播间');return;}
    if(operations){setMode('role');return;}
    const actualRole=workspaceType?role:data.identity.isAnchor?'anchor':'control';
    const existing=(data.joinable??[]).find(s=>(!effectiveRoomId||s.roomId===effectiveRoomId)&&(actualRole==='anchor'?s.canJoinAnchor:s.canJoinControl));
    setJoining(existing??null);setMode(existing?'join':'start');
  }
  if(mismatch)return <p role="alert" className="notice error">这个二维码属于另一家公司，请使用对应公司的本人飞书账号登录。</p>;
  const effectiveRole=operations?'control':workspaceType?role:data?.identity.isAnchor?'anchor':'control';
  const schedule=data?.schedules.find(s=>s.status==='scheduled'&&s.canStart&&s.mineRole===effectiveRole&&(!effectiveRoomId||s.roomId===effectiveRoomId))??null;
  return <section className={`card live-section ${scanned?'live-scan-panel':''}`}><h2>{scanned?'扫码上下播':'本场上下播'}</h2>
    {error&&<p role="alert" className="notice error">{error}</p>}
    {!data&&!error&&<p role="status">正在读取本人排班和场次…</p>}
    {data&&<><p className="muted">{running?`${running.roomName} · 本人${running.myCheckin!.role==='operator'?'运营':running.myCheckin!.role==='control'?'中控':'主播'}身份已上播`:'工作台和飞书扫码使用同一场次，按实际确认时间记录。'}</p>
      {scanned&&!running&&canStart&&!roomId&&<label className="live-field">上播直播间<select aria-label="上播直播间" value={selectedRoom} onChange={e=>{setSelectedRoom(e.target.value);setError('');}}><option value="">请选择直播间</option>{data.rooms.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
      <div className="live-checkin-actions">{(running||canStart)&&<button className="primary-button live-clock-button" disabled={busy} onClick={()=>void click()}>{busy?'正在读取…':running?'下播':'上播'}</button>}</div>
      {!running&&data.active.some(s=>s.myCheckin?.endAt)&&<p className="muted">本人已下播，场次报告按现有流程处理。</p>}
    </>}
    {data&&mode==='role'&&<CheckinRoleDialog context={effectiveRoomId?{...data,rooms:data.rooms.filter(r=>r.id===effectiveRoomId),schedules:data.schedules.filter(s=>s.roomId===effectiveRoomId),joinable:data.joinable?.filter(s=>s.roomId===effectiveRoomId)}:data} onClose={()=>setMode('')} onControl={s=>{setJoining(s);setMode(s?'join':'start');}} onDone={()=>void changed()}/>}
    {data&&mode==='start'&&<StartDialog role={effectiveRole} roomId={effectiveRoomId} schedule={schedule} identity={{isAnchor:effectiveRole==='anchor',isControl:effectiveRole==='control',canManage:false}} onClose={()=>setMode('')} onDone={()=>void changed()}/>}
    {mode==='join'&&joining&&<JoinDialog session={joining} role={effectiveRole} onClose={()=>setMode('')} onDone={()=>void changed()}/>}
    {mode==='end'&&ending&&<ReportDialog session={ending} onClose={()=>setMode('')} onDone={()=>void changed()}/>}
  </section>;
}
