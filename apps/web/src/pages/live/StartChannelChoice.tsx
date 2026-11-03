import { useState } from 'react';
import { LIVE_PLATFORMS, type LiveChannelInput } from '@kudesi/shared';
import { ChannelPicker } from './ChannelPicker';
import type { Options, ScheduleRow } from './liveApi';

/** Show this session's selection first; load the full choice UI only on request. */
export function StartChannelChoice({options,value,onChange,schedule}:{options:Options;value:LiveChannelInput[];onChange:(value:LiveChannelInput[])=>void;schedule:ScheduleRow|null}) {
  const [editing,setEditing]=useState(false);
  return <div className="live-start-channel-choice">
    <div className="live-start-selected" aria-label="本场已选账号与店铺">
      {!value.length&&<p className="muted">尚未选择直播账号和店铺</p>}
      {value.map(channel=>{
        const account=options.douyinAccounts.find(a=>a.id===channel.accountId);
        const saved=schedule?.channels?.find(c=>c.accountId===channel.accountId);
        const accountName=account?.name??saved?.accountName??(schedule?.douyinAccount.id===channel.accountId?schedule.douyinAccount.name:`账号 #${channel.accountId}`);
        const platform=account?.platform??saved?.platform??'';
        return <div className="live-start-selected-channel" key={channel.accountId}>
          <small>{LIVE_PLATFORMS[platform]??'直播账号'}</small><strong>{accountName}</strong>
          <div>{channel.storeIds.length?channel.storeIds.map(id=><span key={id}>{options.stores.find(s=>s.id===id)?.name??saved?.stores.find(s=>s.id===id)?.name??(schedule?.store?.id===id?schedule.store.name:`店铺 #${id}`)}</span>):<span className="live-selection-hint">请选择本场店铺</span>}</div>
          {!account&&<p className="live-selection-hint">此账号当前不可用，请切换账号</p>}
        </div>;
      })}
    </div>
    <button type="button" className="secondary-button live-start-change" aria-expanded={editing} onClick={()=>setEditing(v=>!v)}>{editing?'收起账号选择':value.length?'切换直播账号 / 店铺':'选择直播账号 / 店铺'}</button>
    {editing&&<div className="live-start-edit-area"><ChannelPicker options={options} value={value} onChange={onChange}/><button type="button" className="secondary-button live-start-change" onClick={()=>setEditing(false)}>完成选择</button></div>}
  </div>;
}
