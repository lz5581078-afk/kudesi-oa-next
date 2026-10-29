import { api } from '../../api/client';

export interface ProductOption { id: number; code: string; name: string; spec: string }
export interface PurchaseSummary {
  canSeeMoney: boolean;
  lines: Array<{ productId: number; code: string; name: string; qty: number; unit: string; note: string; received: number | null; accepted: number | null; unitPriceCents?: number }>;
  supplier: { id: number; name: string } | null;
  orderNo: string | null; paymentMode: string | null; promisedArrivalDate: string | null;
  totalCents?: number | null; paidCents?: number;
  inbound: { docId: number; docNo: string } | null;
  canGenerateDraft: boolean; acceptedCount: number;
}

/** 采购流程的辅助接口；发起和办理本身走通用的 flowApi。 */
export const purchaseApi = {
  options: (keyword: string) => api<{ items: ProductOption[] }>(`/flow/purchase/options?keyword=${encodeURIComponent(keyword)}`),
  names: (ids: number[]) => api<{ items: ProductOption[] }>(`/flow/purchase/options?ids=${ids.join(',')}`),
  summary: (runId: number) => api<PurchaseSummary>(`/flow/purchase/runs/${runId}/summary`),
  inboundDraft: (runId: number, body: { warehouseId: number; date?: string }) => api<{ docId: number; docNo: string; already: boolean }>(`/flow/purchase/runs/${runId}/inbound-draft`, { method: 'POST', body }),
};

export const PURCHASE_TEMPLATE_KEY = 'purchase-request';
export const yuan = (cents: number | null | undefined) => (cents === null || cents === undefined ? '—' : `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
