import { useEffect,useState } from 'react';
import type { Option } from './liveApi';
import { anchorMonthApi,type AnchorMonthData } from './anchorMonthApi';
import { AnchorMonthTotals } from './AnchorMonthPanel';
import { PersonPhotoName } from './PersonPhotoName';
import { errText,minutesText,money } from './liveFormat';
export function AnchorMonthSelect({people,value,onChange}:{people:Option[];value:string;onChange:(e:{target:{value:string}})=>void}) {
 const key=people.map(p=>p.id).join(','),[loaded,setLoaded]=useState<{key:string;data:AnchorMonthData}|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{let alive=true;setLoaded(null);setError('');if(key)anchorMonthApi.batch(key.split(',').map(Number)).then(data=>{if(alive)setLoaded({key,data});}).catch(e=>{if(alive)setError(errText(e,'本月业绩读取失败'));});return()=>{alive=false;};},[key,retry]);
 const data=loaded?.key===key?loaded.data:null,selected=data?.items.find(p=>String(p.userId)===value),person=people.find(p=>String(p.id)===value);
 return <><select aria-label="主播" value={value} onChange={onChange}><option value="">请选择</option>{people.map(p=>{const x=data?.items.find(x=>x.userId===p.id),s=x?.summary;return <option key={p.id} value={p.id}>{p.name}{p.trial?'（试播）':p.partTime?'（兼职）':''}｜{s?`本月 ${minutesText(s.minutes)} · 业绩 ${money(s.turnoverCents)}${s.missingSalesSessions?'（待补充）':''} · 提成 ${s.commissionCents===null?'无权限':money(s.commissionCents)}${s.missingCommissionSessions?'（待补充）':''}${s.missingTimeSessions?' · 时长待修复':''}`:error?'本月数据读取失败':'本月数据读取中…'}</option>;})}</select>
 {error&&<small className="notice">{error} <button type="button" className="link-button" onClick={()=>setRetry(x=>x+1)}>重试读取业绩</button></small>}
 {selected&&<div className="anchor-month-picked"><small>{data?.month} 本月汇总 · 含未审核</small><AnchorMonthTotals summary={selected.summary} canViewCommission={data!.canViewCommission}/>{person&&<span>查看资料：<PersonPhotoName personId={person.id} name={person.name}/></span>}</div>}</>;
}
