import { PersonPhotoName } from './PersonPhotoName';
import {useEffect,useState} from 'react';
import {liveApi,type CheckoutFeedbackRecord,type FeedbackImage,type FeedbackDraft,type SessionDetail} from './liveApi';
import {durationText,errText} from './liveFormat';
import {LiveEvidenceViewer} from './LiveEvidenceViewer';
const roleName=(role:string)=>({anchor:'主播',control:'中控',operator:'运营'}[role]??role);
function EvidenceImage({sessionId,file,onRemove}:{sessionId:number;file:FeedbackImage;onRemove?:()=>void}){
 const [url,setUrl]=useState(''),[open,setOpen]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let alive=true;liveApi.feedbackImageUrl(sessionId,file.id).then(d=>{if(alive)setUrl(d.url);}).catch(()=>{if(alive)setError('图片读取失败');});return()=>{alive=false;};},[sessionId,file.id]);
 useEffect(()=>{if(!open)return;let alive=true;liveApi.feedbackImageUrl(sessionId,file.id).then(d=>{if(alive)setUrl(d.url);}).catch(()=>{});return()=>{alive=false;};},[open,sessionId,file.id]);
 return <div className="live-feedback-image"><button type="button" className="secondary-button" onClick={()=>setOpen(true)} disabled={!url} aria-label={`查看${file.name}`}>{url?<img src={url} alt={file.name}/>:error||file.name}</button><small>{file.name}</small>{onRemove&&<button type="button" className="link-button danger-text" onClick={onRemove} aria-label={`移除${file.name}`}>移除</button>}{open&&<LiveEvidenceViewer url={url} name={file.name} onClose={()=>setOpen(false)}/>}</div>;
}
export function CheckoutFeedbackFields({sessionId,role,onChange}:{sessionId:number;role:string;onChange:(draft:FeedbackDraft)=>void}){
 const [targets,setTargets]=useState<Array<{userId:number;name:string;role:string}>>([]),[scores,setScores]=useState<Record<number,number>>({}),[images,setImages]=useState<FeedbackImage[]>([]),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let active=true;setLoaded(false);setError('');setImages([]);setScores({});onChange({ready:false,evidenceFileIds:[],ratings:[]});
  liveApi.checkoutFeedback(sessionId).then(d=>{if(!active)return;const previous=d.records.find(r=>r.role===role);setTargets(d.targets);setImages(previous?.images??[]);setScores(Object.fromEntries((previous?.ratings??[]).map(r=>[r.userId,r.score])));setLoaded(!d.locked);if(d.locked)setError('本场已锁定，不能修改下播资料');}).catch(e=>{if(active)setError(errText(e,'读取下播资料失败'));});return()=>{active=false;};
 },[sessionId,role]);
 useEffect(()=>{onChange({ready:loaded&&!busy&&(role!=='control'||images.length>0)&&targets.every(t=>scores[t.userId]!==undefined),evidenceFileIds:role==='control'?images.map(f=>f.id):[],ratings:targets.filter(t=>scores[t.userId]!==undefined).map(t=>({userId:t.userId,score:scores[t.userId]}))});},[loaded,busy,images,targets,scores,role]);
 async function upload(input:HTMLInputElement){
  const selected=Array.from(input.files??[]);input.value='';if(!selected.length)return;
  if(images.length+selected.length>10){setError('直播数据图片最多10张');return;}
  if(selected.some(f=>!f.type.startsWith('image/')||f.size>10*1024*1024)){setError('请选择10MB以内的直播数据图片');return;}
  setBusy(true);setError('');
  try{for(const file of selected){const saved=await liveApi.uploadFeedbackImage(sessionId,file);setImages(current=>[...current,saved]);}}catch(e){setError(errText(e,'图片上传失败，请重试'));}finally{setBusy(false);}
 }
 return <section className="live-feedback-fields" aria-label="下播数据与本场互评">
  {!loaded&&!error&&<p role="status">正在读取本场互评人员…</p>}
  {role==='control'&&<div><h3>本场直播数据图片（必填）</h3><p className="muted">请上传本场直播后台数据截图，最多10张，每张不超过10MB，随下播报告交人事审核。</p><label className="live-field">上传直播数据图片<input type="file" aria-label="上传直播数据图片" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={!loaded||busy} onChange={e=>void upload(e.currentTarget)}/></label>{busy&&<p role="status">正在上传图片…</p>}<div className="live-feedback-images">{images.map(file=><EvidenceImage key={file.id} sessionId={sessionId} file={file} onRemove={busy?undefined:()=>setImages(current=>current.filter(f=>f.id!==file.id))}/>)}</div></div>}
  {loaded&&<div><h3>本场人员互评（满分10分）</h3><p className="muted">拖动滑杆为实际参与的其他人员评分，0分也可以；评分保留在审核记录中，不影响工资计算。</p>{!targets.length&&<p>本场没有需要你评分的其他人员。</p>}{targets.map(t=><label key={t.userId} className="live-rating-row"><span>{roleName(t.role)} · {t.role==='anchor'?<PersonPhotoName personId={t.userId} name={t.name}/>:t.name}</span><input type="range" min={0} max={10} step={1} value={scores[t.userId]??5} aria-label={`给${t.name}评分`} aria-valuetext={scores[t.userId]===undefined?'尚未评分':`${scores[t.userId]}分，满分10分`} onChange={e=>setScores(v=>({...v,[t.userId]:Number(e.target.value)}))} onPointerUp={e=>{const score=Number(e.currentTarget.value);setScores(v=>({...v,[t.userId]:score}));}}/><output>{scores[t.userId]===undefined?'未评分':`${scores[t.userId]} / 10`}</output></label>)}</div>}
  {error&&<p role="alert" className="notice error">{error}</p>}
 </section>;
}
export function CheckoutFeedbackRecords({sessionId,records,attendance}:{sessionId:number;records?:CheckoutFeedbackRecord[];attendance?:SessionDetail['attendance']}){
 if(!records?.length&&!attendance?.length)return null;
 return <section className="live-feedback-records" aria-label="下播图片与互评记录"><h3>下播图片与本场互评</h3>{!!attendance?.length&&<div className="live-scroll"><table className="data-table" aria-label="本人原始上下播记录"><thead><tr><th>人员</th><th>身份</th><th>本人上播</th><th>本人下播</th><th>本人时长</th></tr></thead><tbody>{attendance.map(a=><tr key={a.role}><td>{a.role==='anchor'?<PersonPhotoName personId={a.userId} name={a.name}/>:a.name}</td><td>{roleName(a.role)}</td><td>{a.startAt}</td><td>{a.correctedEndAt?<span>未报下播 · 审核已修复：{a.correctedEndAt}</span>:a.autoCheckout?<span className="danger-text">未报下播 · 下播时间异常（系统自动下播：{a.endAt}）</span>:a.endAt??'未报下播'}</td><td>{durationText(a.startAt, a.correctedEndAt ?? (a.autoCheckout ? null : a.endAt)) || '—'}</td></tr>)}</tbody></table><p className="muted">工资默认按各自打卡时间计算；人事可分别修正计薪时间并重新试算，原始记录保留。</p></div>}{(records??[]).map(r=><div className="card pad" key={r.role}><strong>{roleName(r.role)} · {r.role==='anchor'?<PersonPhotoName personId={r.reporterId} name={r.reporterName}/>:r.reporterName}</strong><small className="muted"> · {r.submittedAt}</small>{!!r.images.length&&<div className="live-feedback-images">{r.images.map(f=><EvidenceImage key={f.id} sessionId={sessionId} file={f}/>)}</div>}<ul>{r.ratings.map(t=><li key={t.userId}>{roleName(t.role)} {t.role==='anchor'?<PersonPhotoName personId={t.userId} name={t.name}/>:t.name}：<strong>{t.score} / 10</strong></li>)}</ul>{!r.ratings.length&&<p className="muted">本次没有其他实际参与人员需要评分。</p>}</div>)}</section>;
}
