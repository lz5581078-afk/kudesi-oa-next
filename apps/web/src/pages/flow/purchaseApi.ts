import { api } from '../../api/client';

export interface PurchaseProduct { id: number; code: string; name: string; archiveType: string; categoryId: number | null; categoryName: string; unit: string; unitKey: string; aliases: string[] }
export interface PurchaseProducts { total: number; page: number; pageSize: number; rows: PurchaseProduct[]; categories: Array<{ id: number; name: string; parentId: number | null }> }
type Q = { productId: number; qty: number };
export interface PurchaseBatchDto {
  id: string; shipmentId: string; shipment: Q[]; logisticsNo: string; expectedArrivalAt: string; dispatchFiles: number[]; arrived: boolean; arrivalFiles: number[];
  received: Q[] | null; receiptFiles: number[]; difference: string; deliveryShortage: Q[]; accepted: Array<Q & { unitPriceCents?: number }> | null; qualityFiles: number[]; qualityComment: string;
  pendingException: boolean; resolution: string | null; resolutionComment: string; resolutionFiles: number[]; discountApproval: boolean; returnedLines: Q[]; retryShipment: boolean; returnedToSupplier: boolean;
  feesDeclared: boolean; zeroReason: string; allocationMethod: string | null; posted: boolean;
  fees: Array<{ id: string; type: 'freight' | 'handling'; paid: boolean; files: number[]; amountCents?: number; payeeName?: string; payeeAccount?: string; paymentDocNo?: string | null; paymentFiles?: number[] }>;
  goodsCents?: number | null; offsetCents?: number | null; docNo?: string | null; costPublication?: Array<{ productId: number; purchasePriceCents: number; freightCents: number; handlingCents: number }>;
}
export interface PurchaseViewDto {
  id: number; status: string; requesterId: number; requestedArrivalAt: string; note: string; money: boolean; myStep: string | null;
  supplierName: string; warehouseName: string; paymentMode: string | null; planReady: boolean; approved: boolean; paid: boolean; amendOpen: boolean;
  cancelRequested: boolean; cancelApproved: boolean; cancelledRemaining: boolean; cancelRequestComment: string;
  lines: Array<{ productId: number; name: string; code: string; unit: string; aliasName: string | null; qty: number; received: number; cancelled: number; remaining: number; toShip: number; unitPriceCents?: number | null }>;
  shipments: Array<{ id: string; logisticsNo: string; expectedArrivalAt: string; files: number[]; lines: Array<Q & { outstanding: number }> }>;
  pendingShipments: string[]; batches: PurchaseBatchDto[];
  followups: Array<{ at: string; promisedShipAt: string; comment: string; byName: string }>;
  amendments: Array<{ at: string; byName: string; comment: string }>;
  payeeName?: string; payeeAccount?: string; planNote?: string; approvedCents?: number | null; approvalComment?: string;
  payments?: Array<{ docId: number; docNo: string; amountCents: number; bankAccountId: number; reference: string; files: number[]; payeeName: string; payeeAccount: string }>;
  prepay?: { paidCents: number; claimedCents: number; offsetCents: number; refundedCents: number; unusedCents: number };
  refunds?: Array<{ docId: number; docNo: string; sourceDocId: number; amountCents: number; reference: string; files: number[] }>;
  prepayReviewed?: boolean;
}
export interface PurchaseOptions { step: string; suppliers?: Array<{ id: number; name: string }>; warehouses?: Array<{ id: number; name: string }>; banks?: Array<{ id: number; name: string }>; prepay?: { balanceCents: number; availableCents: number } }
export interface PurchaseProgress { supplierName: string; requestedArrivalAt: string; batches: number; total: number; received: number; items: number; abnormal: boolean; refunding: boolean }

const qs = (o: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') q.set(k, String(v));
  return q.toString() ? `?${q}` : '';
};
export const purchaseApi = {
  products: (p: { keyword?: string; categoryId?: number; page?: number }) => api<PurchaseProducts>(`/flow/purchase/products${qs(p)}`),
  progress: (ids: number[]) => (ids.length ? api<Record<string, PurchaseProgress>>(`/flow/purchase/progress?ids=${ids.join(',')}`) : Promise.resolve({} as Record<string, PurchaseProgress>)),
  state: (id: number) => api<PurchaseViewDto>(`/flow/purchase/runs/${id}/state`),
  options: (id: number) => api<PurchaseOptions>(`/flow/purchase/runs/${id}/options`),
  followup: (id: number, b: { promisedShipAt: string; comment?: string }) => api<{ ok: true }>(`/flow/purchase/runs/${id}/followup`, { method: 'POST', body: b }),
  control: (id: number, b: { mode: 'amend' | 'cancel_remaining'; comment: string }) => api<unknown>(`/flow/purchase/runs/${id}/control`, { method: 'POST', body: b }),
  upload: (runId: number, file: File) => { const f = new FormData(); f.append('runId', String(runId)); f.append('file', file); return api<{ id: number; name: string }>('/flow/purchase/evidence', { form: f }); },
  fileUrl: (runId: number, fileId: number) => api<{ url: string }>(`/flow/purchase/evidence/${fileId}/url?runId=${runId}`),
};

/** 元 → 分（最多 4 位小数，即元最多 6 位小数）；空或非法返回 null */
export function yuanToCents(s: string): number | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  return Math.round(Number(t) * 1e6) / 1e4;
}
export const centsToYuan = (c: number | null | undefined) => (c === null || c === undefined ? '' : String(Math.round(c * 1e4) / 1e6));
export const money = (c: number | null | undefined) => (c === null || c === undefined ? '—' : `¥${(c / 100).toFixed(2)}`);
