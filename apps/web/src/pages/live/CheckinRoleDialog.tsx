import { useState } from 'react';
import { liveApi, type CheckinContext, type CheckinSession } from './liveApi';
import { Modal } from './liveUi';
import { errText } from './liveFormat';
export function CheckinRoleDialog({context,onClose,onControl,onDone}:{context:CheckinContext;onClose:()=>void;onControl:(session:CheckinSession|null)=>void;onDone:()=>void}){
  const [role,setRole]=useState<'control'|'operator'>('control'),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const candidates=(context.joinable??[]).filter(s=>role==='control'?s.canJoinControl:s.canJoinOperator);
  const operators=(context.joinable??[]).filter(s=>s.canJoinOperator);
  const chosen=candidates.find(s=>String(s.id)===selected)??(selected===''?candidates[0]:null);
  async function next(){
    setError('');
    if(role==='control'){onControl(chosen??null);return;}
    if(!chosen)return setError('本场有中控上播时才可选择运营身份');
    setBusy(true);
    try{await liveApi.start({sessionId:chosen.id,role:'operator',confirmDetails:true});onDone();}catch(e){setError(errText(e));}finally{setBusy(false);}
  }
  return <Modal title="选择本场身份" onClose={onClose} foot={<button className="primary-button live-clock-button" disabled={busy||role==='operator'&&!chosen} onClick={()=>void next()}>{busy?'正在上播…':role==='control'?'下一步：核对本场信息':'确认运营身份上播'}</button>}>
    {error&&<p role="alert" className="notice error">{error}</p>}
    <fieldset className="live-role-options"><legend>本次以什么身份上播</legend>
      <label><input type="radio" name="checkin-role" value="control" checked={role==='control'} onChange={()=>{setRole('control');setSelected('');}}/><span><strong>中控</strong><small>默认身份</small></span></label>
      <label><input type="radio" name="checkin-role" value="operator" checked={role==='operator'} disabled={!operators.length} onChange={()=>{setRole('operator');setSelected('');}}/><span><strong>运营</strong><small>本场有中控时才可选择运营身份</small>{!operators.length&&<small>当前没有可加入的运营场次</small>}</span></label>
    </fieldset>
    {!!candidates.length&&<label className="live-field">本场直播<select value={chosen?.id??''} onChange={e=>setSelected(e.target.value)}>{candidates.map(s=><option key={s.id} value={s.id}>{s.roomName} · 主播 {s.anchor.name}{s.control?` · 中控 ${s.control.name}`:''}</option>)}{role==='control'&&<option value="new">按本人排班开播</option>}</select></label>}
    {chosen&&<p className="muted">{chosen.roomName} · 主播 {chosen.anchor.name} · 中控 {chosen.control?.name??'待本人确认'}{chosen.operator?` · 运营 ${chosen.operator.name}`:''}</p>}
    {role==='operator'&&chosen&&<p className="muted">{chosen.channels?.map(c=>`${c.accountName} / ${c.stores.map(s=>s.name).join('、')}`).join('；')}</p>}
  </Modal>;
}
