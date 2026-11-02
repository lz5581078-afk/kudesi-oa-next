import { useEffect, useState } from 'react';
import type { PersonalLiveIncome as Income } from '@kudesi/shared';
import { liveApi } from '../live/liveApi';
import { money, minutesText } from '../live/liveFormat';

/** 只展示登录人本月已审核收入，主播、中控和运营各自分项。 */
export function PersonalLiveIncome({refreshKey=0}:{refreshKey?:number}) {
  const [data,setData]=useState<Income|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    let active=true;setData(null);setError('');
    liveApi.personalIncome().then(d=>{if(active)setData(d);}).catch(()=>{if(active)setError('本月直播收入读取失败，请重试');});
    return()=>{active=false;};
  },[refreshKey,retry]);
  if(data&&!data.anchor.visible&&!data.control.visible&&!data.operator.visible)return null;
  return <section className="card ws-section" aria-label="我的本月直播收入">
    <div className="ws-head"><h2>我的本月直播收入</h2>{data&&<span className="muted">{data.month} · 已审核</span>}</div>
    {!data&&!error&&<p role="status" className="muted ws-pad">正在读取本月直播收入…</p>}
    {error&&<div role="alert" className="notice error"><span>{error}</span><button type="button" className="link-button" onClick={()=>setRetry(x=>x+1)}>重试</button></div>}
    {data&&<>
      {(['anchor','control'] as const).map(role=>{
        const amount=data[role],label=role==='anchor'?'主播':'中控';
        return amount.visible&&<div key={role} role="group" aria-label={`本月${label}工资与提成`} className="ws-cards ws-pad">
          <div className="ws-card"><span>本月{label}工资</span><strong>{money(amount.wageCents)}</strong><small>{minutesText(amount.wageMinutes)} · 直播计时工资</small></div>
          <div className="ws-card"><span>本月{label}提成</span><strong>{money(amount.commissionCents)}</strong><small>按已审核直播记录累计</small></div>
        </div>;
      })}
      {data.operator.visible&&<div role="group" aria-label="本月运营直播提成" className="ws-cards ws-pad"><div className="ws-card"><span>本月运营直播提成</span><strong>{money(data.operator.commissionCents)}</strong><small>运营直播提成单独统计</small></div></div>}
      <p className="muted ws-pad">按北京时间本月直播日期统计已审核金额，最终应发以工资结算为准。</p>
    </>}
  </section>;
}
