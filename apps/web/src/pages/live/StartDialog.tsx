import { PersonPhotoName } from './PersonPhotoName';
import type { LiveProductSnapshot } from '@kudesi/shared';
import { ManualProductEditor } from './ManualProductEditor';
import { productEntries, emptyManualProduct } from './liveProducts';
import { initialChannels } from './ChannelPicker';
import { StartChannelChoice } from './StartChannelChoice';
import { useEffect, useState } from 'react';
import { liveApi, type Options, type Product, type ScheduleRow, type CheckinSession } from './liveApi';
import { errText, nowText } from './liveFormat';
import { Modal } from './liveUi';
import './liveStart.css';
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
  const [editingRoom,setEditingRoom]=useState(false);
  const [editingPeople,setEditingPeople]=useState(false);
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

  useEffect(()=>setConfirmed(false),[roomId,anchorId,controlId,operatorId,channels,picked]);

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
    <Modal bodyClassName="live-start-body" title={joining?'核对本场并确认本人上播':schedule ? '报上播（按排场）' : '报上播（临时加场）'} onClose={onClose} foot={<>
      {error && <div role="alert" className="notice error live-start-submit-error">{error}</div>}
      <button type="button" className="secondary-button" onClick={onClose}>取消</button>
      <button type="button" className="primary-button live-clock-button" disabled={busy || !opts} onClick={() => void submit()}>{busy ? '提交中…' : beforePlan&&early?'仍要提前开播':'确认上播'}</button>
    </>}>
      {joining&&<p className="notice">本场已经开播。请核对以下实际场次信息，确认后只记录你本人的上播，不会再开一场。</p>}
      <div className="live-start-intro"><span>{joining ? '加入已开播场次' : schedule ? '按排班上播' : '临时加场'}</span><h3 aria-label={schedule?'直播间':undefined}>{schedule?.roomName ?? '确认本次直播'}</h3><p>{schedule ? `${schedule.date} · ${schedule.startTime}–${schedule.endTime}` : '依次选择人员、账号店铺和在卖产品。'}</p><small>以点击确认的实际时间记录上播。</small></div>
      {!opts ? <p className="muted" role="status">正在读取选项…</p> : (
        <div className="live-start-sections">
          <section className="live-start-section" aria-label="本场人员"><header><span>01</span><div><h3>本场信息</h3><p>核对直播间和参与人员</p></div></header><div className="live-fields">
          {!schedule&&<div className="live-start-room">
            <div className="live-start-summary-line"><span>直播间</span><strong aria-label="直播间">{opts.rooms.find(r=>String(r.id)===roomId)?.name??(roomId?`直播间 #${roomId}`:'尚未选择')}</strong></div>
            {!schedule&&!fixedRoomId&&<button type="button" className="secondary-button live-start-change" aria-expanded={editingRoom} onClick={()=>setEditingRoom(v=>!v)}>{editingRoom?'收起直播间选择':roomId?'切换直播间':'选择直播间'}</button>}
            {editingRoom&&!schedule&&!fixedRoomId&&<label className="live-field live-start-edit-area">选择直播间<select value={roomId} onChange={e=>{setRoomId(e.target.value);if(e.target.value)setEditingRoom(false);}}><option value="">请选择</option>{opts.rooms.map(r=><option key={r.id} value={r.id} disabled={r.live}>{r.name}{r.live?'（正在直播）':''}</option>)}</select></label>}
          </div>}
          <div className={`live-start-people${schedule?' wide':''}`}>
            <dl className="live-start-people-summary">
              <div><dt>主播</dt><dd aria-label="本场主播"><PersonPhotoName personId={Number(anchorId)||schedule?.anchor.id} name={String(schedule?.anchor.id)===anchorId?schedule?.anchor.name??'待选择':opts.anchors.find(p=>String(p.id)===anchorId)?.name??(identity.isAnchor?'本人':'待选择')}/></dd></div>
              <div><dt>中控</dt><dd>{opts.controls.find(p=>String(p.id)===controlId)?.name??(identity.isControl&&!identity.isAnchor?'本人':'未安排')}</dd></div>
              {operatorId&&<div><dt>运营</dt><dd>{opts.operators.find(p=>String(p.id)===operatorId)?.name??schedule?.operator?.name??'待核对'}</dd></div>}
            </dl>
            <button type="button" className="secondary-button live-start-change" aria-expanded={editingPeople} onClick={()=>setEditingPeople(v=>!v)}>{editingPeople?'收起人员选择':'调整本场人员'}</button>
            {editingPeople&&<div className="live-fields live-start-edit-area">
              {(!identity.isAnchor || identity.canManage) && <label className="live-field">主播<select disabled={!!joining||trialAnchor} value={anchorId} onChange={(e) => setAnchorId(e.target.value)}><option value="">{identity.isAnchor ? '本人' : '请选择'}</option>{opts.anchors.map((p) => <option key={p.id} value={p.id} disabled={p.live}>{p.name}{p.live ? '（正在直播）' : ''}</option>)}</select></label>}
              <label className="live-field">中控（可选）<select disabled={!!joining} value={controlId} onChange={(e) => setControlId(e.target.value)}><option value="">{identity.isControl && !identity.isAnchor ? '本人' : '无'}</option>{opts.controls.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label className="live-field">运营（可选，审核时由人事确认）<select value={operatorId} onChange={(e) => setOperatorId(e.target.value)}><option value="">无</option>{opts.operators.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <button type="button" className="secondary-button live-start-change wide" onClick={()=>setEditingPeople(false)}>完成人员调整</button>
            </div>}
          </div>
          </div></section>
          <section className="live-start-section" aria-label="平台与店铺"><header><span>02</span><div><h3>平台与店铺</h3><p>仅显示本场使用的账号和店铺</p></div></header>
          <StartChannelChoice options={opts} value={channels} onChange={setChannels} schedule={schedule}/></section>
          <section className="live-start-section" aria-label="在卖产品"><header><span>03</span><div><h3>在卖产品</h3><p>至少选择或填写一个产品</p></div></header>
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
          </section>
          <section className="live-start-section live-start-confirm" aria-label="上播确认"><header><span>04</span><div><h3>确认上播</h3><p>检查完成后，点击底部按钮提交</p></div></header>
          {beforePlan && <p className="notice warn">尚未到计划开播时间。{early ? '请再次点击“仍要提前开播”确认。' : '继续开播需要二次确认。'}</p>}
      {trialAnchor&&<label className="wide notice warn"><input type="checkbox" aria-label={`确认本场由试播主播「${schedule!.anchor.name}」上播，由我代报上下播，时间用于该主播工资和提成核算`} checked={trialConfirmed} onChange={e=>setTrialConfirmed(e.target.checked)}/> 确认本场由试播主播「<PersonPhotoName personId={schedule!.anchor.id} name={schedule!.anchor.name}/>」上播，由我代报上下播，时间用于该主播工资和提成核算</label>}
          <label className="live-start-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>已核对本场人员、直播账号、关联店铺和产品<small>{identity.isControl ? '中控上播前必须确认' : '请核对后确认上播'}</small></span></label>
          </section>
        </div>
      )}
    </Modal>
  );
}

function findJoin(rows:CheckinSession[],schedule:ScheduleRow,role?:'anchor'|'control') {
  return rows.find(s=>s.scheduleId===schedule.id&&s.roomId===schedule.roomId&&(role==='anchor'?s.canJoinAnchor:role==='control'?s.canJoinControl:s.canJoinAnchor||s.canJoinControl));
}

export function StartDialog(props:Parameters<typeof StartForm>[0]){
  const [loaded,setLoaded]=useState(false),[plans,setPlans]=useState<ScheduleRow[]>([]),[chosen,setChosen]=useState<ScheduleRow|null>(props.schedule),[error,setError]=useState('');
  const [showOtherSessions,setShowOtherSessions]=useState(false);
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
  if(!loaded)return <Modal bodyClassName="live-start-body" title="读取本人排班" onClose={props.onClose}>{error?<p role="alert">{error}</p>:<p role="status">正在读取排班和实际场次…</p>}</Modal>;
  if(existing)return <JoinDialog session={existing} role={props.role??(existing.canJoinAnchor?'anchor':'control')} onClose={props.onClose} onDone={props.onDone}/>;
  const visibleSessions=showOtherSessions?joinable:joinable.filter(s=>s.canJoinAnchor||!!s.control);
  if(!props.schedule&&!chosen)return <Modal bodyClassName="live-start-body live-start-selection" title="选择本次排班" onClose={props.onClose}><p>{plans.length||visibleSessions.length?'请选择本次要播的场次。':'当前没有已安排给你的待上播场次。'}</p><div className="live-checkin-actions">{visibleSessions.map(s=><div className="live-checkin-choice" key={`session-${s.id}`}><button type="button" className="primary-button live-clock-button" aria-label={`直播中 · 加入本场 ${s.roomName} · 主播 ${s.anchor.name}`} onClick={()=>setExisting(s)}><small>直播中 · 加入本场</small><strong>{s.roomName}</strong></button><span>主播 <PersonPhotoName personId={s.anchor.id} name={s.anchor.name}/></span></div>)}{!showOtherSessions&&visibleSessions.length<joinable.length&&<button type="button" className="secondary-button live-clock-button" onClick={()=>setShowOtherSessions(true)}>选择其他可加入场次</button>}{plans.map(s=><button className="primary-button live-clock-button" key={s.id} onClick={()=>setChosen(s)}><small>待上播 · 我的排班</small><strong>{s.roomName}</strong><span>{s.date} · {s.startTime}–{s.endTime}</span></button>)}{!plans.length&&!joinable.length&&<p>没有可开播的排班，请联系人事安排。</p>}</div></Modal>;
  return <StartForm {...props} schedule={chosen} onExisting={setExisting}/>;
}

/** When another role has already opened the room, confirm the actual session rather than the original plan. */
export function JoinDialog({session,role,onClose,onDone}:{session:CheckinSession;role:'anchor'|'control';onClose:()=>void;onDone:(id:number)=>void}){
  const actual:ScheduleRow={anchorTrial:session.anchorTrial,id:session.scheduleId??0,roomId:session.roomId,roomName:session.roomName,date:session.date,start:session.startAt,end:session.endAt??session.startAt,startTime:session.startAt.slice(11,16),endTime:(session.endAt??session.plannedEnd??session.startAt).slice(11,16),status:'live',statusLabel:'直播中',anchor:session.anchor,control:session.control,operator:session.operator,douyinAccount:session.douyinAccount,store:session.store,channels:session.channels,products:session.products,sessionId:session.id,note:null,cancelReason:null};
  return <StartForm role={role} joining={session} schedule={actual} identity={{isAnchor:role==='anchor',isControl:role==='control',canManage:false}} onClose={onClose} onDone={onDone}/>;
}
