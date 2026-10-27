import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { fmtTime } from '../flow/flowApi';
import { CopyButton } from './fin-ui';
import type { DeviceRow, HistoryRow, SessionClient, ShopRow } from './sessionApi';

const errText = (e: unknown, d: string) => (e instanceof ApiError ? e.message : d);
const REQ: Record<string, string> = { pending: '等待助手领取', claimed: '助手处理中', succeeded: '成功', failed: '失败', cancelled: '已取消', expired: '超时未领取' };

/** 行内编辑登录账号和密码：失去焦点或回车即保存；密码永远不显示，只能在有权限时点“查看”（服务器记审计） */
export function InlineCred({ client, shop, onChanged, onError }: { client: SessionClient; shop: ShopRow; onChanged: () => void; onError: (m: string) => void }) {
  const [account, setAccount] = useState(shop.loginAccount);
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAccount(shop.loginAccount); }, [shop.loginAccount]);
  const save = (patch: Parameters<SessionClient['updateShop']>[1], after?: () => void) => {
    setBusy(true); onError('');
    client.updateShop(shop.id, patch).then(() => { after?.(); onChanged(); }).catch((e) => onError(errText(e, '保存失败'))).finally(() => setBusy(false));
  };
  const saveAccount = () => { if (account.trim() !== shop.loginAccount) save({ loginAccount: account.trim() }); };
  const savePassword = () => { if (password) save({ loginPassword: password }, () => { setPassword(''); setShown(null); }); };
  const enter = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } };
  return (
    <div className="inline-cred">
      <div className="inline-cred-row">
        <input aria-label={`${shop.storeName} 登录账号`} value={account} maxLength={100} disabled={busy} placeholder="登录账号" onChange={(e) => setAccount(e.target.value)} onBlur={saveAccount} onKeyDown={enter(saveAccount)} />
        {shop.loginAccount && <CopyButton text={shop.loginAccount} label={`登录账号 ${shop.loginAccount}`} />}
      </div>
      <div className="inline-cred-row">
        <input aria-label={`${shop.storeName} 登录密码`} type="password" autoComplete="new-password" value={password} disabled={busy} placeholder={shop.hasPassword ? '已保存（输入新密码可替换）' : '登录密码'} onChange={(e) => setPassword(e.target.value)} onBlur={savePassword} onKeyDown={enter(savePassword)} />
        {shop.hasPassword && (shown === null
          ? <button type="button" className="link-button" onClick={() => client.reveal(shop.id).then((r) => setShown(r.password)).catch((e) => onError(errText(e, '无权查看或操作失败')))}>查看</button>
          : <><b className="mono">{shown}</b><CopyButton text={shown} label="密码" /><button type="button" className="link-button" onClick={() => setShown(null)}>隐藏</button></>)}
      </div>
      {shop.hasPassword && <label className="check-line"><input type="checkbox" checked={shop.autoLogin} disabled={busy} onChange={(e) => save({ autoLogin: e.target.checked })} />自动登录</label>}
    </div>
  );
}

/** 行内换负责电脑（换了之后任务发往新电脑，先确认） */
export function InlineDevice({ client, shop, devices, onChanged, onError }: { client: SessionClient; shop: ShopRow; devices: DeviceRow[]; onChanged: () => void; onError: (m: string) => void }) {
  return (
    <select aria-label={`${shop.storeName} 负责电脑`} value={shop.deviceId ?? ''} onChange={(e) => {
      const v = e.target.value ? Number(e.target.value) : null;
      const name = devices.find((d) => d.id === v)?.name ?? '未分配';
      if (!window.confirm(`把「${shop.storeName}」的负责电脑改为「${name}」？\n之后的登录任务会发到新电脑，本机登录态不会迁移。`)) return;
      client.updateShop(shop.id, { deviceId: v }).then(onChanged).catch((er) => onError(errText(er, '保存失败')));
    }}>
      <option value="">（未分配）</option>
      {devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.online ? '' : '（离线）'}</option>)}
      {shop.deviceId && !devices.some((d) => d.id === shop.deviceId) && <option value={shop.deviceId}>{shop.deviceName}</option>}
    </select>
  );
}

/** 店铺详情抽屉：基本信息、账号状态、电脑绑定、最近的登录记录，以及清除密码 */
export function ShopDrawer({ client, shop, canManage, onClose, onChanged }: { client: SessionClient; shop: ShopRow; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [shownRows, setShownRows] = useState(10);
  const [error, setError] = useState('');
  useEffect(() => { client.history(shop.id).then(setRows).catch((e) => setError(errText(e, '记录加载失败'))); }, [client, shop.id]);
  const info: [string, React.ReactNode][] = [
    ['店铺编码', shop.storeNo || '未设置'], ['平台店铺ID', shop.platformStoreId || '-'], ['当前运营', shop.operatorName || '-'],
    ['登录账号', shop.loginAccount || '未填'], ['已存密码', shop.hasPassword ? `已保存${shop.autoLogin ? '，自动登录' : '，手动登录'}` : '未保存'],
    ['负责电脑', shop.deviceName || '未分配'], ['最近打开', shop.lastOpenedAt ? fmtTime(shop.lastOpenedAt) : '-'], ['最近验证', shop.lastVerifiedAt ? fmtTime(shop.lastVerifiedAt) : '-'],
  ];
  return (
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <aside className="drawer card" role="dialog" aria-label={`${shop.storeName} 店铺详情`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head between"><strong>{shop.storeName} · 店铺详情</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <dl className="kv-list">{info.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          {canManage && shop.hasPassword && <button type="button" className="link-button" onClick={() => { if (window.confirm('清除已保存的密码？自动登录会同时关闭。')) client.updateShop(shop.id, { clearPassword: true }).then(onChanged).catch((e) => setError(errText(e, '操作失败'))); }}>清除已保存的密码</button>}
          {error && <div role="alert" className="notice error">{error}</div>}
          <h3 className="section-title">登录记录</h3>
          {rows === null ? <p className="muted">加载中…</p> : rows.length === 0 ? <p className="muted">还没有记录</p> : (
            <>
              <table className="data-table"><thead><tr><th>时间</th><th>类型</th><th>结果</th><th>电脑</th><th>发起人</th><th>说明</th></tr></thead><tbody>
                {rows.slice(0, shownRows).map((r) => <tr key={r.id}><td>{fmtTime(r.createdAt)}</td><td>{r.kind === 'first' ? '首次/重新登录' : '立即登录'}</td><td>{REQ[r.status]}</td><td>{r.deviceName}</td><td>{r.requestedByName}</td><td>{r.errorText ?? ''}</td></tr>)}
              </tbody></table>
              {rows.length > shownRows && <button type="button" className="secondary-button small" onClick={() => setShownRows((n) => n + 20)}>加载更多（还有 {rows.length - shownRows} 条）</button>}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
