import { api } from '../../../api/client';

export interface IssueGroup { archiveKey: string; productId: number; archiveName: string; parentPath: string[]; messages: string[] }
export interface Change { source: string; field: string; label: string; before: unknown; after: unknown }
export interface BaseCodeReport {
  id: number; code: string; name: string; status: string; aliasOf: { id: number; code: string } | null; signature: string;
  issues: IssueGroup[]; issueCount: number; secondVerification: boolean; baselineMissing: boolean; changes: Change[];
  outbound: { labels: Record<string, string>; values: Record<string, string | number | null> };
  uploadSignature: string; uploadedCode: string | null; replacing: boolean; jstStatus: string;
}
export interface VerifyResult { results: Array<{ id: number; ok: boolean; error?: string; queued?: boolean }>; verified: number; failed: number }
export interface DeleteGroup { token: string; ids: number[]; code: string; name: string; aliasCount: number; everSynced: boolean; canDelete: boolean; reason: string }
export interface DeleteExecResult { results: Array<{ code: string; ok: boolean; error?: string; disableQueued?: boolean }> }

export interface BundleReport {
  id: number; code: string; name: string; styleCode: string; shortName: string; status: string;
  components: Array<{ role: string; code: string; name: string; qty: number; weightG: number | null; cost?: number | null; unit?: string; includeInJst?: boolean; isRequired?: boolean; lossRate?: number; costBucket?: string; costTreatment?: string }>;
  totalWeightG: number; totalCost?: number; pendingRevision: { id: number; reason: string } | null; signature: string; issues: string[];
  secondVerification: boolean; baselineMissing: boolean; changes: Change[];
  outbound: { sku_id: string; i_id: string; name: string; short_name: string; weight: number; cost_price?: number };
  uploadSignature: string; uploadedCode: string | null; replacing: boolean; jstStatus: string;
}
export interface LineInput {
  role: string; baseCodeId?: number; laborId?: number; qty: number; unit?: string; lossRate?: number; isRequired?: boolean; includeInJst?: boolean;
  costBucket?: string; costTreatment?: string; sortOrder?: number; effectiveFrom?: string; effectiveTo?: string; note?: string;
}
export interface TargetInput { platformId: number; scenarioId: number; configNo?: string; bundleCategoryId?: number; brandId?: number }
export interface PreviewTarget {
  platformId: number; platformName: string; scenarioId: number; scenarioName: string; configNo: string; code: string; name: string; styleCode: string; shortName: string;
  reuse: { id: number; code: string; status: string } | null; duplicates: Array<{ layer: string; label: string; hit: string }>; ok: boolean;
}

export interface PriceRow { bundleId: number; code: string; name: string; action: 'enqueue' | 'blocked' | 'same'; priceCents: number | null; currentCents: number | null; reason: string | null }
export interface PriceLog { id: number; bundleId: number; bundleName: string | null; status: string; priceCents: number | null; message: string | null; createdAt: string }
export interface ArchiveJob { id: number; bundleId: number; code: string; name: string; status: string; message: string | null; reason: string; actorName: string | null; createdAt: string }
export type CategoryScope = 'product' | 'bundle';
export interface CategoryChange { localId: string; path: string; action: string; message: string; before: { name?: string; enable?: boolean | null } | null; after: { name?: string; enable?: boolean | null } | null }
export interface CategoryPreview { scope: CategoryScope; targetKey: string; signature: string; conflicts: number; remoteOnly: number; changes: CategoryChange[]; note: string }
export interface CategoryRun { id: number; scope: string; status: string; message: string; createdAt: string; changes: Array<{ localId: string; path: string; action: string; status: string; error: string | null }> }

export interface RegenRow { id: number; status: string; oldCode: string; newCode: string; oldName: string; newName: string; uploadedCode: string | null; token: string; error: string | null; blocked: string | null }
export interface CategoryNode { id: number; name: string; code: string; parentId: number; sort: number; status: string }

export const jstApi = {
  regenPreview: () => api<{ rows: RegenRow[] }>('/finance/bundles/regenerate/preview'),
  regenExecute: (items: Array<{ id: number; token: string }>, reason: string) =>
    api<{ results: Array<{ id: number; ok: boolean; error?: string; code?: string }>; done: number; failed: number }>('/finance/bundles/regenerate', { method: 'POST', body: { items, reason, confirmed: true } }),
  categoryTree: (archiveType: string) => api<{ nodes: CategoryNode[] }>(`/finance/categories/tree?archiveType=${encodeURIComponent(archiveType)}`),
  categoryReorder: (orderedIds: number[]) => api<{ ok: true; changed: number }>('/finance/categories/reorder', { method: 'POST', body: { orderedIds } }),

  enqueue: (type: string, items: Array<{ id: number; signature: string }>, replaceConfirmed: boolean) =>
    api<{ queued: number; skipped: number }>('/finance/jst-sync/enqueue', { method: 'POST', body: { type, items, confirmed: true, replaceConfirmed } }),
  priceSwitch: () => api<{ enabled: boolean; senderConfigured: boolean }>('/finance/jst-sync/price/switch'),
  setPriceSwitch: (enabled: boolean) => api<{ enabled: boolean; senderConfigured: boolean }>('/finance/jst-sync/price/switch', { method: 'PUT', body: { enabled, note: enabled ? '管理员打开基本售价同步' : '管理员关闭基本售价同步' } }),
  pricePreview: () => api<{ rows: PriceRow[] }>('/finance/jst-sync/price/preview'),
  priceRun: () => api<{ queued: number; blocked: number; same: number }>('/finance/jst-sync/price/run', { method: 'POST', body: {} }),
  priceLogs: (page: number) => api<{ total: number; rows: PriceLog[] }>(`/finance/jst-sync/price/logs?page=${page}&pageSize=20`),
  archiveJobs: () => api<{ rows: ArchiveJob[] }>('/finance/jst-sync/archive-jobs'),
  recheckArchive: (id: number) => api<{ ok: true; status: string; message: string }>(`/finance/jst-sync/archive-jobs/${id}/recheck`, { method: 'POST', body: {} }),
  categoryPreview: (scope: CategoryScope) => api<CategoryPreview>('/finance/jst-sync/category/preview', { method: 'POST', body: { scope } }),
  categoryExecute: (scope: CategoryScope, signature: string) => api<{ runId: number; queued: number; retired: number }>('/finance/jst-sync/category/execute', { method: 'POST', body: { scope, signature, confirmed: true } }),
  categoryRuns: (page: number) => api<{ page: number; rows: CategoryRun[] }>(`/finance/jst-sync/category/runs?page=${page}`),

  baseOverview: () => api<{ status: Record<string, number>; byCategory: Record<string, Record<string, number>> }>('/finance/base-codes/overview'),
  baseReport: (id: number) => api<BaseCodeReport>(`/finance/base-codes/${id}/report`),
  baseVerify: (items: Array<{ id: number; signature: string; uploadSignature?: string }>, confirmed: boolean, syncToJst: boolean, replaceConfirmed: boolean) =>
    api<VerifyResult>('/finance/base-codes/verify', { method: 'POST', body: { items, confirmed, syncToJst, replaceConfirmed } }),
  baseDeletePreview: (mode: 'pending' | 'source', ids?: number[]) => api<{ mode: string; groups: DeleteGroup[] }>('/finance/base-codes/deletion/preview', { method: 'POST', body: { mode, ids } }),
  baseDeleteExecute: (mode: 'pending' | 'source', groups: Array<{ token: string; ids: number[] }>, reason: string, disableConfirmed: boolean) =>
    api<DeleteExecResult>('/finance/base-codes/deletion/execute', { method: 'POST', body: { mode, groups, reason, disableConfirmed } }),

  bundleOverview: () => api<{ status: Record<string, number> }>('/finance/bundles/overview'),
  bundleReport: (id: number) => api<BundleReport>(`/finance/bundles/${id}/report`),
  bundlePreview: (lines: LineInput[], targets: TargetInput[]) => api<{ targets: PreviewTarget[]; namingRule: boolean }>('/finance/bundles/preview', { method: 'POST', body: { lines, targets } }),
  bundleGenerate: (lines: LineInput[], targets: TargetInput[]) => api<{ created: Array<{ id: number; code: string; reused: boolean }> }>('/finance/bundles/generate', { method: 'POST', body: { lines, targets } }),
  bundleVerify: (items: Array<{ id: number; signature: string; uploadSignature?: string }>, confirmed: boolean, syncToJst: boolean, replaceConfirmed: boolean) =>
    api<VerifyResult>('/finance/bundles/verify', { method: 'POST', body: { items, confirmed, syncToJst, replaceConfirmed } }),
  bundleRevise: (id: number, reason: string, lines: LineInput[]) => api<{ id: number }>(`/finance/bundles/${id}/revisions`, { method: 'POST', body: { reason, lines } }),
  bundleCancelRevision: (id: number, reason: string) => api<{ ok: true }>(`/finance/bundles/${id}/revisions/cancel`, { method: 'POST', body: { reason } }),
  bundleDeletion: (id: number) => api<{ id: number; code: string; name: string; canDelete: boolean; reason: string; token: string }>(`/finance/bundles/${id}/deletion`),
  bundleDelete: (id: number, token: string, confirmCode: string, reason: string) => api<{ ok: true }>(`/finance/bundles/${id}/deletion`, { method: 'POST', body: { token, confirmCode, reason } }),
  bundleArchive: (id: number, reason: string, disableConfirmed: boolean) => api<{ ok: true; disableQueued: boolean }>(`/finance/bundles/${id}/archive`, { method: 'POST', body: { reason, disableConfirmed } }),

  uploadOptions: () => api<{ categories: string[]; brands: string[] }>('/finance/jst-maintenance/options'),
  uploadCheck: (b: { skuId?: string; styleId?: string; name?: string }) =>
    api<{ hasHighRisk: boolean; hasWarning: boolean; matches: Array<{ source: string; field: string; level: 'high' | 'warning'; hit: string }> }>('/finance/jst-maintenance/check-duplicate', { method: 'POST', body: b }),
  upload: (form: Record<string, string | number>) => api<{ id: number; queued: boolean; warnings: unknown[] }>('/finance/jst-maintenance/upload', { method: 'POST', body: { form } }),
  uploadLogs: (p: { keyword?: string; page: number }) => {
    const q = new URLSearchParams({ page: String(p.page), pageSize: '20', ...(p.keyword ? { keyword: p.keyword } : {}) });
    return api<{ total: number; rows: Array<{ id: number; skuId: string; styleId: string; name: string; status: string; message: string; createdAt: string }> }>(`/finance/jst-maintenance/logs?${q}`);
  },
};
