import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { fmtTime } from '../../flow/flowApi';
import { REMOTE_MODE_LABEL } from '@kudesi/shared';
import { remoteApi, type RemoteApi, type RemoteDevicesInfo, type RemoteHistoryRow } from './remoteApi';

const dur = (s: number) => (s <= 0 ? '-' : s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`);

/** 授权电脑页：每台电脑的远程协助开关（默认关闭）和“紧急停止”。需要 finance.session.manage 才能改。 */
export function RemoteDeviceSettings({ client = remoteApi, deviceNames, managePermission = 'finance.session.manage' }: { client?: RemoteApi; deviceNames: Record<number, string>; managePermission?: string }) {
  const { can } = useAuth();
  const [info, setInfo] = useState<RemoteDevicesInfo | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const load = useCallback(() => { client.devices().then(setInfo).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, [client]);
  useEffect(load, [load]);
  if (!info) return error ? <div role="alert" className="notice error">{error}</div> : null;
  const manage = can(managePermission) && info.canManage;
  const run = (fn: () => Promise<unknown>, msg = '') => { setError(''); setDone(''); fn().then(() => { setDone(msg); load(); }).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败')); };
  return (
    <section aria-label="远程协助设置" style={{ marginTop: 20 }}>
      <h3>远程协助</h3>
      <p className="muted">默认全部关闭。开启后，有“远程协助”权限的人可以向这台电脑发起申请，还需要电脑上的助手（电脑主人）同意；画面点对点传输，每次的申请人、事由、时长都会记入日志。</p>
      {info.globalDisabled && <div className="notice warn">管理员已在服务器上关闭远程协助（KUDESI_REMOTE_ASSIST_DISABLED），下面的开关暂时无效。</div>}
      {!info.iceConfigured && <div className="notice warn">服务器还没有配置 STUN/TURN（WEBRTC_STUN_URLS、WEBRTC_TURN_URLS、WEBRTC_TURN_SHARED_SECRET）：只有网页和电脑在同一个内网时才连得上。</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      {done && <div role="status" className="notice ok">{done}</div>}
      <div className="table-scroll"><table className="data-table">
        <thead><tr><th>电脑</th><th>远程协助</th><th>允许操作</th><th>单次最长</th><th /></tr></thead>
        <tbody>
          {info.devices.length === 0 && <tr><td colSpan={5} className="muted">还没有授权电脑</td></tr>}
          {info.devices.map((d) => (
            <tr key={d.deviceId}>
              <td>{deviceNames[d.deviceId] ?? `#${d.deviceId}`}</td>
              <td><span className={`pill ${d.enabled ? 'ok' : ''}`}>{d.enabled ? '已开启' : '关闭'}</span></td>
              <td>{d.enabled ? (d.allowControl ? '可操作' : '只观看') : '-'}</td>
              <td>{d.enabled ? `${d.maxMinutes} 分钟` : '-'}</td>
              <td className="row-actions">
                {manage && !d.enabled && <button type="button" className="link-button" onClick={() => run(() => client.setDevice(d.deviceId, { enabled: true, allowControl: false, maxMinutes: d.maxMinutes }), '已开启（只观看）')}>开启（只观看）</button>}
                {manage && !d.enabled && <button type="button" className="link-button" onClick={() => { if (window.confirm('允许远程操作这台电脑上的店铺窗口（点击、输入）？')) run(() => client.setDevice(d.deviceId, { enabled: true, allowControl: true, maxMinutes: d.maxMinutes }), '已开启（可操作）'); }}>开启（可操作）</button>}
                {manage && d.enabled && <button type="button" className="link-button" onClick={() => run(() => client.setDevice(d.deviceId, { enabled: true, allowControl: !d.allowControl, maxMinutes: d.maxMinutes }), d.allowControl ? '已改为只观看' : '已允许操作')}>{d.allowControl ? '改为只观看' : '允许操作'}</button>}
                {manage && d.enabled && <button type="button" className="link-button" onClick={() => { const v = window.prompt(`单次最长多少分钟（${info.limits.minMinutes}~${info.limits.hardCapMinutes}）`, String(d.maxMinutes)); if (v) run(() => client.setDevice(d.deviceId, { enabled: true, allowControl: d.allowControl, maxMinutes: Number(v) }), '已修改时长'); }}>改时长</button>}
                {manage && d.enabled && <button type="button" className="link-button" onClick={() => { if (window.confirm('关闭这台电脑的远程协助？正在进行的协助会立即结束。')) run(() => client.setDevice(d.deviceId, { enabled: false }), '已关闭'); }}>关闭</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {manage && <div className="toolbar"><button type="button" className="secondary-button" onClick={() => { if (window.confirm('紧急停止：立即结束所有进行中的远程协助，并关闭所有电脑的远程协助（之后要逐台重新开启）。确定吗？')) client.stopAll().then((r) => { setDone(`已结束 ${r.ended} 场协助，关闭 ${r.disabledDevices} 台电脑的远程协助`); load(); }).catch((e) => setError(e instanceof ApiError ? e.message : '操作失败')); }}>紧急停止所有远程协助</button></div>}
    </section>
  );
}

/** 操作日志页：远程协助记录（谁、哪家店铺、哪台电脑、事由、起止、时长、结果） */
export function RemoteHistory({ client = remoteApi, managePermission = 'finance.session.manage', remotePermission = 'finance.session.remote' }: { client?: RemoteApi; managePermission?: string; remotePermission?: string }) {
  const { can } = useAuth();
  const allowed = can(remotePermission) || can(managePermission);
  const [rows, setRows] = useState<RemoteHistoryRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { if (allowed) client.history().then(setRows).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败')); }, [client, allowed]);
  if (!allowed || (rows === null && !error)) return null;
  return (
    <section aria-label="远程协助记录" style={{ marginTop: 20 }}>
      <h3>远程协助记录</h3>
      {error ? <div className="muted">{error}</div> : (
        <div className="table-scroll"><table className="data-table">
          <thead><tr><th>申请时间</th><th>申请人</th><th>店铺</th><th>电脑</th><th>模式</th><th>事由</th><th>时长</th><th>操作次数</th><th>结果</th></tr></thead>
          <tbody>
            {rows!.length === 0 && <tr><td colSpan={9} className="muted">还没有远程协助记录</td></tr>}
            {rows!.map((r) => (
              <tr key={r.id}><td>{fmtTime(r.requestedAt)}</td><td>{r.requestedByName}</td><td>{r.storeName}</td><td>{r.deviceName}</td><td>{REMOTE_MODE_LABEL[r.mode]}</td><td>{r.reason}</td><td>{dur(r.durationSeconds)}</td><td>{r.mode === 'control' ? r.inputCount : '-'}</td>
                <td>{r.status === 'ended' ? (r.endReasonLabel ?? '已结束') : r.status === 'active' ? '进行中' : '等待同意'}{r.endedByName && r.endReason === 'ended_by_admin' ? `（${r.endedByName}）` : ''}</td></tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
