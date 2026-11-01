import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { fmtTime } from '../flow/flowApi';
import type { AuditRow,SessionClient } from './sessionApi';
import type { RemoteApi } from './remote/remoteApi';
import { RemoteHistory } from './remote/RemotePanels';

const EVENT:Record<string,string>={managed_shop_added:'添加店铺',managed_shop_removed:'移除店铺',managed_shop_assigned:'分配电脑',credentials_updated:'保存账号密码',credentials_cleared:'清除账号密码',credential_viewed:'查看密码',auto_login_changed:'自动登录设置',store_status_changed:'店铺状态变更',bind_code_created:'生成绑定码',device_registered:'电脑绑定',device_remark_changed:'修改电脑备注',device_revoked:'撤销电脑',device_restored:'恢复电脑',device_deleted:'删除电脑记录',shop_open_completed:'打开店铺',shop_open_failed:'打开店铺',agent_installer_downloaded:'下载安装包',shop_open_requested:'请求登录店铺',shop_capture_requested:'请求截图',shop_capture_completed:'截图完成',shop_capture_failed:'截图失败',auto_login_credentials_delivered:'交付自动登录凭据',agent_release_published:'发布助手版本',agent_release_withdrawn:'撤回助手版本',agent_update_queued:'安排助手升级',agent_update_failed:'助手升级失败',agent_update_rolled_back:'助手升级回退',remote_device_enabled:'开启远程协助',remote_device_disabled:'关闭远程协助',remote_requested:'申请远程协助',remote_started:'开始远程协助',remote_ended:'结束远程协助',remote_extended:'延长远程协助',remote_stop_all:'停止全部远程协助'};
export function SessionAudit({client,remoteClient,managePermission,remotePermission}: {client:SessionClient;remoteClient:RemoteApi;managePermission:string;remotePermission:string}) {
  const [rows,setRows]=useState<AuditRow[]|null>(null),[error,setError]=useState('');
  const load=useCallback(()=>{setError('');client.audit().then(setRows).catch(e=>setError(e.message));},[client]);
  useEffect(load,[load]);
  return <><section className="session-panel"><div className="session-toolbar"><div className="session-panel-title"><strong>最近 100 条安全操作日志</strong><small>日志不记录 Cookie、Token、私钥、验证码或完整密文</small></div><button type="button" className="session-secondary" onClick={load}><RefreshCw size={15}/>刷新</button></div>
    {error&&<div role="alert" className="session-alert">{error}</div>}
    <div className="session-table-scroll"><table className="session-table"><thead><tr><th>时间</th><th>事件</th><th>结果</th><th>店铺</th><th>电脑</th><th>说明</th></tr></thead><tbody>{!rows||!rows.length?<tr><td colSpan={6} className="session-empty">{rows?'暂无操作日志':'正在加载日志…'}</td></tr>:rows.map(r=><tr key={r.id}><td>{fmtTime(r.createdAt)}</td><td>{EVENT[r.eventType]||r.eventType}</td><td><span className={`session-badge ${r.eventType.includes('failed')?'error':'valid'}`}>{r.eventType.includes('failed')?'失败':'已记录'}</span></td><td>{r.storeName||'-'}</td><td>{r.deviceName||'-'}</td><td>{r.actorName?`${r.actorName} · `:''}{r.summary}</td></tr>)}</tbody></table></div>
  </section><details className="session-more"><summary>远程协助记录</summary><RemoteHistory client={remoteClient} managePermission={managePermission} remotePermission={remotePermission}/></details></>;
}
