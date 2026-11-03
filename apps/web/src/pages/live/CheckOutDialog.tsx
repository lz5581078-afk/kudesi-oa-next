import { useEffect,useState } from 'react';
import { liveApi, type CheckoutPreview, type SessionDetail } from './liveApi';
import { errText, money, minutesText, yuanCents } from './liveFormat';
import { Modal } from './liveUi';
export function CheckOutDialog({session,onClose,onDone}:{session:SessionDetail;onClose:()=>void;onDone:()=>void}){
  const roles=session.me.reportRoles.filter(r=>r!=='operator');
  const [role,setRole]=useState<string>(roles[0]??'anchor'),[data,setData]=useState<CheckoutPreview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[note,setNote]=useState('');
  const stores=[...new Map((session.channels??[]).flatMap(c=>c.stores.map(s=>[s.id,{...s,platform:c.platform}] as const))).values()];
  const [ads,setAds]=useState<Record<number,string>>({});
  const [confirmed,setConfirmed]=useState(false),[trialConfirmed,setTrialConfirmed]=useState(false);
  const trialAnchor=!!session.anchorTrial&&role==='control';
  useEffect(()=>setTrialConfirmed(false),[session.id,session.anchor?.id,role]);
  useEffect(()=>{setData(null);setError('');liveApi.checkoutPreview(session.id,role).then(setData).catch(e=>setError(errText(e)));},[session.id,role]);
  async function submit(){
    if(!data||busy)return;
    const lines=stores.map(s=>({storeId:s.id,platform:s.platform,salesCents:0,adSpendCents:yuanCents(ads[s.id]??'0')??0}));
    if(role==='control'&&(!confirmed||lines.some(l=>!Number.isSafeInteger(l.adSpendCents)||l.adSpendCents<0)))return setError('请核对逐店投流费用并勾选确认');
    if(trialAnchor&&!trialConfirmed)return setError('请确认本场下播的试播主播');
    setBusy(true);setError('');
    try{await liveApi.report(session.id,{confirmTrialAnchorId:trialAnchor&&trialConfirmed?session.anchor.id:undefined,role,endAt:data.endAt,salesCents:0,adSpendCents:role==='control'?lines.reduce((n,l)=>n+l.adSpendCents,0):undefined,storeLines:role==='control'?lines:undefined,note});onDone();}catch(e){setError(errText(e));}finally{setBusy(false);}
  }
  return <Modal title="确认本人下播" onClose={onClose} foot={<button className="primary-button live-clock-button" disabled={!data||data.locked||busy} onClick={()=>void submit()}>{busy?'正在记录…':'确认下播'}</button>}>
    {roles.length>1&&<label>本次身份<select value={role} onChange={e=>setRole(e.target.value)}>{roles.map(r=><option key={r} value={r}>{r==='anchor'?'主播':'中控'}</option>)}</select></label>}
    {error&&<p role="alert" className="notice error">{error}</p>}
    {!data&&!error&&<p role="status">正在读取直播时间、有效销售额和本人收入…</p>}
    {data&&<><p>{session.roomName} · {role==='anchor'?'主播':'中控'}</p>{trialAnchor&&<label className="notice warn"><input type="checkbox" checked={trialConfirmed} onChange={e=>setTrialConfirmed(e.target.checked)}/> 确认本场下播的仍是试播主播「{session.anchor.name}」，同步记录该主播下播时间，按本场数据核算工资和提成</label>}<dl className="live-checkout-summary"><div><dt>本人上播</dt><dd>{data.startAt}</dd></div><div><dt>实际下播</dt><dd>按确认点击时间记录</dd></div><div><dt>直播时长</dt><dd>{minutesText(data.wage?.minutes??data.minutes??0)}</dd></div><div><dt>有效销售额</dt><dd>{data.salesCents===null?'待核对':money(data.salesCents)}</dd></div><div><dt>本场订单</dt><dd>{data.orderCount??'待归集'}</dd></div><div><dt>预估工资</dt><dd>{data.wage?money(data.wage.amountCents):data.wageMessage??'待人事核定时薪'}</dd></div><div><dt>预估提成</dt><dd>{data.commission?money(data.commission.amountCents):'待投流及规则核定'}</dd></div></dl>
    {data.reason&&<p className="notice warn">订单待核对：{data.reason}。可以先记录实际下播；收入核定前必须补齐订单。</p>}
    <p className="muted">销售额已扣当前有效退款；工资和提成以人事审核为准，发放提成前会再查询聚水潭退款。首人报下播满30分钟后整场锁定。</p>
    {role==='control'&&<div className="live-fields">{stores.map(s=><label className="live-field" key={s.id}>{s.name} 投流费用（元）<input inputMode="decimal" value={ads[s.id]??'0'} onChange={e=>setAds({...ads,[s.id]:e.target.value})}/></label>)}<label className="wide"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 已核对本场投流费用</label></div>}
    <label className="live-field">备注<textarea maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/></label></>}
  </Modal>;
}
