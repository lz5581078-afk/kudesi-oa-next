import { useEffect, useState, type ReactNode } from 'react';
import { createChecker, sumUnitCents, LOGISTICS_CENT_SCALE } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { resourceApi, type ResourceDto } from './api';
const price = (value: unknown): number | null => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export const purchaseRecordedAt = (row: ResourceDto) => String(row.data.recordedAtKey || row.createdAt);
export function purchasePriceStats(rows: ResourceDto[], now = Date.now()) {
  const ordered = rows.filter(row => price(row.data.purchasePrice) !== null).sort((a, b) => purchaseRecordedAt(b).localeCompare(purchaseRecordedAt(a)) || b.id - a.id);
  const recent = ordered.filter(row => { const time = Date.parse(purchaseRecordedAt(row)); return Number.isFinite(time) && time >= now - 90 * 86400000; });
  return { rows: ordered, last: ordered[0] ? Number(ordered[0].data.purchasePrice) : null, average: recent.length ? sumUnitCents(recent.map(row => Number(row.data.purchasePrice)),LOGISTICS_CENT_SCALE) / recent.length : null };
}
export function useProductPurchaseHistory(record: ResourceDto | null, enabled = true) {
  const { user } = useAuth();
  const allowed = enabled && !!user && createChecker(user.permissions)('product.cost.view') && !record?.warehouseMode;
  const key = JSON.stringify([user?.companyId, user?.id, user?.permissions, record?.id, record?.updatedAt, allowed]);
  const [retry, setRetry] = useState(0), [state, setState] = useState<{ key: string; rows: ResourceDto[] | null; error: string }>({ key: '', rows: null, error: '' });
  useEffect(() => {
    if (!allowed || !record) return;
    let alive = true; setState({ key, rows: null, error: '' });
    (async () => {
      const rows: ResourceDto[] = [], seen = new Set<number>();
      let total: number | null = null;
      for (let page = 1; alive; page++) {
        const result = await resourceApi.list('finance-product-purchase-history', { fieldKey: 'productId', fieldValue: record.id, page, pageSize: 200 });
        if (!alive) return;
        if (!Number.isSafeInteger(result.total) || result.total < 0 || !Array.isArray(result.items)) throw new Error('采购价历史读取不完整，请重试');
        if (total !== null && result.total !== total) throw new Error('采购价历史已变化，请重新读取');
        total = result.total;
        for (const row of result.items) {
          if (!Number.isSafeInteger(row.id) || row.id <= 0 || seen.has(row.id)) throw new Error('采购价历史读取不完整，请重试');
          seen.add(row.id); rows.push(row);
        }
        if (seen.size > total || !result.items.length && seen.size < total) throw new Error('采购价历史读取不完整，请重试');
        if (seen.size === total) break;
      }
      if (alive) setState({ key, rows, error: '' });
    })().catch(error => { if (alive) setState({ key, rows: null, error: error instanceof Error ? error.message : '采购价历史读取失败' }); });
    return () => { alive = false; };
  }, [key, retry]);
  return { ...(allowed && !record ? {rows:[],error:''} : allowed && state.key === key ? state : { rows: null, error: '' }), retry: () => setRetry(value => value + 1) };
}
const yuan = (value: number) => { const [whole, fraction = ''] = (value/100).toFixed(8).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').split('.'); return '¥' + whole + '.' + fraction.padEnd(3, '0'); };
export function PurchasePriceHistory({ record, total = false, priceField,productForm=false }: { productForm?:boolean;record: ResourceDto | null; total?: boolean; priceField?: ReactNode }) {
  const { rows, error, retry } = useProductPurchaseHistory(record);
  const [open, setOpen] = useState(false);
  const stats = purchasePriceStats(rows ?? []);
  const show = (value: number | null) => rows === null ? error ? '读取失败' : '读取中…' : value === null ? '暂无' : productForm?'¥'+(value/100).toFixed(total?3:2):yuan(value);
  return <div className="base-source-purchase-history">
    <div className={`base-source-purchase-stats${priceField ? ' has-price-field' : ''}`}>{priceField}<div><span>上次{total ? '总' : ''}采购价</span><strong>{show(stats.last)}</strong></div><div><span>3个月平均{total ? '总' : ''}采购价</span><strong>{show(stats.average)}</strong></div><button type="button" className="secondary-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>历史采购价{rows !== null && stats.rows.length > 0 ? '（' + stats.rows.length + '）' : ''}</button></div>
    {error && <p role="alert">{error}<button type="button" onClick={retry}>重试</button></p>}
    {open && <div className="base-source-purchase-history-list">{rows === null ? !error && <p>读取中…</p> : stats.rows.length ? stats.rows.map(row => <div key={row.id}><strong>{productForm?'¥'+(Number(row.data.purchasePrice)/100).toFixed(2):yuan(Number(row.data.purchasePrice))}</strong><span>{new Date(purchaseRecordedAt(row)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</span></div>) : <p>暂无历史采购价。</p>}</div>}
  </div>;
}
