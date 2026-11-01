import { useCallback, useEffect, useState } from 'react';
import { Download, KeyRound, RefreshCw } from 'lucide-react';
import { fmtTime } from '../flow/flowApi';
import { AgentReleasePanel } from './AgentReleasePanel';
import { RemoteDeviceSettings } from './remote/RemotePanels';
import type { RemoteApi } from './remote/remoteApi';
import type { AgentRelease, DeviceRow, SessionClient } from './sessionApi';

const UPDATE: Record<string,string>={queued:'等待助手领取',downloading:'正在下载',verifying:'正在校验',staged:'更新包已就绪',applying:'正在切换版本',restarting:'正在重启',failed:'升级失败',rolled_back:'已回退',succeeded:'升级完成'};
export function SessionDevices({client,remoteClient,manage,managePermission,onChanged}: {client:SessionClient;remoteClient:RemoteApi;manage:boolean;managePermission:string;onChanged:()=>void}) {
  const [rows,setRows]=useState<DeviceRow[]>([]),[release,setRelease]=useState<AgentRelease|null>(null);
  const [code,setCode]=useState<{code:string;expiresAt:string}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[message,setMessage]=useState('');
  const load=useCallback(()=>{
    client.devices().then(setRows).catch(e=>setError(e.message));
    if(manage)client.releases().then(r=>setRelease(r.find(x=>x.isLatest&&!x.withdrawnAt)??null)).catch(e=>setError(e.message));
  },[client,manage]);
  useEffect(()=>{load();const timer=setInterval(load,5000);return()=>clearInterval(timer);},[load]);
  const run=async(key:string,fn:()=>Promise<unknown>)=>{if(busy)return;setBusy(key);setError('');setMessage('');try{await fn();load();onChanged();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy('');}};
  return <>
    <section className="session-panel">
      <div className="session-toolbar"><div className="session-panel-title"><strong>授权电脑</strong><small>设备令牌和私钥只保存在电脑本机</small></div><span className="session-total"/>
        {manage&&<><button type="button" className="session-secondary" disabled={!!busy||!release||!rows.some(d=>d.outdated)} onClick={()=>{if(window.confirm('给所有版本落后的授权电脑安排升级？离线电脑会在上线后领取。'))void run('update-all',()=>client.updateAllDevices());}}><RefreshCw size={15}/>更新全部电脑</button>
          <button type="button" className="session-secondary" disabled={!!busy||!release} onClick={()=>void run('download',async()=>{await client.downloadInstaller();setMessage('完整性校验通过，安装包已下载。解压后按包内说明安装。');})}><Download size={15}/>{busy==='download'?'正在校验…':'下载 Windows 助手安装程序'}</button>
          <button type="button" className="session-primary" disabled={!!busy} onClick={()=>void run('bind',async()=>setCode(await client.bindCode()))}><KeyRound size={15}/>生成绑定码</button></>}
      </div>
      {error&&<div role="alert" className="session-alert">{error}</div>}{message&&<div role="status" className="session-success">{message}</div>}
      <div className="session-release"><div><strong>{release?`Windows 助手 v${release.version}`:'暂未发布 Windows 助手'}</strong><small>{release?'ZIP 安装包 · 需 Node.js 20 或以上版本 · 下载前自动校验完整性':'请联系管理员发布安装包'}</small></div>{release&&<div><small>升级包 SHA-256</small><code title={release.sha256}>{release.sha256}</code></div>}</div>
      {code&&<div className="session-binding" role="status"><span>一次性绑定码</span><strong>{code.code}</strong><small>{fmtTime(code.expiresAt)} 前有效，使用后立即失效</small><button type="button" className="session-secondary" onClick={()=>setCode(null)}>关闭</button></div>}
      <div className="session-table-scroll"><table className="session-table"><thead><tr><th>电脑</th><th>备注</th><th>设备编号</th><th>系统</th><th>助手版本</th><th>店铺数</th><th>最近心跳</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>{!rows.length&&<tr><td colSpan={9} className="session-empty">还没有授权电脑，请生成绑定码并安装助手</td></tr>}{rows.map(d=><tr key={d.id}><td><strong>{d.name}</strong></td><td><span className="session-device-remark" title={d.remark||'未设置备注'}>{d.remark||'-'}</span></td><td className="mono">{d.deviceNo}</td><td>{d.os||'-'}</td><td>{d.agentVersion||'未上报'}{d.outdated&&<span className="session-badge pending">可升级</span>}{d.update&&<small title={d.update.error??undefined}>{UPDATE[d.update.status]||d.update.status}{d.update.error?`：${d.update.error}`:''}</small>}</td><td>{d.shopCount}</td><td>{fmtTime(d.lastSeenAt)}</td><td><span className={`session-badge ${d.status==='revoked'?'error':d.online?'valid':'error'}`}>{d.status==='revoked'?'已撤销':d.online?'在线':'离线'}</span></td>
          <td><div className="session-row-actions">{manage&&<>
            <button type="button" className="session-secondary" disabled={!!busy} onClick={()=>{const value=window.prompt('请输入电脑备注（最多 80 字，留空可清除）',d.remark||'');if(value!==null)void run(`remark-${d.id}`,()=>client.remarkDevice(d.id,value.trim()));}}>修改备注</button>
            {d.status==='active'&&d.outdated&&<button type="button" className="session-secondary" disabled={!!busy||!!d.update&&['queued','downloading','verifying','staged','applying','restarting'].includes(d.update.status)} onClick={()=>void run(`update-${d.id}`,()=>client.updateDevice(d.id))}>升级</button>}
            <button type="button" className={d.status==='active'?'session-danger':'session-secondary'} disabled={!!busy} onClick={()=>{if(window.confirm(d.status==='active'?`撤销「${d.name}」？设备令牌立即失效，进行中的登录任务会取消，本机登录态保留。`:`恢复「${d.name}」的授权？`))void run(`status-${d.id}`,()=>client.setStatus(d.id,d.status==='active'?'revoked':'active'));}}>{d.status==='active'?'撤销':'恢复授权'}</button>
            {d.status==='revoked'&&<button type="button" className="session-danger" disabled={!!busy} onClick={()=>{if(window.confirm(`删除「${d.name}」的电脑记录？本机登录态和历史日志保留，再次使用需重新绑定。`))void run(`delete-${d.id}`,()=>client.deleteDevice(d.id));}}>删除记录</button>}
          </>}</div></td></tr>)}</tbody></table></div>
    </section>
    {manage&&<details className="session-more"><summary>版本发布与远程协助设置</summary><AgentReleasePanel client={client} onChange={()=>{load();onChanged();}}/><RemoteDeviceSettings client={remoteClient} managePermission={managePermission} deviceNames={Object.fromEntries(rows.map(d=>[d.id,d.name]))}/></details>}
  </>;
}
