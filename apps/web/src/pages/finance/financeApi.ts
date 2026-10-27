import type { DocInput, DocLineInput, DocType } from '@kudesi/shared';
import type { FileInfo } from '../../resources/api';
import { api } from '../../api/client';

export interface DocRow { id: number; docNo: string; docType: DocType; typeLabel: string; status: 'draft' | 'issued' | 'posted' | 'reversed'; docDate: string; amountCents: number; paidCents: number; bankName: string | null; handler: string | null; auditedAt: string | null; createdBy: number; memo: string | null; reversesId: number | null; partyName: string | null; createdByName: string | null; direction?: 'in' | 'out' | 'internal'; source?: string; refNo?: string | null }
export interface DocList { todayCount?: number; total: number; amountCents: number; paidCents: number; incomeCents?: number; expenseCents?: number; page: number; pageSize: number; rows: DocRow[] }
export interface BatchResult { okCount: number; failCount: number; results: Array<{ id: number; ok: boolean; docNo?: string; error?: string }> }
export interface DocEntry { id: string; kind: string; accountId: number; accountName: string; subId: number; amountCents: number | null; qty: number | null }
export interface DocLineView extends DocLineInput { id: number; productName: string; feeItemName: string; lineNo: number; relatedNode: string | null; relatedId: number | null; relatedName: string | null }
export interface DocDetailDto {
  id: number; docNo: string; docType: DocType; typeLabel: string; status: DocRow['status']; docDate: string; partyId: number | null; partyName: string;
  storeId: number | null; storeName: string; refNo: string | null; bankAccountId: number | null; bankName: string; toBankAccountId: number | null; toBankName: string; warehouseId: number | null; warehouseName: string;
  amountCents: number; offsetCents: number; paidCents: number; partyKind: 'customer' | 'store' | 'supplier' | 'employee' | null; handler: string | null; department: string | null; memo: string | null; reversesId: number | null; reversedById: number | null; auditedAt: string | null; createdByName: string;
  sourceKey?: string | null; openingVouchers?: FileInfo[];
  settleBy?: 'doc' | 'product' | null; settleByLabel?: string | null;
  settlements?: Array<{ id: number; sourceDocId: number; sourceDocNo: string; sourceTypeLabel: string; productId: number | null; productName: string; amountCents: number }>;
  settledBy?: Array<{ id: number; docNo: string; docType: string; status: string; amountCents: number }>;
  accounts: Array<{ id: number; role: 'out' | 'in'; bankAccountId: number; amountCents: number; bankName: string }>; lines: DocLineView[]; entries: DocEntry[]; events: Array<{ id: number; action: string; note: string | null; actorName: string; createdAt: string }>;
}
export type DocBody = DocInput & { memo?: string };

export interface CostLine { role: string; code: string; name: string; qty: number; unitCostCents: number | null; subtotalCents: number | null; unitWeightG: number | null; weightG: number }
export interface CostRow {
  bundleId: number; code: string; name: string; status: string; categoryId: number | null; categoryName: string; preShipCostCents: number | null; weightG: number | null;
  freightCents: number | null; freightMethod: string | null; marginPercent: number | null; marginSource: string; marginOverride: boolean; inheritedMargin: { percent: number | null; source: string };
  carrierName: string; costIncludingFreightCents: number | null; revision: string; minPriceCents: number | null; issues: string[]; lines: CostLine[];
}
export interface CostCategory { id: number; name: string; parentId: number | null; ownPercent: number | null; percent: number | null; source: string; revision: string; count: number }
export interface CostTableData {
  total: number; page: number; pageSize: number; rows: CostRow[]; categories: CostCategory[]; defaultMargin: { percent: number | null; revision: string }; allTotal: number; canEdit: boolean;
}
export interface CostPricingSave { revision: string; carrierName: string; profitPercent: number | null; reason: string }
export interface MarginHistoryRow { id: string; createdAt: string; actorName: string; scopeName: string; beforePercent: number | null; afterPercent: number | null; reason: string }
export interface PricingHistoryRow { id: string; createdAt: string; actorName: string; bundleId: number; code: string; name: string; beforeCarrier: string; afterCarrier: string; beforePercent: number | null; afterPercent: number | null; reason: string }
export interface Paged<T> { total: number; page: number; pageSize: number; rows: T[] }

export interface DebugRow { id: number; skuCode: string; skuName: string; categoryId: number | null; categoryName: string; ready: boolean; weightG: number | null; minPriceCents: number | null; preShipCostCents?: number | null; exclusiveOwners?: Array<{ id: number; ownerName: string; endsAt: string; mine: boolean }> }
export interface DebugList { rows: DebugRow[]; total: number; page: number; pageSize: number; canViewInternals: boolean }
export interface DebugComponents { categories: Array<{ id: number; name: string; parentId: number | null }>; rows: Array<{ id: number; code: string; name: string; categoryId: number | null }>; total: number; page: number; pageSize: number }
export interface DebugProfit { id: number; amountCents: number }
export interface DebugSlider { available: boolean; message?: string; reservedProfitCents?: number; reservedProfitPercent?: number | null; priceCents?: number; step?: number }
export interface DebugQuote { id: number; available: boolean; message?: string; priceCents?: number; roi?: number; minPriceCents?: number }
export interface DebugExportInput { id: number; step: number; profit?: DebugProfit; mode: 'roiToPrice' | 'priceToRoi' | 'sliderPrice'; value?: number; sellingPriceCents?: number; roi?: number; sliderPriceCents?: number }
export interface OpenItem { id: number; docNo: string; docType: string; typeLabel: string; docDate: string; amountCents: number; paidCents: number; offsetCents: number; outstandingCents: number; products: Array<{ productId: number; productName: string; amountCents: number; outstandingCents: number }> }
export interface SettlementRow { id: number; docId: number; docNo: string; typeLabel: string; docDate: string; partyName: string; settleByLabel: string; sourceDocId: number; sourceDocNo: string; sourceTypeLabel: string; productName: string; amountCents: number }
export interface UnsettledRow { id: number; docNo: string; typeLabel: string; docDate: string; partyName: string; settleByLabel: string; totalCents: number; allocatedCents: number; unallocatedCents: number }
export interface BankBalance {
  id: number; title: string; kind: string; status: string; openingCents: number; movementCents: number; balanceCents: number; entries: number;
  bank?: string; ownerName?: string; licenseName?: string; keeperName?: string; storeIds?: number[]; storeNames?: string[]; updatedAt?: string | null;
}
export interface LedgerRow { id: number; entryDate: string; amountCents: number; balanceCents: number; documentId: number; docNo: string; typeLabel: string; memo: string | null; handler: string | null; partyName: string | null }
export interface Ledger { openingCents: number; incomeCents: number; expenseCents: number; closingCents: number; rows: LedgerRow[] }
export interface StockRow { code: string; unit: string; productId: number; warehouseId: number; productName: string; warehouseName: string; qty: number; avgCostCents: number | null; amountCents: number | null }
export interface StoreFund { storeId: number; name: string; storeNo?: string; platform?: string; platformLabel?: string; snapshotDate: string; updatedAt?: string | null; withdrawableCents: number; depositCents: number; frozenCents: number; promotionCents: number }
export interface Overview {
  trend: Array<{ date: string; revenueCents: number; expenseCents: number; profitCents: number | null }>;
  trendBy?: 'day' | 'month';
  stores: Array<{ storeId: number; name: string; licenseName?: string; platform?: string; salesCents: number; adCostCents: number; profitCents: number | null }>;
  ledger: Array<{ date: string; direction: 'in' | 'out'; kind: string; amountCents: number; documentId: number; docNo: string; docType: string; storeName?: string; source?: string }>;
  month: string; revenueCents: number; cogsCents: number | null; grossProfitCents: number | null; expenseCents: number; otherIncomeCents: number; netProfitCents: number | null;
  receivableCents: number; payableCents: number; advanceReceiptCents: number; prepaymentCents: number; bankCents: number | null; drafts: number; issued: number;
}

export interface CostSnapshotRow { eventType?: string; eventLabel?: string; id: number; bundleId: number; code: string; name: string; revision: number; reason: string; actorName: string; createdAt: string; preShipCostCents: number | null; weightG: number | null; freightCents: number | null; marginPercent: number | null; minPriceCents: number | null; changes: Array<{ field: string; label: string; before: number | null; after: number | null }> }
export interface ZoneRow { carrier: string; branch: string; weightStart: number; weightEnd: number; cents: number; provinces: string[]; suggestedName: string }
export interface PackagingMatch {
  selected: { scheme: { id: number; code: string; name: string; usageScene: string }; lines: Array<{ componentName: string; qty: number; lossRate: number | null; costTreatment: string; costBucket: string }> } | null;
  matches: Array<{ ruleId: number; schemeId: number | null; schemeName: string; priority: number }>; ambiguous: boolean; issues: Array<{ level: string; message: string }>;
}
export interface ApiKeyRow { id: string; name: string; scope: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
export interface ResetPreview { includePlatforms: boolean; confirmation: string; total: number; tables: Array<{ type: string; label: string; count: number }>; blockedByDocuments: number; exclusions: string[] }
export interface SnapshotRow { id: number; operation: string; label: string; rowCount: number; restoredAt: string | null; createdAt: string; actorName: string | null; confirmation: string }
export interface ExpressDraft { carrier: string; branch: string; province: string; shipWeightMin: number | null; shipWeightMax: number | null; firstWeight: number | null; firstPrice: number | null; extraPrice: number | null; fixedPrice: number | null; validFrom: string; validTo: string; warnings: string[] }

export interface OutboxJobRow { id: number; kind: string; resourceType: string; resourceId: number; status: 'pending' | 'sending' | 'done' | 'failed' | 'cancelled'; attempts: number; lastError: string | null; createdAt: string; doneAt: string | null; payload: { code?: string; name?: string } }

const qs = (o: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const financeApi = {
  docs: (p: { scope: string; direction?: string; status?: string; from?: string; to?: string; keyword?: string; creatorId?: number; audited?: string; docType?: string; page?: number }) => api<DocList>(`/finance/docs${qs(p)}`),
  doc: (id: number) => api<DocDetailDto>(`/finance/docs/${id}`),
  create: (b: DocBody) => api<DocDetailDto>('/finance/docs', { method: 'POST', body: b }),
  update: (id: number, b: DocBody) => api<DocDetailDto>(`/finance/docs/${id}`, { method: 'PUT', body: b }),
  remove: (id: number) => api<{ ok: true }>(`/finance/docs/${id}`, { method: 'DELETE', body: {} }),
  issue: (id: number) => api<DocDetailDto>(`/finance/docs/${id}/issue`, { method: 'POST', body: {} }),
  unissue: (id: number, reason: string) => api<DocDetailDto>(`/finance/docs/${id}/unissue`, { method: 'POST', body: { reason } }),
  editHeader: (id: number, b: { date?: string; handler?: string | null; memo?: string | null }) => api<DocDetailDto>(`/finance/docs/${id}/header`, { method: 'PUT', body: b }),
  audit: (id: number, on: boolean) => api<DocDetailDto>(`/finance/docs/${id}/audit`, { method: 'POST', body: { on } }),
  copy: (id: number) => api<DocDetailDto>(`/finance/docs/${id}/copy`, { method: 'POST', body: {} }),
  batch: (action: 'post' | 'delete' | 'copy', ids: number[]) => api<BatchResult>('/finance/docs-batch', { method: 'POST', body: { action, ids } }),
  post: (id: number) => api<DocDetailDto>(`/finance/docs/${id}/post`, { method: 'POST', body: {} }),
  registerOpeningPrepayment: (id: number, body: { reason: string; fileIds: number[]; confirmed: boolean }) => api<DocDetailDto>(`/finance/docs/${id}/opening-prepayment`, { method: 'POST', body }),
  uploadOpeningVoucher: (id: number, file: File) => { const form = new FormData(); form.append('file', file); return api<FileInfo>(`/finance/docs/${id}/opening-vouchers`, { form }); },
  openingVoucherUrl: (id: number, fileId: number) => api<{ url: string }>(`/finance/docs/${id}/opening-vouchers/${fileId}/url`),
  reverse: (id: number, reason: string) => api<DocDetailDto>(`/finance/docs/${id}/reverse`, { method: 'POST', body: { reason } }),
  costTable: (p: { categoryId?: number; keyword?: string; page?: number }) => api<CostTableData>(`/finance/cost-table${qs({ ...p, pageSize: 20 })}`),
  exportCostTable: (p: { categoryId?: number; keyword?: string }) => api<{ fileName: string; fileBase64: string; rowCount: number }>(`/finance/cost-table/export${qs(p)}`),
  saveCostPricing: (bundleId: number, b: CostPricingSave) => api<{ ok: true; changed: boolean }>(`/finance/cost-table/${bundleId}/pricing`, { method: 'PUT', body: b }),
  saveCategoryMargin: (categoryId: number, b: { revision: string; profitPercent: number | null; reason: string }) => api<{ ok: true; changed: boolean }>(`/finance/cost-table/category-margins/${categoryId}`, { method: 'PUT', body: b }),
  skuCostHistory: (bundleId: number, page = 1) => api<{ changes: { total: number; rows: CostSnapshotRow[] }; pricing: { total: number; rows: PricingHistoryRow[] } }>(`/finance/cost-table/${bundleId}/history${qs({ page })}`),
  marginHistory: (p: { keyword?: string; page?: number }) => api<Paged<MarginHistoryRow>>(`/finance/cost-history/margins${qs(p)}`),
  pricingHistory: (p: { keyword?: string; page?: number }) => api<Paged<PricingHistoryRow>>(`/finance/cost-history/pricing${qs(p)}`),
  debugComponents: (p: { categoryId?: number; keyword?: string; page?: number }) => api<DebugComponents>(`/finance/pricing-debug/components${qs(p)}`),
  debugList: (p: { categoryId?: number; baseCodeId?: number; keyword?: string; exclusive?: 'mine'; page?: number; pageSize?: number }) => api<DebugList>(`/finance/pricing-debug${qs(p)}`),
  debugSlider: (b: { id: number; step: number; profit?: DebugProfit }) => api<DebugSlider>('/finance/pricing-debug/slider-price', { method: 'POST', body: b }),
  debugQuote: (b: { mode: 'roiToPrice' | 'priceToRoi'; inputs: Array<{ id: number; step: number; value: number; profit?: DebugProfit }> }) => api<{ rows: DebugQuote[] }>('/finance/pricing-debug/quote', { method: 'POST', body: b }),
  debugExport: (inputs: DebugExportInput[]) => api<{ fileName: string; fileBase64: string; rowCount: number }>('/finance/pricing-debug/export', { method: 'POST', body: { inputs } }),
  freight: (weightG: number) => api<{ weightG: number; cents: number | null; method: string | null; samples: number }>(`/finance/freight-estimate${qs({ weightG })}`),
  storeFunds: () => api<StoreFund[]>('/finance/store-funds'),
  keyAccounts: () => api<number[]>('/finance/key-accounts'),
  setKeyAccount: (id: number, on: boolean) => api<number[]>(`/finance/key-accounts/${id}`, { method: 'PUT', body: { on } }),
  banks: () => api<BankBalance[]>('/finance/bank-balances'),
  ledger: (id: number, p: { from?: string; to?: string } = {}) => api<Ledger>(`/finance/bank-ledger/${id}${qs(p)}`),
  inventory: (p: { warehouseId?: number; keyword?: string; asOf?: string; stockStatus?: string }) => api<StockRow[]>(`/finance/inventory${qs(p)}`),
  syncEmployees: () => api<{ created: number }>('/finance/employee-parties/sync', { method: 'POST', body: {} }),
  openItems: (p: { dir: 'in' | 'out'; partyKind: string; partyId: number }) => api<OpenItem[]>(`/finance/open-items${qs(p)}`),
  settlementDetail: (p: { from?: string; to?: string; partyId?: number; docType?: string }) => api<SettlementRow[]>(`/finance/settlement-detail${qs(p)}`),
  unsettledReceipts: (p: { from?: string; to?: string; partyId?: number; docType?: string }) => api<UnsettledRow[]>(`/finance/unsettled-receipts${qs(p)}`),
  costHistory: (p: { bundleId?: number; keyword?: string; page?: number }) => api<{ total: number; page: number; pageSize: number; rows: CostSnapshotRow[] }>(`/finance/cost-history${qs({ ...p, pageSize: 20 })}`),
  registerCost: (b: { bundleId?: number; reason?: string }) => api<{ recorded: number; unchanged: number }>('/finance/cost-history/register', { method: 'POST', body: b }),
  zone: (maxWeightKg: number) => api<{ generatedAt: string; day: string; maxWeightKg: number; ruleCount: number; rows: ZoneRow[] }>(`/finance/zone-suggestion${qs({ maxWeightKg })}`),
  packagingMatch: (b: Record<string, unknown>) => api<PackagingMatch>('/finance/packaging-match', { method: 'POST', body: b }),
  apiKeys: () => api<ApiKeyRow[]>('/finance/api-keys'),
  createApiKey: (name: string) => api<{ id: string; name: string; key: string; message: string }>('/finance/api-keys', { method: 'POST', body: { name } }),
  revokeApiKey: (id: string) => api<{ ok: true }>(`/finance/api-keys/${id}`, { method: 'DELETE' }),
  resetPreview: (includePlatforms: boolean) => api<ResetPreview>(`/finance/master-reset/preview${qs({ includePlatforms: String(includePlatforms) })}`),
  resetExecute: (b: { confirm: string; includePlatforms: boolean; label?: string }) => api<{ ok: true; snapshot: { id: number }; totalDeleted: number }>('/finance/master-reset/execute', { method: 'POST', body: b }),
  snapshots: () => api<SnapshotRow[]>('/finance/master-reset/snapshots'),
  restoreSnapshot: (id: number, confirm: string) => api<{ ok: true; restored: number }>(`/finance/master-reset/snapshots/${id}/restore`, { method: 'POST', body: { confirm } }),
  recognizeExpress: (file: File) => { const form = new FormData(); form.append('file', file); return api<{ rows: ExpressDraft[]; warnings: string[]; rawText: string }>('/ocr/express-prices', { form }); },
  confirmExpress: (rows: ExpressDraft[]) => api<{ created: number; failed: number; results: Array<{ index: number; ok: boolean; error?: string }> }>('/finance/express-recognize/confirm', { method: 'POST', body: { rows } }),
  jstSwitch: () => api<{ enabled: boolean; note: string | null; senderConfigured: boolean }>('/finance/jst-sync/switch'),
  setJstSwitch: (enabled: boolean, note?: string) => api<{ enabled: boolean; note: string | null; senderConfigured: boolean }>('/finance/jst-sync/switch', { method: 'PUT', body: { enabled, note } }),
  jstJobs: (p: { status?: string; page?: number }) => api<{ total: number; counts: Record<string, number>; rows: OutboxJobRow[] }>(`/finance/jst-sync/jobs${qs({ ...p, pageSize: 20 })}`),
  jstRetry: (id: number) => api<{ ok: true }>(`/finance/jst-sync/jobs/${id}/retry`, { method: 'POST', body: {} }),
  jstCancel: (id: number) => api<{ ok: true }>(`/finance/jst-sync/jobs/${id}/cancel`, { method: 'POST', body: {} }),
  overview: (month?: string, range?: { from?: string; to?: string }) => api<Overview>(`/finance/overview${qs({ month, from: range?.from, to: range?.to })}`),
};
