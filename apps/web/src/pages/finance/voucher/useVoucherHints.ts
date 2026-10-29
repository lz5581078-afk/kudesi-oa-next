import { useEffect, useState } from 'react';
import { financeApi, type LineHint, type PartyBalance } from '../financeApi';

/** 往来对象当前的应收/应付/预收/预付余额和信用额度（管家婆“往来单位详情”）。取不到不影响开单。 */
export function usePartyBalance(partyKind: string | null, partyId: number | null, refreshKey = 0): PartyBalance | null {
  const [data, setData] = useState<PartyBalance | null>(null);
  useEffect(() => {
    setData(null);
    if (!partyKind || !partyId) return undefined;
    let alive = true;
    Promise.resolve().then(() => financeApi.partyBalance({ partyKind, partyId })).then((r) => { if (alive) setData(r ?? null); }).catch(() => undefined);
    return () => { alive = false; };
  }, [partyKind, partyId, refreshKey]);
  return data;
}

/** 明细行提示：账面库存、最近进价/售价（后者由服务端按成本/价格权限决定给不给） */
export function useLineHints(productIds: number[], warehouseId: number | null): Map<number, LineHint> {
  const [map, setMap] = useState<Map<number, LineHint>>(new Map());
  const key = [...new Set(productIds)].sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!key) { setMap(new Map()); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      Promise.resolve().then(() => financeApi.lineHints(key.split(',').map(Number), warehouseId ?? undefined)).then((r) => { if (alive && Array.isArray(r)) setMap(new Map(r.map((h) => [h.productId, h]))); }).catch(() => undefined);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [key, warehouseId]);
  return map;
}
