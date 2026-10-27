import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { fmtTime } from '../flow/flowApi';
import { Pager } from './common';
import { CopyButton } from './fin-ui';
import { DocumentsPage } from './DocumentsPage';
import { DocForm } from './DocForm';
import { InlineCred, InlineDevice, ShopDrawer } from './ShopInline';
import { AgentReleasePanel } from './AgentReleasePanel';
import { RemoteAssistDialog } from './remote/RemoteAssistDialog';
import { RemoteDeviceSettings, RemoteHistory } from './remote/RemotePanels';
import { remoteApi, type RemoteShopState } from './remote/remoteApi';
import { sessionApi, type AuditRow, type DeviceRow, type HistoryRow, type SessionClient, type ShopList, type ShopRow } from './sessionApi';

const STATE: Record<string, [string, string]> = { none: ['未登录', ''], valid: ['登录有效', 'ok'], expired: ['已过期', 'warn'], error: ['异常', 'bad'] };
const DEVICE: Record<string, string> = { online: '在线', offline: '助手离线', revoked: '已撤销', none: '未分配' };
const REQ: Record<string, string> = { pending: '等待助手领取', claimed: '助手处理中', succeeded: '成功', failed: '失败', cancelled: '已取消', expired: '超时未领取' };
const PLATFORM: Record<string, string> = { pdd: '拼多多', taobao: '淘宝', tmall: '天猫', douyin: '抖音', jd: '京东', kuaishou: '快手', xhs: '小红书', other: '其他' };

/**
 * 店铺提现：在授权电脑上的助手里登录店铺，到平台后台提现；每提现一笔，在这里“登记提现”填一笔（提现单）。
 * 登录态只在授权电脑本机；这里管理店铺登录账号、授权电脑、登录请求和操作日志。
 */
export function StoreWithdrawalPage() {
  const [tab, setTab] = useState<'shops' | 'records' | 'devices' | 'audit'>('shops');
  return (
    <div>
      <div className="page-head"><h1>店铺提现</h1></div>
      <p className="muted">流程：点“登录”让授权电脑上的助手打开店铺后台 → 在平台上提现 → 回到这里点“登记提现”，填平台提现流水号和到账银行账户，一笔提现登记一笔。</p>
      <div className="tabs">
        {([['shops', '店铺登录'], ['records', '提现记录'], ['devices', '授权电脑'], ['audit', '操作日志']] as const).map(([k, l]) => <button key={k} type="button" className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'shops' && <Shops />}
      {tab === 'records' && <DocumentsPage scope="withdrawal" embedded />}
      {tab === 'devices' && <Devices />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

/** 最近一次登录请求的进度条：进行中显示百分比和阶段，结束了显示结果（失败带原因） */
function Progress({ shop }: { shop: ShopRow }) {
  const r = shop.request;
  if (!r) return <span className="muted">-</span>;
  const running = r.status === 'pending' || r.status === 'claimed';
  if (running) return <div title={r.step}><div className="between"><span>{r.step}</span><b>{r.percent}%</b></div><progress max={100} value={r.percent} aria-label="登录进度" style={{ width: '100%' }} /></div>;
  return <span className={`pill ${r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn'}`} title={r.errorText ?? undefined}>{r.step}</span>;
}

const STORE_STATUS: Record<string, string> = { normal: '正常', abnormal: '异常', cancelled: '注销', inactive: '停用' };

export function Shops({ client = sessionApi, maintenance = false }: { client?: SessionClient; maintenance?: boolean }) {
  const { can } = useAuth();
  const [data, setData] = useState<ShopList | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [f, setF] = useState({ keyword: '', loginState: '', storeStatus: '', deviceId: '', sort: 'default', page: 1, pageSize: 50 });
  const [kw, setKw] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [register, setRegister] = useState<ShopRow | null>(null);
  const [hist, setHist] = useState<{ shop: ShopRow; rows: HistoryRow[] } | null>(null);
  const [detail, setDetail] = useState<ShopRow | null>(null);
  const [statusFor, setStatusFor] = useState<ShopRow | null>(null);
  const [remoteFor, setRemoteFor] = useState<ShopRow | null>(null);
  const [remoteMap, setRemoteMap] = useState<Map<number, RemoteShopState>>(new Map());
  const canRemote = !maintenance && can('finance.session.remote');
  useEffect(() => { // 远程协助：每家店铺的电脑是否开启、有没有人正在协助
    if (!canRemote) return;
    const go = () => remoteApi.shops().then((r) => setRemoteMap(new Map(r.shops.map((x) => [x.shopId, x])))).catch(() => undefined);
    go(); const t = setInterval(go, 8000); return () => clearInterval(t);
  }, [canRemote]);
  const load = useCallback(() => { client.overview(f).then((d) => { setData(d); if (d.page !== f.page) setF((x) => ({ ...x, page: d.page })); }).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); client.devices().then(setDevices).catch(() => undefined); }, [client, f]);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setTimeout(() => setF((x) => (x.keyword === kw ? x : { ...x, keyword: kw, page: 1 })), 300); return () => clearTimeout(t); }, [kw]);
  const setFilter = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch, page: patch.page ?? 1 }));
  const toggleSort = (col: 'platform' | 'operator') => setFilter({ sort: f.sort === `${col}_asc` ? `${col}_desc` : `${col}_asc` });
  const arrow = (col: string) => (f.sort === `${col}_asc` ? ' ▲' : f.sort === `${col}_desc` ? ' ▼' : '');
  const run = (fn: () => Promise<unknown>) => { setError(''); fn().then(load).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败')); };
  const manage = data?.canManage;

  return (
    <div>
      <div className="toolbar">
        <input className="search-box" type="search" aria-label="搜索店铺" placeholder="搜索平台、运营、店铺名称、编码或平台店铺ID" value={kw} onChange={(e) => setKw(e.target.value)} />
        {maintenance && <select aria-label="店铺状态" value={f.storeStatus} onChange={(e) => setFilter({ storeStatus: e.target.value })}><option value="">店铺状态：全部</option>{Object.entries(STORE_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
        <select aria-label="登录状态" value={f.loginState} onChange={(e) => setFilter({ loginState: e.target.value })}><option value="">登录状态：全部</option>{Object.entries(STATE).map(([k, l]) => <option key={k} value={k}>{l[0]}</option>)}</select>
        <select aria-label="负责电脑" value={f.deviceId} onChange={(e) => setFilter({ deviceId: e.target.value })}><option value="">负责电脑：全部</option><option value="none">未分配电脑</option>{devices.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.status === 'active' ? (d.online ? '在线' : '离线') : '已撤销'}</option>)}</select>
        <span className="muted">已加入 {data?.total ?? 0} 家店铺</span>
        {manage && <button type="button" className="primary-button" onClick={() => setAdding(true)}>添加店铺</button>}<button type="button" className="secondary-button" onClick={load}>刷新</button>
      </div>
      {devices.length > 0 && <p className="muted" role="status">{devices.filter((d) => d.status === 'active' && d.online).length} 台在线 / {devices.filter((d) => d.status === 'active').length} 台授权：店铺任务会发到各自负责的电脑。</p>}
      {devices.length === 0 && data && <p className="muted" role="status">还没有授权电脑：先到“授权电脑”生成绑定码，在助手里输入后再添加店铺。</p>}
      {devices.length > 0 && !devices.some((d) => d.online) && <div className="notice warn">暂无在线授权电脑：已分配的店铺仍会保留，电脑上的助手上线后才能下发登录任务。</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th><button type="button" className="link-button" onClick={() => toggleSort('platform')}>平台{arrow('platform')}</button></th><th>店铺</th><th>平台店铺ID</th>{maintenance && <th>店铺状态</th>}<th><button type="button" className="link-button" onClick={() => toggleSort('operator')}>当前运营{arrow('operator')}</button></th><th>登录账号</th><th>登录状态</th><th>负责电脑</th><th>最近打开</th><th>进度</th><th>操作</th></tr></thead>
        <tbody>
          {data?.shops.length === 0 && <tr><td colSpan={maintenance ? 11 : 10} className="empty-state muted">{f.keyword || f.loginState || f.deviceId || f.storeStatus ? '没有符合条件的店铺，试试清除筛选。' : '还没有添加店铺。先到“授权电脑”绑定一台电脑，再点“添加店铺”。'}</td></tr>}
          {data?.shops.map((s) => {
            const busy = !!s.activeRequest;
            return (
              <tr key={s.id}>
                <td>{s.platformLabel ?? PLATFORM[s.platform] ?? s.platform}</td><td><strong>{s.storeName}</strong><div className="muted">{s.storeNo || '未设置店铺编码'}</div></td><td>{s.platformStoreId ? <>{s.platformStoreId} <CopyButton text={s.platformStoreId} label="店铺ID" /></> : '-'}</td>{maintenance && <td><span className={`pill ${s.storeStatus === 'normal' ? 'ok' : s.storeStatus === 'abnormal' ? 'warn' : 'bad'}`}>{STORE_STATUS[s.storeStatus ?? ''] ?? s.storeStatus}</span>{s.abnormalReason && <div className="muted">{s.abnormalReason}</div>}</td>}
                <td>{s.operatorName || '-'}</td>
                <td>{manage ? <InlineCred client={client} shop={s} onChanged={load} onError={setError} /> : <>{s.loginAccount ? <>{s.loginAccount} <CopyButton text={s.loginAccount} label={`登录账号 ${s.loginAccount}`} /></> : <span className="muted">未填</span>}{s.hasPassword && <span className="muted"> · 已存密码{s.autoLogin ? ' · 自动登录' : ''}</span>}</>}</td>
                <td><span className={`pill ${STATE[s.loginState][1]}`}>{STATE[s.loginState][0]}</span>{s.activeRequest && <div className="muted">{REQ[s.activeRequest.status]}</div>}</td>
                <td>{manage ? <InlineDevice client={client} shop={s} devices={devices.filter((d) => d.status === 'active')} onChanged={load} onError={setError} /> : s.deviceName || '—'} <span className={`pill ${s.deviceStatus === 'online' ? 'ok' : 'warn'}`}>{DEVICE[s.deviceStatus]}</span></td>
                <td>{s.lastOpenedAt ? fmtTime(s.lastOpenedAt) : '-'}</td>
                <td><Progress shop={s} /></td>
                <td className="row-actions">
                  {manage && (busy
                    ? <button type="button" className="link-button" onClick={() => { if (window.confirm(`停止「${s.storeName}」当前的登录任务吗？\n停止后可以重新登录，不会删除本机登录态或电脑授权。`)) run(() => client.cancel(s.activeRequest!.id)); }}>取消登录</button>
                    : <button type="button" className="link-button" disabled={s.deviceStatus !== 'online'} onClick={() => run(() => client.open(s.id))}>{s.loginState === 'valid' ? '立即登录' : s.loginState === 'none' ? '首次登录' : '重新登录'}</button>)}
                  {!maintenance && can('finance.docs.create') && <button type="button" className="link-button" onClick={() => setRegister(s)}>登记提现</button>}
                  {canRemote && remoteMap.get(s.id)?.remoteEnabled && (() => { const r = remoteMap.get(s.id)!; return <button type="button" className="link-button" disabled={!r.deviceOnline || (!!r.live && !r.live.mine)} title={r.live && !r.live.mine ? `${r.live.requestedByName} 正在协助` : '让这台电脑上的助手把店铺窗口画面传给你'} onClick={() => setRemoteFor(s)}>{r.live?.mine ? '返回协助' : '远程协助'}</button>; })()}
                  <button type="button" className="link-button" onClick={() => client.history(s.id).then((rows) => setHist({ shop: s, rows })).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'))}>登录记录</button>
                  {maintenance && manage && <button type="button" className="link-button" onClick={() => setStatusFor(s)}>改店铺状态</button>}
                  <button type="button" className="link-button" onClick={() => setDetail(s)}>店铺详情</button>
                  {manage && <button type="button" className="link-button" disabled={busy} onClick={() => { if (window.confirm(`移除店铺「${s.storeName}」？历史记录会保留。`)) run(() => client.removeShop(s.id)); }}>移除</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      {data && <div className="row-actions"><Pager page={data.page} total={data.total} pageSize={data.pageSize} onPage={(p) => setFilter({ page: p })} />
        <label className="check-line">每页<select aria-label="每页条数" value={f.pageSize} onChange={(e) => setFilter({ pageSize: Number(e.target.value) })}>{[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}</select>家</label></div>}
      {adding && <AddShops client={client} maintenance={maintenance} devices={devices.filter((d) => d.status === 'active')} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {register && <DocForm type="withdrawal" preset={{ storeId: register.storeId, storeName: register.storeName }} onClose={() => setRegister(null)} onSaved={() => { setRegister(null); }} />}
      {hist && (
        <div className="modal-backdrop" role="presentation"><div className="modal card" role="dialog" aria-label="登录记录">
          <div className="modal-head between"><strong>{hist.shop.storeName} · 登录记录</strong><button type="button" className="icon-button" aria-label="关闭" onClick={() => setHist(null)}>✕</button></div>
          <div className="modal-body"><table className="data-table"><thead><tr><th>时间</th><th>类型</th><th>结果</th><th>电脑</th><th>发起人</th><th>说明</th></tr></thead><tbody>
            {hist.rows.length === 0 && <tr><td colSpan={6} className="muted">还没有记录</td></tr>}
            {hist.rows.map((r) => <tr key={r.id}><td>{fmtTime(r.createdAt)}</td><td>{r.kind === 'first' ? '首次/重新登录' : '立即登录'}</td><td>{REQ[r.status]}</td><td>{r.deviceName}</td><td>{r.requestedByName}</td><td>{r.errorText ?? ''}</td></tr>)}
          </tbody></table></div>
        </div></div>
      )}
      {remoteFor && remoteMap.get(remoteFor.id) && <RemoteAssistDialog shopId={remoteFor.id} storeName={remoteFor.storeName} deviceName={remoteFor.deviceName} state={remoteMap.get(remoteFor.id)!} onClose={() => { setRemoteFor(null); load(); }} />}
      {statusFor && <StoreStatusDialog client={client} shop={statusFor} onClose={() => setStatusFor(null)} onDone={() => { setStatusFor(null); load(); }} />}
      {detail && <ShopDrawer client={client} shop={data?.shops.find((x) => x.id === detail.id) ?? detail} canManage={!!manage} onClose={() => setDetail(null)} onChanged={load} />}
    </div>
  );
}

function StoreStatusDialog({ client, shop, onClose, onDone }: { client: SessionClient; shop: ShopRow; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState(shop.storeStatus ?? 'normal');
  const [reasonId, setReasonId] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [reasons, setReasons] = useState<Array<{ id: number; reason: string }>>([]);
  const [error, setError] = useState('');
  useEffect(() => { client.abnormalReasons().then(setReasons).catch(() => undefined); }, [client]);
  const needNote = status === 'cancelled' || status === 'inactive';
  return (
    <div className="modal-backdrop" role="presentation"><form className="modal card small" role="dialog" aria-label="改店铺状态" onSubmit={(e) => {
      e.preventDefault(); setError('');
      client.setStoreStatus(shop.id, { status, ...(status === 'abnormal' ? { abnormalReasonId: Number(reasonId) } : {}), ...(needNote ? { reason: note } : {}) }).then(onDone).catch((er) => setError(er instanceof ApiError ? er.message : '保存失败'));
    }}>
      <div className="modal-head"><strong>{shop.storeName} · 店铺档案状态</strong></div>
      <div className="modal-body">
        <label>状态<select value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(STORE_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {status === 'abnormal' && <label>异常原因 *<select value={reasonId} onChange={(e) => setReasonId(e.target.value ? Number(e.target.value) : '')}><option value="">（选择店铺档案里已有的异常原因）</option>{reasons.map((r) => <option key={r.id} value={r.id}>{r.reason}</option>)}</select></label>}
        {status === 'abnormal' && reasons.length === 0 && <p className="muted">异常原因库还是空的，请先到「店铺档案」页的“异常原因库”里添加。</p>}
        {needNote && <label>原因 *<input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>}
        {error && <div role="alert" className="notice error">{error}</div>}
      </div>
      <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={status === 'abnormal' && !reasonId}>保存</button></div>
    </form></div>
  );
}

function AddShops({ client, maintenance, devices, onClose, onDone }: { client: SessionClient; maintenance: boolean; devices: DeviceRow[]; onClose: () => void; onDone: () => void }) {
  const [kw, setKw] = useState('');
  const [list, setList] = useState<Array<{ id: number; name: string; platform: string }>>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [dev, setDev] = useState<number | ''>('');
  const [error, setError] = useState('');
  useEffect(() => { client.available(kw).then(setList).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, [kw]);
  return (
    <div className="modal-backdrop" role="presentation"><div className="modal card" role="dialog" aria-label="添加店铺">
      <div className="modal-head"><strong>添加店铺</strong></div>
      <div className="modal-body">
        <p className="muted">{maintenance ? '可以添加任何状态、还没在维护清单里的店铺档案。' : '只能添加状态“正常”、还没在列表里的店铺档案。'}</p>
        <label>负责电脑 *<select value={dev} onChange={(e) => setDev(e.target.value ? Number(e.target.value) : '')}><option value="">（选择电脑）</option>{devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.online ? '' : '（离线）'}</option>)}</select></label>
        <input placeholder="搜索店铺名" value={kw} onChange={(e) => setKw(e.target.value)} />
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {list.map((s) => <label key={s.id} className="check-line"><input type="checkbox" checked={sel.includes(s.id)} onChange={(e) => setSel(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id))} />{s.name} <span className="muted">{PLATFORM[s.platform] ?? s.platform}</span></label>)}
          {list.length === 0 && <p className="muted">没有可添加的店铺</p>}
        </div>
        {error && <div role="alert" className="notice error">{error}</div>}
      </div>
      <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>取消</button>
        <button type="button" className="primary-button" disabled={!sel.length || !dev} onClick={() => client.addShops(sel, Number(dev)).then(onDone).catch((e) => setError(e instanceof ApiError ? e.message : '添加失败'))}>添加 {sel.length || ''} 家</button></div>
    </div></div>
  );
}

function Devices() {
  const { can } = useAuth();
  const UPDATE_STEP: Record<string, string> = { downloading: '正在下载', verifying: '正在校验', staged: '已解包', applying: '正在切换版本', restarting: '正在重启' };
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { sessionApi.devices().then(setRows).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, []);
  useEffect(() => { load(); }, [load]);
  const run = (fn: () => Promise<unknown>) => fn().then(load).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败'));
  return (
    <div>
      <p className="muted">授权电脑是装了“店铺登录助手”的 Windows 电脑。点“生成绑定码”，在助手里输入（10 分钟内有效，只能用一次）。登录态只保存在这台电脑上。</p>
      <div className="toolbar"><button type="button" className="primary-button" onClick={() => sessionApi.bindCode().then(setCode).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败'))}>生成绑定码</button>
        <button type="button" className="secondary-button" disabled={!rows.some((d) => d.outdated)} title={rows[0]?.latestVersion ? `最新版 ${rows[0].latestVersion}` : '暂未发布新版助手'} onClick={() => { if (window.confirm('给所有版本落后的电脑安排升级？助手下次连上服务器时领取。')) run(() => sessionApi.updateAllDevices()); }}>全部升级</button>
        {rows[0]?.latestVersion ? <span className="muted">助手最新版 v{rows[0].latestVersion}</span> : <span className="muted">暂未发布新版助手</span>}</div>
      {can('finance.session.manage') && <AgentReleasePanel onChange={load} />}
      {code && <div role="status" className="notice ok">绑定码：<b className="mono" style={{ fontSize: 20 }}>{code.code}</b>（{fmtTime(code.expiresAt)} 前有效，关闭后不再显示）</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>电脑</th><th>设备编号</th><th>系统</th><th>助手版本</th><th>店铺数</th><th>最近心跳</th><th>状态</th><th /></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} className="empty-state muted">还没有授权电脑</td></tr>}
          {rows.map((d) => (
            <tr key={d.id}><td><strong>{d.name}</strong></td><td className="mono">{d.deviceNo}</td><td>{d.os}</td><td>{d.agentVersion}{d.outdated && <span className="pill warn" title="版本落后于最新版"> 可升级</span>}{d.update?.status === 'queued' && <div className="muted">已安排升级到 v{d.update.target}，等待助手领取</div>}{d.update && UPDATE_STEP[d.update.status] && <div className="muted">升级到 v{d.update.target}：{UPDATE_STEP[d.update.status]}</div>}{d.update?.status === 'failed' && <div className="pill bad" title={d.update.error ?? ''}>升级失败：{d.update.error}</div>}{d.update?.status === 'rolled_back' && <div className="pill warn" title={d.update.error ?? ''}>已回退：{d.update.error}</div>}{d.update?.status === 'succeeded' && !d.outdated && <div className="muted">已升级到 v{d.update.target}</div>}</td><td>{d.shopCount}</td><td>{fmtTime(d.lastSeenAt)}</td>
              <td><span className={`pill ${d.status === 'revoked' ? 'bad' : d.online ? 'ok' : 'warn'}`}>{d.status === 'revoked' ? '已撤销' : d.online ? '在线' : '离线'}</span></td>
              <td className="row-actions">
                <button type="button" className="link-button" onClick={() => { const n = window.prompt('电脑名称', d.name); if (n) run(() => sessionApi.rename(d.id, n)); }}>改名</button>
                {d.status === 'active' && <button type="button" className="link-button" disabled={!d.outdated || (!!d.update && ['queued', 'downloading', 'verifying', 'staged', 'applying', 'restarting'].includes(d.update.status))} onClick={() => run(() => sessionApi.updateDevice(d.id))}>升级</button>}
                {d.status === 'revoked' && <button type="button" className="link-button" onClick={() => { if (window.confirm(`删除电脑「${d.name}」的记录？只是从列表里隐藏，不会删除这台电脑上的店铺 Profile 或历史日志；以后要用需要重新绑定。`)) run(() => sessionApi.deleteDevice(d.id)); }}>删除记录</button>}
                <button type="button" className="link-button" onClick={() => { if (d.status === 'revoked' || window.confirm(`撤销「${d.name}」？它的令牌立即失效，进行中的登录请求会取消。`)) run(() => sessionApi.setStatus(d.id, d.status === 'revoked' ? 'active' : 'revoked')); }}>{d.status === 'revoked' ? '恢复授权' : '撤销'}</button>
              </td></tr>
          ))}
        </tbody>
      </table></div>
      <RemoteDeviceSettings deviceNames={Object.fromEntries(rows.map((d) => [d.id, d.name]))} />
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  useEffect(() => { sessionApi.audit().then(setRows).catch(() => undefined); }, []);
  return (
    <>
    <div className="table-scroll"><table className="data-table">
      <thead><tr><th>时间</th><th>操作人</th><th>电脑</th><th>内容</th></tr></thead>
      <tbody>{rows.length === 0 && <tr><td colSpan={4} className="muted">还没有记录</td></tr>}{rows.map((r) => <tr key={r.id}><td>{fmtTime(r.createdAt)}</td><td>{r.actorName ?? '助手'}</td><td>{r.deviceName ?? ''}</td><td>{r.summary}</td></tr>)}</tbody>
    </table></div>
    <RemoteHistory />
    </>
  );
}
