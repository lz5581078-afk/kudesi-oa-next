import type {NamingInput} from '@kudesi/shared';
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

export interface BundleSummary { id:number; issueCount?:number; mainStyleCode:string|null; weightG:number|null; componentCount:number; packageCount:number; packageSummary:string; cost?:number|null; salePrice?:number|null }
export interface BundleReport {
  id: number; code: string; name: string; styleCode: string; shortName: string; status: string;
  components: Array<{ role: string; code: string; name: string; qty: number; weightG: number | null; cost?: number | null; unit?: string; includeInJst?: boolean; isRequired?: boolean; lossRate?: number; costBucket?: string; costTreatment?: string }>;
  totalWeightG: number; totalCost?: number | null; pendingRevision: { id: number; reason: string } | null; signature: string; issues: string[];
  secondVerification: boolean; baselineMissing: boolean; changes: Change[];
  outbound: { sku_id: string; i_id: string; name: string; short_name: string; weight: number; cost_price?: number | null };
  uploadSignature: string; uploadedCode: string | null; replacing: boolean; jstStatus: string;
}
export interface LineInput {
  role: string; baseCodeId?: number; productId?: number; laborId?: number; qty: number; unit?: string; lossRate?: number; isRequired?: boolean; includeInJst?: boolean;
  costBucket?: string; costTreatment?: string; sortOrder?: number; effectiveFrom?: string; effectiveTo?: string; note?: string;
}
export interface BundleBomVersion{id:number|null;versionNo:string;status:string;activatedAt:string|null;sealedAt:string|null;used:boolean;editable:boolean;sourceToken:string;lines:LineInput[];remark:string}
export interface BundleReferenceLine {id:number;role:string;name:string;code:string;spec:string;qty:number|null;unit:string;weightG:number|null;isRawFinishedName:boolean;cost?:number|null;costSubtotal?:number|null;costSource?:string;saleSubtotal?:number|null}
export interface BundleReferenceDetail {id:number;code:string;name:string;shortName:string;mainStyleCode:string;styleCode:string;platform:string;spec:string;costVersionName?:string;lines:BundleReferenceLine[]}
export interface BundleComposition {referenceDetail?:BundleReferenceDetail;baseUnits?:Record<number,{unit:string;label:string;available:boolean}>;sourceToken:string;profile:Record<string,unknown>;lines:Array<LineInput&{label:string}>;facts:Record<string,{title:string;code:string;unit:string;weightG:number|null;available:boolean}>;weightG:number|null;weightMode:'auto'|'manual';canManualWeight:boolean;pending:{id:number;reason:string;lines:Array<LineInput&{label?:string}>;weightG?:number;weightMode?:'auto'|'manual'}|null;history:Array<{id:number;status:string;reason:string;createdAt:string}>}
export interface TargetInput { sourceBundleId?:number;sourceToken?:string; platformId: number; scenarioId: number; manualStyleCode?:string;manualPropertiesValue?:string;baseUnit?:string;weightMode?:'auto'|'manual';manualWeightG?:number;overrideReason?:string;configNo?: string; bundleCategoryId?: number; brandId?: number; manualCode?: string; manualName?: string; manualShortName?: string; manualReason?: string }
export interface PreviewTarget {
  platformId: number; platformName: string; scenarioId: number; scenarioName: string; configNo: string; code: string; name: string; styleCode: string; shortName: string; mainStyleCode?:string;propertiesValue?:string;baseUnit?:string;weightG?:number|null;cost?:number|null;errors?:string[];
  reuse: { id: number; code: string; status: string } | null; duplicates: Array<{ layer: string; label: string; hit: string }>; ok: boolean;
}

export interface PriceRow { bundleId: number; code: string; name: string; action: 'enqueue' | 'blocked' | 'same'; priceCents: number | null; currentCents: number | null; reason: string | null }
export interface PriceLog { id: number; bundleId: number; bundleName: string | null; status: string; priceCents: number | null; message: string | null; createdAt: string }
export interface ArchiveJob { id: number; bundleId: number; code: string; name: string; status: string; message: string | null; reason: string; actorName: string | null; createdAt: string }
export type CategoryScope = 'product' | 'bundle' | 'archive';
export interface CategoryChange { localId: string; path: string; action: string; message: string; before: { id?:string;name?: string;parentId?:string;sort?:number|null;parentLabel?:string;enable?: boolean | null } | null; after: { name?: string;parentId?:string;sort?:number|null;parentLabel?:string;enable?: boolean | null } | null }
export interface CategoryTarget {key:string;name:string;coid:string}
export interface CategoryStatus {enabled:boolean;effective:boolean;stopped:boolean;target:CategoryTarget|null;hasPending:boolean;lastError:string;page:number;rows:CategoryRun[]}
export interface CategoryPreview { target?:{name:string;coid:string}|null;scope: CategoryScope; targetKey: string; signature: string; conflicts: number; remoteOnly: number; changes: CategoryChange[]; note: string }
export interface CategoryRun { mode?:string;id: number; scope: string; status: string; message: string; createdAt: string; changes: Array<{ localId: string; path: string; action: string; status: string; error: string | null }> }

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
  categoryStatus:(scope:CategoryScope,page=1)=>api<CategoryStatus>(`/finance/jst-sync/category/status?scope=${scope}&page=${page}`),
  categoryAutomatic:(scope:CategoryScope,enabled:boolean,confirmed=false,targetKey?:string)=>api<{enabled:boolean}>('/finance/jst-sync/category/automatic',{method:'PUT',body:{scope,enabled,confirmed,targetKey}}),
  categoryRetry:(scope:CategoryScope)=>api<{queued:number}>('/finance/jst-sync/category/retry',{method:'POST',body:{scope}}),
  categoryPreview: (scope: CategoryScope) => api<CategoryPreview>('/finance/jst-sync/category/preview', { method: 'POST', body: { scope } }),
  categoryExecute: (scope: CategoryScope, signature: string) => api<{ runId: number; queued: number; retired: number }>('/finance/jst-sync/category/execute', { method: 'POST', body: { scope, signature, confirmed: true } }),
  categoryRuns: (page: number) => api<{ page: number; rows: CategoryRun[] }>(`/finance/jst-sync/category/runs?page=${page}`),

  baseOverview: () => api<{ status: Record<string, number>; byCategory: Record<string, Record<string, number>>; byCodeCategory?:Record<string,Record<string,number>>; verification?:Record<string,number>; unknownInactive?:number }>('/finance/base-codes/overview'),
  baseReport: (id: number) => api<BaseCodeReport>(`/finance/base-codes/${id}/report`),
  baseVerify: (items: Array<{ id: number; signature: string; uploadSignature?: string }>, confirmed: boolean, syncToJst: boolean, replaceConfirmed: boolean) =>
    api<VerifyResult>('/finance/base-codes/verify', { method: 'POST', body: { items, confirmed, syncToJst, replaceConfirmed } }),
  baseDeletePreview: (mode: 'pending' | 'source', ids?: number[]) => api<{ mode: string; groups: DeleteGroup[] }>('/finance/base-codes/deletion/preview', { method: 'POST', body: { mode, ids } }),
  baseDeleteExecute: (mode: 'pending' | 'source', groups: Array<{ token: string; ids: number[] }>, reason: string, disableConfirmed: boolean) =>
    api<DeleteExecResult>('/finance/base-codes/deletion/execute', { method: 'POST', body: { mode, groups, reason, disableConfirmed } }),

  bundleOverview: () => api<{ status: Record<string, number>; verification?:Record<string,number>; unknownInactive?:number; byBundleLifecycleCategory?:Record<string,Record<string,Record<string,number>>> }>('/finance/bundles/overview'),
  bundleSummaries: (ids:number[]) => api<{rows:BundleSummary[]}>(`/finance/bundles/summaries?ids=${ids.join(',')}`),
  bundleBomVersions:(id:number)=>api<{rows:BundleBomVersion[]}>(`/finance/bundles/${id}/bom-versions`),
  bundleComposition:(id:number)=>api<BundleComposition>(`/finance/bundles/${id}/composition`),
  bundleReport: (id: number) => api<BundleReport>(`/finance/bundles/${id}/report`),
  bundleNamingSample:(baseCodeId:number,qty:number)=>api<{input:NamingInput;brandId?:number|null;platformId?:number|null}>(`/finance/bundles/naming-sample?baseCodeId=${baseCodeId}&qty=${qty}`),
  bundlePreview: (lines: LineInput[], targets: TargetInput[]) => api<{ targets: PreviewTarget[]; namingRule: boolean }>('/finance/bundles/preview', { method: 'POST', body: { lines, targets } }),
  bundleGenerate: (lines: LineInput[], targets: TargetInput[]) => api<{ created: Array<{ id: number; code: string; reused: boolean }> }>('/finance/bundles/generate', { method: 'POST', body: { lines, targets } }),
  bundleVerify: (items: Array<{ id: number; signature: string; uploadSignature?: string }>, confirmed: boolean, syncToJst: boolean, replaceConfirmed: boolean) =>
    api<VerifyResult>('/finance/bundles/verify', { method: 'POST', body: { items, confirmed, syncToJst, replaceConfirmed } }),
  bundleRevise: (id: number, reason: string, lines: LineInput[],facts?:{sourceToken:string;weight?:{mode:'auto'|'manual';grams:number}}) => api<{ id: number }>(`/finance/bundles/${id}/revisions`, { method: 'POST', body: { reason, lines,...facts } }),
  bundleCancelRevision: (id: number, reason: string) => api<{ ok: true }>(`/finance/bundles/${id}/revisions/cancel`, { method: 'POST', body: { reason } }),
  bundleDeletion: (id: number) => api<{ id: number; code: string; name: string; canDelete: boolean; reason: string; token: string }>(`/finance/bundles/${id}/deletion`),
  bundleDelete: (id: number, token: string, confirmCode: string, reason: string) => api<{ ok: true }>(`/finance/bundles/${id}/deletion`, { method: 'POST', body: { token, confirmCode, reason } }),
  bundleArchive: (id: number, reason: string, disableConfirmed: boolean) => api<{ ok: true; disableQueued: boolean }>(`/finance/bundles/${id}/archive`, { method: 'POST', body: { reason, disableConfirmed } }),

  uploadOptions: () => api<{ categories: string[]; categoryOptions?: Array<{ value: string; label: string; disabled: boolean; reason?: string }>; brands: string[]; errors?: Record<string, string> }>('/finance/jst-maintenance/options'),
  uploadCheck: (body: { skuId?: string; styleId?: string; name?: string; categoryName?: string }) =>
    api<{ signature: string | null; hasHighRisk: boolean; hasWarning: boolean; errors: string[]; matches: Array<{ source: string; field: string; level: 'high' | 'warning'; hit: string; skuId: string; styleId: string; name: string; spec: string; category: string }> }>('/finance/jst-maintenance/check-duplicate', { method: 'POST', body }),
  upload: (form: Record<string, string | number>, signature: string, confirmed: boolean) => api<{ id: number; queued: boolean; warnings: unknown[] }>('/finance/jst-maintenance/upload', { method: 'POST', body: { form, signature, confirmed } }),
  uploadLogs: (params: { keyword?: string; page: number }) => {
    const query = new URLSearchParams({ page: String(params.page), pageSize: '30', ...(params.keyword ? { keyword: params.keyword } : {}) });
    return api<{ total: number; rows: Array<{ id: number; skuId: string; styleId: string; name: string; status: string; message: string; createdAt: string }> }>(`/finance/jst-maintenance/logs?${query}`);
  },
};
