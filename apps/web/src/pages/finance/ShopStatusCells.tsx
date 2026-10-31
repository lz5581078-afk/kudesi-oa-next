import { useEffect, useState } from 'react';
import type { SessionClient, ShopRow } from './sessionApi';

export const STORE_STATUSES: Record<string, string> = { normal: '正常', abnormal: '异常', cancelled: '注销', inactive: '停用' };
export function ShopStatusCells({ client, shop, reasons, canManage, onChanged, onError }: { client: SessionClient; shop: ShopRow; reasons: Array<{ id: number; reason: string }>; canManage: boolean; onChanged: () => void; onError: (s: string) => void }) {
  const [status, setStatus] = useState(shop.storeStatus ?? 'normal');
  const [reasonId, setReasonId] = useState(shop.abnormalReasonId ?? 0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setStatus(shop.storeStatus ?? 'normal'); setReasonId(shop.abnormalReasonId ?? 0); }, [shop.storeStatus, shop.abnormalReasonId]);
  const save = async (next: string, id = 0) => {
    let reason: string | undefined;
    if (next === 'inactive' || next === 'cancelled') { const value = window.prompt(`改为${STORE_STATUSES[next]}的原因`); if (!value?.trim()) { setStatus(shop.storeStatus ?? 'normal'); return; } reason = value.trim(); }
    setBusy(true); onError('');
    try { await client.setStoreStatus(shop.id, { status: next, ...(next === 'abnormal' ? { abnormalReasonId: id } : {}), ...(reason ? { reason } : {}) }); onChanged(); }
    catch (e) { setStatus(shop.storeStatus ?? 'normal'); setReasonId(shop.abnormalReasonId ?? 0); onError(e instanceof Error ? e.message : '保存状态失败'); }
    finally { setBusy(false); }
  };
  const knownReason = !!reasonId && !reasons.some(r => r.id === reasonId);
  return <>
    <td className="session-store-status"><select aria-label={`${shop.storeName}店铺状态`} disabled={!canManage || busy} aria-busy={busy} value={status} onChange={e => {
      const next = e.target.value; setStatus(next);
      if (next === 'abnormal') { if (reasonId) void save(next, reasonId); } else void save(next);
    }}>{Object.entries(STORE_STATUSES).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></td>
    <td className="session-store-reason"><select aria-label={`${shop.storeName}异常原因`} disabled={!canManage || busy || status !== 'abnormal'} value={status === 'abnormal' ? reasonId : 0} title={status === 'abnormal' && !reasonId ? '选择异常原因后保存状态' : shop.abnormalReason} onChange={e => { const id = Number(e.target.value); setReasonId(id); if (id) void save('abnormal', id); }}>
      <option value={0}>{status === 'abnormal' ? '请选择异常原因' : '-'}</option>
      {knownReason && <option value={reasonId}>{shop.abnormalReason || '原异常原因'}</option>}
      {reasons.map(r => <option key={r.id} value={r.id}>{r.reason}</option>)}
    </select>{status === 'abnormal' && !reasonId && <small className="session-error-text">选择原因后保存</small>}</td>
  </>;
}
