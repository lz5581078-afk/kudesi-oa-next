import './notifications.css';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';

type Settings = { enabled:boolean; digestEnabled:boolean; digestHour:number; businessRecipients:number[]; systemRecipients:number[] };
type Response = Settings & { configured:boolean; people:Array<{id:number;name:string;business:boolean;system:boolean}> };
export function NotificationsTab() {
  const [data,setData]=useState<Response|null>(null);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[saving,setSaving]=useState(false);
  useEffect(()=>{let alive=true;api<Response>('/live/notification-settings').then(r=>{if(alive)setData(r);}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[]);
  const save=async()=>{
    if(!data)return;
    setSaving(true);setError('');setMessage('');
    const {enabled,digestEnabled,digestHour,businessRecipients,systemRecipients}=data;
    try {setData(await api<Response>('/live/notification-settings',{method:'PUT',body:{enabled,digestEnabled,digestHour,businessRecipients,systemRecipients}}));setMessage('通知设置已保存');}
    catch(e){setError((e as Error).message);}finally{setSaving(false);}
  };
  const toggle=(field:'businessRecipients'|'systemRecipients',id:number)=>{if(data)setData({...data,[field]:data[field].includes(id)?data[field].filter(v=>v!==id):[...data[field],id]});};
  return <section className="card live-notification-settings">
    <h2>直播通知</h2>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {!data?<p>{error?'通知设置读取失败，请刷新后重试。':'正在读取通知设置…'}</p>:<>
      <p>排场、变更与开播前提醒由直播助手发送；审批由流程助手发送。新增通知遵循飞书总开关、助手通道开关及员工通知绑定设置。</p>
      <label className="check-line"><input type="checkbox" checked={data.enabled} onChange={e=>setData({...data,enabled:e.target.checked})}/> 启用直播催办、交接、结果及接口异常通知</label>
      <p>超时未开播 5 分钟、超时未下播 10 分钟提醒本场人员；持续 30 分钟提醒直播间负责人。下播后 30 分钟催缺报人员，报告齐全则催提交审核，持续 2 小时提醒负责人。保存启用后开始监测新场次。</p>
      <h3>经营助手 · 每日直播汇总</h3>
      <label className="check-line"><input type="checkbox" checked={data.digestEnabled} onChange={e=>setData({...data,digestEnabled:e.target.checked})}/> 开启经营日报</label>
      <p><label className="live-notification-time">北京时间每天 <select aria-label="经营日报发送时间" value={data.digestHour} disabled={!data.enabled||!data.digestEnabled} onChange={e=>setData({...data,digestHour:Number(e.target.value)})}>{Array.from({length:24},(_,i)=><option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>)}</select> 汇总上一天</label></p>
      <p>包含场次数、已审核销售额、已记录投流、ROI 和待处理异常，不包含个人工资或提成。销售额按审核结果统计，晚审核的数据以直播管理页面为准。</p>
      <fieldset><legend>日报接收人（需有直播管理查看权限）</legend>
        {data.people.filter(p=>p.business).map(p=><label key={p.id} className="check-line"><input type="checkbox" checked={data.businessRecipients.includes(p.id)} onChange={()=>toggle('businessRecipients',p.id)}/>{p.name}</label>)}
        {!data.people.some(p=>p.business)&&<p>暂无符合权限的接收人</p>}
      </fieldset>
      <h3>系统助手 · 接口异常</h3>
      <p>店铺授权到期前 7 天及到期后提醒；订单或售后查询连续失败至少 3 次、持续 5 分钟时提醒，同一接口问题每天最多一次。请为系统助手选择有接口设置查看权限的负责人。</p>
      <fieldset><legend>接口异常接收人</legend>
        {data.people.filter(p=>p.system).map(p=><label key={p.id} className="check-line"><input type="checkbox" checked={data.systemRecipients.includes(p.id)} onChange={()=>toggle('systemRecipients',p.id)}/>{p.name}</label>)}
      </fieldset>
      {!data.configured&&<p>首次保存后开始定时监测。飞书各助手的凭据和通道需在接口设置中启用。</p>}
      <p><button type="button" className="primary-button" disabled={saving||data.enabled&&data.digestEnabled&&!data.businessRecipients.length} onClick={()=>void save()}>{saving?'保存中…':'保存通知设置'}</button></p>
    </>}
  </section>;
}
