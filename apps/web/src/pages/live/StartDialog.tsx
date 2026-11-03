import type { LiveProductSnapshot } from '@kudesi/shared';
import { ManualProductEditor } from './ManualProductEditor';
import { productEntries, emptyManualProduct } from './liveProducts';
import { ChannelPicker, initialChannels } from './ChannelPicker';
import { useEffect, useState } from 'react';
import { liveApi, type Options, type Product, type ScheduleRow, type SessionDetail, type CheckinSession } from './liveApi';
import { errText, nowText } from './liveFormat';
import { Modal, names } from './liveUi';
import { ApiError } from '../../api/client';

/** 报上播：从排场带出（人、房间已定），或临时加场；必须选有直播权限的账号、关联店铺，并至少填写或选择 1 个在卖产品。 */
function StartForm({ schedule, identity, joining, role:checkinRole, roomId: fixedRoomId, onClose, onDone, onExisting }: { onExisting?:(s:CheckinSession)=>void; role?:'anchor'|'control'; joining?:CheckinSession; roomId?:number; schedule: ScheduleRow | null; identity: { isAnchor: boolean; isControl: boolean; canManage: boolean }; onClose: () => void; onDone: (sessionId: number) => void }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [roomId, setRoomId] = useState(String(schedule?.roomId??fixedRoomId??''));
  const [anchorId, setAnchorId] = useState(String(schedule?.anchor.id??''));
  const [controlId, setControlId] = useState(String(schedule?.control?.id??''));
  const [operatorId, setOperatorId] = useState(String(schedule?.operator?.id??''));
  const [channels,setChannels]=useState(initialChannels(schedule));
  const [confirmed,setConfirmed]=useState(false);
  const [early,setEarly]=useState(false);
  const [trialConfirmed,setTrialConfirmed]=useState(false);
  const trialAnchor=!!schedule?.anchorTrial && identity.isControl;
  useEffect(()=>setTrialConfirmed(false),[schedule?.id,schedule?.anchor.id]);
  const beforePlan=!!schedule && nowText()<(schedule.start??`${schedule.date} ${schedule.startTime}:00`).slice(0,16);
  const [keyword, setKeyword] = useState('');
  const [found, setFound] = useState<Product[]>([]);
  const [picked, setPicked] = useState<LiveProductSnapshot[]>(schedule ? (schedule.products?.length ? schedule.products : [emptyManualProduct()]) : []);

  useEffect(() => { liveApi.options().then(setOpts).catch((e) => setError(errText(e, '加载选项失败'))); }, []);
  useEffect(() => {
    if (schedule) return;
    const t = setTimeout(() => { liveApi.products(keyword.trim()).then(setFound).catch(() => setFound([])); }, 250);
    return () => clearTimeout(t);
  }, [keyword, schedule]);

  const toggle = (p: LiveProductSnapshot) => setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : cur.length >= 100 ? cur : [...cur, p]));

  async function submit() {
    setError('');
    setBusy(true);
    try {
      if(!joining&&schedule&&onExisting){
        const context=await liveApi.checkinContext();
        const existing=findJoin(context.joinable??[],schedule,checkinRole);
        if(existing){onExisting(existing);return;}
      }
      if (!schedule && !roomId) return setError('请选择直播间');
      if (!channels.length || channels.some(c=>!c.storeIds.length)) return setError('请选择直播账号及关联店铺');
      if (!productEntries(picked).length) return setError(schedule ? '请至少填写 1 个在卖产品' : '请至少选择 1 个在卖产品');
      if(identity.isControl&&!confirmed)return setError('请先核对并确认本场信息');
      if(trialAnchor&&!trialConfirmed)return setError('请确认本场上播的试播主播');
      if(beforePlan&&!early){setEarly(true);return;}
      const r = await liveApi.start({
        confirmTrialAnchorId:trialAnchor&&trialConfirmed?schedule!.anchor.id:undefined,role:checkinRole,sessionId:joining?.id,confirmDetails:confirmed,confirmEarly:early,scheduleFingerprint:schedule?.fingerprint, scheduleId: schedule?.id ?? null, roomId: roomId ? Number(roomId) : null, anchorId: anchorId ? Number(anchorId) : null, controlId: controlId ? Number(controlId) : null, operatorId: operatorId ? Number(operatorId) : null,
        channels,douyinAccountId: channels[0].accountId, storeId: channels[0].storeIds[0], ...(schedule ? { productEntries: productEntries(picked) } : { productIds: picked.flatMap((p) => p.id === null ? [] : [p.id]) }),
      });
      onDone(r.id);
    } catch (e) {
      if(e instanceof ApiError&&e.status===409&&!joining&&schedule&&onExisting){
        try {const context=await liveApi.checkinContext();const existing=findJoin(context.joinable??[],schedule,checkinRole);if(existing){onExisting(existing);return;}}catch { /* Keep the original error; never submit an uncertain request again. */ }
      }
      setError(errText(e));
    } finally { setBusy(false); }
  }

  return (
    <Modal error={error} title={joining?'核对本场并确认本人上播':schedule ? '报上播（按排场）' : '报上播（临时加场）'} size="wide" onClose={onClose} foot={<>
      <button type="button" className="secondary-button" onClick={onClose}>取消</button>
      <button type="button" className="primary-button live-clock-button" disabled={busy || !opts} onClick={() => void submit()}>{busy ? '提交中…' : beforePlan&&early?'仍要提前开播':'确认上播'}</button>
    </>}>
      {joining&&<p className="notice">本场已经开播。请核对以下实际场次信息，确认后只记录你本人的上播，不会再开一场。</p>}
      {schedule && <p className="muted">{schedule.roomName} · {schedule.startTime}–{schedule.endTime} · 主播 {schedule.anchor.name}{schedule.control ? `，中控 ${schedule.control.name}` : ''}{schedule.operator ? `，运营 ${schedule.operator.name}` : ''}</p>}
      {trialAnchor&&<label className="wide notice warn"><input type="checkbox" checked={trialConfirmed} onChange={e=>setTrialConfirmed(e.target.checked)}/> 确认本场由试播主播「{schedule!.anchor.name}」上播，由我代报上下播，时间用于该主播工资和提成核算</label>}
      {!opts ? <p className="muted" role="status">正在读取选项…</p> : (
        <div className="live-fields">
          {(
            <>
              <label className="live-field">直播间<select disabled={!!schedule||!!fixedRoomId} value={roomId} onChange={(e) => setRoomId(e.target.value)}><option value="">请选择</option>{opts.rooms.map((r) => <option key={r.id} value={r.id} disabled={r.live}>{r.name}{r.live ? '（正在直播）' : ''}</option>)}</select></label>
              {(!identity.isAnchor || identity.canManage) && <label className="live-field">主播<select disabled={!!schedule} value={anchorId} onChange={(e) => setAnchorId(e.target.value)}><option value="">{identity.isAnchor ? '本人' : '请选择'}</option>{opts.anchors.map((p) => <option key={p.id} value={p.id} disabled={p.live}>{p.name}{p.live ? '（正在直播）' : ''}</option>)}</select></label>}
              <label className="live-field">中控（可选）<select disabled={!!schedule} value={controlId} onChange={(e) => setControlId(e.target.value)}><option value="">{identity.isControl && !identity.isAnchor ? '本人' : '无'}</option>{opts.controls.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label className="live-field">运营（可选，审核时由人事确认）<select value={operatorId} onChange={(e) => setOperatorId(e.target.value)}><option value="">无</option>{opts.operators.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            </>
          )}
          <ChannelPicker options={opts} value={channels} onChange={setChannels}/>
<p className="wide muted">按点击确认的实际时间记录上播，排班时间仅供参考。</p>
          {beforePlan && <p className="notice warn wide">尚未到计划开播时间。{early ? '请再次点击“仍要提前开播”确认。' : '继续开播需要二次确认。'}</p>}
          <label className="wide"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 已核对本场人员、直播账号、关联店铺和产品（中控必选）</label>

          {schedule ? <ManualProductEditor products={picked} onChange={setPicked} /> : <div className="wide live-field">
            <span>在卖产品（{picked.length}/100，至少 1 个）</span>
            <input aria-label="搜索产品" type="search" placeholder="按编码或名称搜索" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
            <div className="live-pickbox" aria-label="产品列表">
              {found.length === 0 && <p className="muted pad">没有找到产品</p>}
              {found.map((p) => (
                <label key={p.id}><input type="checkbox" checked={picked.some((x) => x.id === p.id)} onChange={() => toggle(p)} />{p.code} · {p.name}{p.spec ? ` · ${p.spec}` : ''}</label>
              ))}
            </div>
            {picked.length > 0 && <div className="live-chips" aria-label="已选产品">{picked.map((p) => <button type="button" key={p.id} className="pill" onClick={() => toggle(p)} title="点击移除">{p.code} ×</button>)}</div>}
          </div>}
        </div>
      )}
      {schedule && opts && <p className="muted">本场人员：{names(schedule.anchor, schedule.control, schedule.operator)}</p>}
    </Modal>
  );
}

function findJoin(rows:CheckinSession[],schedule:ScheduleRow,role?:'anchor'|'control') {
  return rows.find(s=>s.scheduleId===schedule.id&&s.roomId===schedule.roomId&&(role==='anchor'?s.canJoinAnchor:role==='control'?s.canJoinControl:s.canJoinAnchor||s.canJoinControl));
}

export function StartDialog(props:Parameters<typeof StartForm>[0]){
  const [loaded,setLoaded]=useState(false),[plans,setPlans]=useState<ScheduleRow[]>([]),[chosen,setChosen]=useState<ScheduleRow|null>(props.schedule),[error,setError]=useState('');
  const [existing,setExisting]=useState<CheckinSession|null>(null),[joinable,setJoinable]=useState<CheckinSession[]>([]);
  useEffect(()=>{
    let active=true;
    liveApi.checkinContext().then(d=>{
      if(!active)return;
      const eligible=(d.joinable??[]).filter(s=>(!props.roomId||s.roomId===props.roomId)&&(props.role==='anchor'?s.canJoinAnchor:props.role==='control'?s.canJoinControl:s.canJoinAnchor||s.canJoinControl));
      setJoinable(eligible);
      if(props.schedule)setExisting(findJoin(eligible,props.schedule,props.role)??null);
      setPlans(d.schedules.filter(s=>s.status==='scheduled'&&s.canStart&&s.mineRole!=='operator'&&(!props.roomId||s.roomId===props.roomId)));
      setLoaded(true);
    }).catch(e=>{if(active)setError(errText(e));});
    return()=>{active=false;};
  },[props.schedule,props.roomId,props.role]);
  if(!loaded)return <Modal title="读取本人排班" onClose={props.onClose}>{error?<p role="alert">{error}</p>:<p role="status">正在读取排班和实际场次…</p>}</Modal>;
  if(existing)return <JoinDialog session={existing} role={props.role??(existing.canJoinAnchor?'anchor':'control')} onClose={props.onClose} onDone={props.onDone}/>;
  if(!props.schedule&&!chosen)return <Modal title="选择本次排班" onClose={props.onClose}><p>已读取你的排班和实际场次，请核对要开始的场次。</p><div className="live-checkin-actions">{joinable.map(s=><button className="primary-button live-clock-button" key={`session-${s.id}`} onClick={()=>setExisting(s)}>加入已开播场次 · {s.roomName} · 主播 {s.anchor.name}</button>)}{plans.map(s=><button className="primary-button live-clock-button" key={s.id} onClick={()=>setChosen(s)}>{s.roomName} · {s.date} {s.startTime}–{s.endTime}</button>)}{!plans.length&&!joinable.length&&<p>没有可开播的排班，请联系人事安排。</p>}</div></Modal>;
  return <StartForm {...props} schedule={chosen} onExisting={setExisting}/>;
}

/** When another role has already opened the room, confirm the actual session rather than the original plan. */
export function JoinDialog({session,role,onClose,onDone}:{session:CheckinSession;role:'anchor'|'control';onClose:()=>void;onDone:(id:number)=>void}){
  const actual:ScheduleRow={anchorTrial:session.anchorTrial,id:session.scheduleId??0,roomId:session.roomId,roomName:session.roomName,date:session.date,start:session.startAt,end:session.endAt??session.startAt,startTime:session.startAt.slice(11,16),endTime:(session.endAt??session.plannedEnd??session.startAt).slice(11,16),status:'live',statusLabel:'直播中',anchor:session.anchor,control:session.control,operator:session.operator,douyinAccount:session.douyinAccount,store:session.store,channels:session.channels,products:session.products,sessionId:session.id,note:null,cancelReason:null};
  return <StartForm role={role} joining={session} schedule={actual} identity={{isAnchor:role==='anchor',isControl:role==='control',canManage:false}} onClose={onClose} onDone={onDone}/>;
}
