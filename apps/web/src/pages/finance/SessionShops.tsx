import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownUp, KeyRound, Plus, RefreshCw, Search } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { fmtTime } from '../flow/flowApi';
import { DocForm } from './DocForm';
import { InlineDevice, ShopDrawer } from './ShopInline';
import { ShopCredentials } from './ShopCredentials';
import { ShopStatusCells, STORE_STATUSES } from './ShopStatusCells';
import { AddSessionShops } from './SessionShopPicker';
import { sessionApi, type DeviceRow, type ShopList, type ShopRow, type SessionClient } from './sessionApi';
import { remoteApi, maintenanceRemoteApi, type RemoteShopState } from './remote/remoteApi';
import { RemoteAssistDialog } from './remote/RemoteAssistDialog';

import { PLATFORM_LABELS, deviceLabel } from './sessionPresentation';
const LOGIN: Record<string,[string,string]> = { none:['未登录','pending'], synced:['待验证','pending'], valid:['有效','valid'], expired:['已过期','error'], error:['异常','error'] };

export function Shops({ client = sessionApi, maintenance = false }: { client?: SessionClient; maintenance?: boolean }) {
  const { can } = useAuth();
  const [data,setData] = useState<ShopList | null>(null), [devices,setDevices] = useState<DeviceRow[]>([]);
  const [filters,setFilters] = useState({ keyword:'', loginState:'', storeStatus:'', deviceId:'', sort:'default', page:1, pageSize:50 });
  const [keyword,setKeyword] = useState(''), [pageSize,setPageSize] = useState('50');
  const [error,setError] = useState(''), [adding,setAdding] = useState(false);
  const [detail,setDetail] = useState<ShopRow | null>(null), [register,setRegister] = useState<ShopRow | null>(null), [remoteFor,setRemoteFor] = useState<ShopRow | null>(null);
  const [reasons,setReasons] = useState<Array<{id:number;reason:string}>>([]);
  const [remoteMap,setRemoteMap] = useState(new Map<number,RemoteShopState>()), [busy,setBusy] = useState<number[]>([]);
  const request = useRef(0);
  const remoteClient = maintenance ? maintenanceRemoteApi : remoteApi;
  const remotePermission = maintenance ? 'resource.company-store-maintenance.remote' : 'finance.session.remote';
  const canRemote = can(remotePermission);
  const load = useCallback(() => {
    const current = ++request.current;
    Promise.all([client.overview(filters),client.devices()]).then(([result,ds]) => {
      if (current !== request.current) return;
      setData(result); setDevices(ds); setError('');
      if (result.page !== filters.page) setFilters(f => ({...f,page:result.page}));
    }).catch(e => { if (current === request.current) setError(e instanceof Error ? e.message : '加载失败'); });
  },[client,filters]);
  useEffect(() => { load(); const timer = setInterval(load,8000); return () => { clearInterval(timer); request.current++; }; },[load]);
  useEffect(() => { const timer = setTimeout(() => setFilters(f => f.keyword === keyword ? f : {...f,keyword,page:1}),300); return () => clearTimeout(timer); },[keyword]);
  useEffect(() => { if (!maintenance) return; let alive=true; client.abnormalReasons().then(r => {if(alive)setReasons(r);}).catch(e => {if(alive)setError(e.message);}); return () => {alive=false;}; },[client,maintenance]);
  useEffect(() => {
    if (!canRemote) return;
    let alive=true;
    const refresh = () => remoteClient.shops().then(r => {if(alive)setRemoteMap(new Map(r.shops.map(s => [s.shopId,s])));}).catch(() => undefined);
    refresh(); const timer=setInterval(refresh,8000); return () => {alive=false;clearInterval(timer);};
  },[remoteClient,canRemote]);
  const filter = (patch: Partial<typeof filters>) => setFilters(f => ({...f,...patch,page:patch.page ?? 1}));
  const sort = (column: string) => filter({sort:filters.sort === `${column}_asc` ? `${column}_desc` : `${column}_asc`});
  const run = async (id:number, action:() => Promise<unknown>) => {
    setError(''); setBusy(ids => [...ids,id]);
    try { await action(); load(); } catch(e) {setError(e instanceof Error ? e.message : '操作失败');} finally {setBusy(ids => ids.filter(i=>i!==id));}
  };
  const applyPageSize = () => { const n=Number(pageSize); const value=Number.isInteger(n) ? Math.min(200,Math.max(10,n)) : filters.pageSize; setPageSize(String(value));filter({pageSize:value}); };
  const manage=!!data?.canManage;
  const online=devices.some(d=>d.status==='active' && d.online);
  return <section className="session-panel" aria-label={maintenance ? '公司店铺登录状态' : '店铺提现登录状态'}>
    <div className="session-toolbar">
      <label className="session-search"><Search size={16}/><input type="search" aria-label="搜索店铺" placeholder="搜索平台、运营、店铺名称、编码或平台店铺ID" value={keyword} onChange={e=>setKeyword(e.target.value)}/></label>
      {maintenance && <label className="session-filter">店铺状态<select aria-label="筛选店铺状态" value={filters.storeStatus} onChange={e=>filter({storeStatus:e.target.value})}><option value="">全部</option>{Object.entries(STORE_STATUSES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>}
      <label className="session-filter">本机登录态<select aria-label="筛选本机登录态" value={filters.loginState} onChange={e=>filter({loginState:e.target.value})}><option value="">全部</option><option value="valid">登录有效</option><option value="expired">登录过期</option><option value="none">未登录</option><option value="synced">待验证</option><option value="error">异常</option></select></label>
      <label className="session-filter">负责电脑<select aria-label="按负责电脑筛选" value={filters.deviceId} onChange={e=>filter({deviceId:e.target.value})}><option value="">全部电脑</option><option value="none">未分配电脑</option>{devices.map(d=><option key={d.id} value={d.id}>{deviceLabel(d)} · {d.status==='revoked' ? '已撤销' : d.online ? '在线' : '离线'}</option>)}</select></label>
      <span className="session-total">已加入 {data?.total ?? 0} 家店铺</span>
      {manage && <button type="button" className="session-primary" onClick={()=>setAdding(true)}><Plus size={15}/>添加店铺</button>}
      <button type="button" className="session-secondary" onClick={load}><RefreshCw size={15}/>刷新</button>
    </div>
    {error && <div role="alert" className="session-alert">{error}<button type="button" aria-label="关闭错误提示" onClick={()=>setError('')}>×</button></div>}
    {data && !online && <div className="session-offline"><KeyRound size={17}/><span><strong>暂无在线授权电脑</strong> 已分配店铺仍会保留，电脑上线后才能下发登录任务。</span></div>}
    <div className="session-table-scroll"><table className={`session-table session-shop-table ${maintenance ? 'company' : 'finance'}`}>
      <thead><tr><th className="session-platform-col"><button type="button" className="session-sort" onClick={()=>sort('platform')}>平台<ArrowDownUp size={13}/><span className="sr-only">{filters.sort==='platform_desc'?'降序':'升序'}</span></button></th><th className="session-shop-col">店铺</th><th className="session-platform-id">平台店铺ID</th><th className="session-account">{maintenance?'主账号':'提现运营账号'}</th><th className="session-password">{maintenance?'主账号密码':'提现运营密码'}</th><th className="session-auto">自动登录</th>
        {maintenance && <><th className="session-store-status">店铺状态</th><th className="session-store-reason">异常原因</th></>}
        <th className="session-operator"><button type="button" className="session-sort" onClick={()=>sort('operator')}>当前运营<ArrowDownUp size={13}/></button></th><th className="session-login">本机登录态</th><th className="session-device">负责电脑</th><th className="session-opened">最近打开</th><th className="session-progress">进度 / 异常</th><th className="session-actions">操作</th></tr></thead>
      <tbody>{!data ? <tr><td colSpan={maintenance?14:12} className="session-empty">正在加载店铺…</td></tr> : !data.shops.length ? <tr><td colSpan={maintenance?14:12} className="session-empty">尚未添加店铺，请点击右上角“添加店铺”从 OA 店铺档案中选择</td></tr> : data.shops.map(shop=>{
        const active=!!shop.activeRequest, loading=busy.includes(shop.id), state=LOGIN[shop.loginState] ?? LOGIN.none, remote=remoteMap.get(shop.id);
        const loginLabel=shop.requiresAgentUpgrade?'升级助手':shop.deviceStatus==='none'?'分配电脑':shop.deviceStatus==='revoked'?'电脑已撤销':shop.deviceStatus!=='online'?'助手离线':shop.loginState==='valid'?'立即登录':shop.loginState==='expired'?'重新登录':'首次登录';
        return <tr key={shop.id} className={maintenance?`session-store-${shop.storeStatus}`:''}>
          <td><span className="session-platform">{shop.platformLabel || PLATFORM_LABELS[shop.platform] || shop.platform}</span></td>
          <td><button type="button" className="session-shop-link" onClick={()=>setDetail(shop)}>{shop.storeName}</button><small>{shop.storeNo || '未设置店铺编码'}</small></td><td>{shop.platformStoreId || '-'}</td>
          <ShopCredentials client={client} shop={shop} maintenance={maintenance} canManage={manage} onChanged={load} onError={setError}/>
          {maintenance && <ShopStatusCells client={client} shop={shop} reasons={reasons} canManage={manage} onChanged={load} onError={setError}/>}
          <td title={shop.operatorName}>{shop.operatorName || '-'}</td><td><span className={`session-badge ${state[1]}`}>{state[0]}</span></td>
          <td>{manage ? <InlineDevice client={client} shop={shop} devices={devices} onChanged={load} onError={setError}/> : shop.deviceName || '未分配'}</td>
          <td>{shop.lastOpenedAt?fmtTime(shop.lastOpenedAt):'-'}</td>
          <td>{shop.request && active ? <><div className="session-progress-label"><span>{shop.request.step}</span><b>{shop.request.percent}%</b></div><progress aria-label={`${shop.storeName}登录进度`} max={100} value={shop.request.percent}/></> : <span className={shop.request?.errorText?'session-error-text':'session-muted'} title={shop.request?.errorText ?? undefined}>{shop.request?.errorText || shop.request?.step || '正常'}</span>}</td>
          <td className="session-actions"><div className="session-row-actions">
            {manage && (active ? <button type="button" className="session-secondary" disabled={loading} onClick={()=>{if(window.confirm(`停止「${shop.storeName}」当前打开任务？本机登录态和电脑授权会保留。`))void run(shop.id,()=>client.cancel(shop.activeRequest!.id));}}>停止任务</button> : <button type="button" className={shop.loginState==='valid'?'session-primary':'session-first'} disabled={loading || shop.deviceStatus!=='online' || shop.requiresAgentUpgrade} title={shop.requiresAgentUpgrade?'请在授权电脑页将负责电脑升级到 Windows 助手 1.1.1 或以上版本':undefined} onClick={()=>void run(shop.id,()=>client.open(shop.id))}>{loginLabel}</button>)}
            {canRemote && remote?.remoteEnabled && <button type="button" className="session-secondary" disabled={!remote.deviceOnline || (!!remote.live && !remote.live.mine)} title={remote.live && !remote.live.mine?`${remote.live.requestedByName} 正在协助`:'协助授权电脑上的店铺窗口'} onClick={()=>setRemoteFor(shop)}>{remote.live?.mine?'返回协助':'远程协助'}</button>}
            {manage && <button type="button" className="session-danger" disabled={active || loading} onClick={()=>{if(window.confirm(`移除「${shop.storeName}」？只从当前清单移除，店铺档案、本机登录态和历史记录保留。`))void run(shop.id,()=>client.removeShop(shop.id));}}>移除</button>}
          </div></td>
        </tr>;
      })}</tbody>
    </table></div>
    <footer className="session-pagination"><span>第 {data?.page ?? 1} / {data?.pageCount ?? 1} 页 · 共 {data?.total ?? 0} 家</span><label>每页 <input type="number" min={10} max={200} aria-label="每页条数" value={pageSize} onChange={e=>setPageSize(e.target.value)} onBlur={applyPageSize} onKeyDown={e=>{if(e.key==='Enter')applyPageSize();}}/> 条</label><button type="button" disabled={filters.page<=1} onClick={()=>filter({page:filters.page-1})}>上一页</button><button type="button" disabled={!data || filters.page>=data.pageCount} onClick={()=>filter({page:filters.page+1})}>下一页</button></footer>
    {adding && <AddSessionShops client={client} devices={devices.filter(d=>d.status==='active')} maintenance={maintenance} onClose={()=>setAdding(false)} onDone={()=>{setAdding(false);load();}}/>}
    {detail && <ShopDrawer maintenance={maintenance} client={client} shop={data?.shops.find(s=>s.id===detail.id) ?? detail} canManage={manage} onClose={()=>setDetail(null)} onChanged={load} actions={!maintenance && can('finance.docs.create') ? <button type="button" className="session-primary" onClick={()=>{setRegister(detail);setDetail(null);}}>登记提现</button> : undefined}/>}
    {register && <DocForm type="withdrawal" preset={{storeId:register.storeId,storeName:register.storeName}} onClose={()=>setRegister(null)} onSaved={()=>setRegister(null)}/>}
    {remoteFor && remoteMap.get(remoteFor.id) && <RemoteAssistDialog client={remoteClient} shopId={remoteFor.id} storeName={remoteFor.storeName} deviceName={remoteFor.deviceName} state={remoteMap.get(remoteFor.id)!} onClose={()=>{setRemoteFor(null);load();}}/>}
  </section>;
}
