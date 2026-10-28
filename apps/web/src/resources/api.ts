import type { ColFilter, GridSaveRequest, GridSaveResponse, ResourceDef } from '@kudesi/shared';
import { api } from '../api/client';

export interface FileInfo {
  id: number;
  name: string;
  mime: string;
  size: number;
}

export interface ResourceDto {
  id: number;
  type: string;
  title: string;
  status: string;
  statusReason: string | null;
  archived?: { at: string; reason: string | null; by: number | null; fromStatus: string | null } | null;
  data: Record<string, unknown>;
  secretConfigured: Record<string, boolean>;
  refLabels: Record<string, string>;
  files: Record<number, FileInfo>;
  /** 仓库角色模式：精简列、只读 */
  warehouseMode?: boolean;
  createdAt: string;
  updatedAt: string;
  /** 内容版本，表格编辑保存时用来发现别人改过 */
  version?: string;
}

export interface ListResult {
  items: ResourceDto[];
  total: number;
  page: number;
  pageSize: number;
  tabCounts?: Record<string, number>;
  archivedCount?: number;
}

export interface ListParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: string;
  tab?: string;
  showHidden?: boolean;
  archived?: boolean;
  expiring?: boolean;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  fieldKey?: string;
  fieldValue?: string | number;
  filters?: Record<string, string>;
  /** 列筛选（服务端筛，分页总数是筛选后的） */
  colFilters?: ColFilter[];
}

export interface CategoryTreeResult {
  field: string;
  total: number;
  uncategorized: number;
  nodes: Array<{ id: number; title: string; status: string; parentId: number; sort: number; count: number }>;
}

export interface ImportBackupInfo { id: number; recordCount: number; createdAt: string; restoredAt: string | null }

export interface ImportResult {
  dryRun: boolean;
  committed: boolean;
  created: number;
  updated: number;
  failed: number;
  results: Array<{ line: number; action: 'create' | 'update' | 'error'; title?: string; errors: string[]; warnings?: string[] }>;
}

export interface Relation {
  direction: 'out' | 'in';
  relation: string;
  type: string;
  id: number;
  title: string;
  linkId?: number;
  validFrom?: string | null;
  validTo?: string | null;
  purpose?: string | null;
  relationKind?: string | null;
}

export interface LogEntry {
  id: string;
  action: string;
  actor: string;
  note: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  createdAt: string;
}

export interface OverviewResult {
  items: Array<{ type: string; label: string; total: number; abnormal: number; inactive?: number; archived?: number }>;
}

export interface ExpiringResult {
  today: string;
  days: number;
  total: number;
  counts: { expired: number; dueSoon: number };
  rows: Array<{ type: string; typeLabel: string; id: number; name: string; field: string; fieldLabel: string; dueDate: string; daysLeft: number; status: 'expired' | 'due_soon'; resourceStatus: string }>;
}

export function query(params: ListParams): string {
  const q = new URLSearchParams();
  if (params.page) q.set('page', String(params.page));
  if (params.pageSize) q.set('pageSize', String(params.pageSize));
  if (params.keyword) q.set('keyword', params.keyword);
  if (params.status) q.set('status', params.status);
  if (params.tab) q.set('tab', params.tab);
  if (params.showHidden) q.set('showHidden', '1');
  if (params.archived) q.set('archived', '1');
  if (params.expiring) q.set('expiring', '1');
  if (params.sortBy) { q.set('sortBy', params.sortBy); q.set('sortDir', params.sortDir ?? 'desc'); }
  if (params.fieldKey) q.set('fieldKey', params.fieldKey);
  if (params.fieldValue !== undefined) q.set('fieldValue', String(params.fieldValue));
  if (params.filters && Object.keys(params.filters).length) q.set('filters', JSON.stringify(params.filters));
  if (params.colFilters?.length) q.set('colFilters', JSON.stringify(params.colFilters));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const resourceApi = {
  similarCheck: (type: string, values: Record<string, unknown>, excludeId?: number) =>
    api<{ blocked: Array<{ text: string }>; warnings: Array<{ text: string }> }>(`/resources/${type}/similar-check`, { method: 'POST', body: { values, excludeId } }),
  batch: (type: string, ids: number[], values: Record<string, unknown>) =>
    api<{ done: number; failed: Array<{ id: number; message: string }> }>(`/resources/${type}/batch`, { method: 'POST', body: { ids, values } }),
  batchAction: (type: string, ids: number[], action: string, value: unknown, reason?: string) =>
    api<{ done: number; failed: Array<{ id: number; message: string }> }>(`/resources/${type}/batch`, { method: 'POST', body: { ids, action, value, reason } }),
  batchStatus: (type: string, ids: number[], status: string, reason?: string) =>
    api<{ done: number; failed: Array<{ id: number; message: string }> }>(`/resources/${type}/batch-status`, { method: 'POST', body: { ids, status, reason } }),
  categoryTree: (type: string, p: { field: string; tab?: string; status?: string; showHidden?: boolean }) => {
    const q = new URLSearchParams({ field: p.field });
    if (p.tab) q.set('tab', p.tab);
    if (p.status) q.set('status', p.status);
    if (p.showHidden) q.set('showHidden', '1');
    return api<CategoryTreeResult>(`/resources/${type}/category-tree?${q}`);
  },
  /** 单选列 / 状态列筛选浮层里各值的数量（按其它列的条件） */
  columnFacets: (type: string, key: string, colFilters: ColFilter[], opts: { showHidden?: boolean; archived?: boolean } = {}) => {
    const q = new URLSearchParams({ key });
    if (colFilters.length) q.set('colFilters', JSON.stringify(colFilters));
    if (opts.showHidden) q.set('showHidden', '1');
    if (opts.archived) q.set('archived', '1');
    return api<{ items: Array<{ value: string; count: number }> }>(`/resources/${type}/column-facets?${q.toString()}`);
  },
  gridSave: (type: string, body: GridSaveRequest) => api<GridSaveResponse<ResourceDto>>(`/resources/${type}/grid-save`, { method: 'POST', body }),
  list: (type: string, params: ListParams) => api<ListResult>(`/resources/${type}${query(params)}`),
  get: (type: string, id: number) => api<ResourceDto>(`/resources/${type}/${id}`),
  create: (type: string, values: Record<string, unknown>, status?: string) =>
    api<ResourceDto>(`/resources/${type}`, { method: 'POST', body: { values, status } }),
  update: (type: string, id: number, values: Record<string, unknown>) =>
    api<ResourceDto>(`/resources/${type}/${id}`, { method: 'PATCH', body: { values } }),
  changeStatus: (type: string, id: number, status: string, reason?: string) =>
    api<ResourceDto>(`/resources/${type}/${id}/status`, { method: 'POST', body: { status, reason } }),
  remove: (type: string, id: number, reason: string) =>
    api<{ ok: true }>(`/resources/${type}/${id}`, { method: 'DELETE', body: { reason } }),
  restore: (type: string, id: number, reason: string) =>
    api<ResourceDto>(`/resources/${type}/${id}/restore`, { method: 'POST', body: { reason } }),
  reveal: (type: string, id: number, field: string) => api<{ field: string; value: string }>(`/resources/${type}/${id}/secret/${field}`),
  logs: (type: string, id: number) => api<LogEntry[]>(`/resources/${type}/${id}/logs`),
  addLink: (type: string, id: number, targetType: string, targetId: number, props: { purpose?: string; validFrom?: string; validTo?: string; relationKind?: string } = {}) =>
    api<{ ok: true }>(`/resources/${type}/${id}/links`, { method: 'POST', body: { targetType, targetId, ...props } }),
  updateLink: (type: string, id: number, linkId: number, props: { purpose?: string; validFrom?: string; validTo?: string; relationKind?: string }) =>
    api<{ ok: true }>(`/resources/${type}/${id}/links/${linkId}`, { method: 'PATCH', body: props }),
  removeLink: (type: string, id: number, linkId: number) => api<{ ok: true }>(`/resources/${type}/${id}/links/${linkId}`, { method: 'DELETE' }),
  warehousePhotos: (id: number, fileIds: number[]) => api<ResourceDto>(`/resources/finance-products/${id}/warehouse-photos`, { method: 'POST', body: { fileIds } }),
  relations: (type: string, id: number) => api<Relation[]>(`/resources/${type}/${id}/relations`),
  overview: () => api<OverviewResult>('/resources/overview'),
  createPhone: (type: string, id: number) => api<{ created: boolean; number: string; phoneId: number }>(`/resources/${type}/${id}/create-phone`, { method: 'POST', body: {} }),
  dataIssues: () => api<DataIssuesResult>('/resources/data-issues'),
  recentChanges: () => api<RecentChange[]>('/resources/recent-changes'),
  expiring: (days: number) => api<ExpiringResult>(`/resources/expiring?days=${days}`),
  /** scope：不传=全部；传筛选条件=当前筛选结果；ids=所选 */
  export: (type: string, includeHidden: boolean, scope: ListParams & { ids?: number[]; cols?: string[] } = {}) => {
    const q = new URLSearchParams(query({ ...scope, page: undefined, pageSize: undefined, showHidden: undefined }).replace(/^\?/, ''));
    if (includeHidden) q.set('includeHidden', '1');
    if (scope.ids?.length) q.set('ids', scope.ids.join(','));
    if (scope.cols?.length) q.set('cols', scope.cols.join(','));
    const qs = q.toString();
    return api<{ filename: string; csv: string; count: number }>(`/resources/${type}/export${qs ? `?${qs}` : ''}`);
  },
  importBackups: (type: string) => api<ImportBackupInfo[]>(`/resources/${type}/import-backups`),
  restoreBackup: (type: string, id: number) => api<{ restored: number; removed: number; skippedDelete: number }>(`/resources/${type}/import-backups/${id}/restore`, { method: 'POST' }),
  import: (type: string, rows: Array<Record<string, string>>, dryRun: boolean, partial = false) =>
    api<ImportResult>(`/resources/${type}/import`, { method: 'POST', body: { rows, dryRun, partial } }),
  uploadFile: (type: string, field: string, file: File) => {
    const form = new FormData();
    form.append('type', type);
    form.append('field', field);
    form.append('file', file);
    return api<FileInfo>('/files/upload', { form });
  },
  fileUrl: (id: number) => api<{ url: string; name: string; mime: string }>(`/files/${id}/url`),
  recognizeLicense: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api<{ fields: Record<string, string>; warnings: string[]; rawText: string }>('/ocr/license', { form });
  },
  licenseRevenue: (id: number, from: string, to: string) => api<RevenueResult>(`/revenue/licenses/${id}?from=${from}&to=${to}`),
  departments: () => api<Array<{ id: number; name: string; parentId?: number | null }>>('/org/department-directory'),
  users: () => api<Array<{ id: number; name: string; active: boolean }>>('/org/users'),
};

/** 手机扫码上传：电脑端发起并轮询；手机端（免登录）只认令牌 */
export interface PhoneSession { id: number; token: string; expiresAt: string; minutes: number; maxUploads: number }
export interface PhoneStatus { scanned: boolean; uploaded: number; expired: boolean; expiresAt: string; files: FileInfo[] }
export const phoneUploadApi = {
  create: (type: string, field: string) => api<PhoneSession>('/phone-uploads', { method: 'POST', body: { type, field } }),
  status: (id: number) => api<PhoneStatus>(`/phone-uploads/${id}`),
  inspect: (token: string) => api<{ label: string; resource: string; remaining: number; expiresAt: string }>('/phone-uploads/public/inspect', { method: 'POST', body: { token } }),
  upload: (token: string, file: File) => {
    const form = new FormData();
    form.append('token', token);
    form.append('file', file);
    return api<{ ok: true; remaining: number }>('/phone-uploads/public/upload', { form });
  },
};

/** 表单草稿（每人每个标识一份，存在服务器上，换电脑也能接着填） */
export const draftApi = {
  key: (moduleKey: string, parts: string[] = []) =>
    [moduleKey, ...parts].map((v) => encodeURIComponent(String(v ?? '').trim() || '_')).join(':').slice(0, 190),
  get: (key: string) => api<{ draft: { payload: Record<string, unknown>; title: string; updatedAt: string } | null }>(`/form-drafts/${encodeURIComponent(key)}`),
  save: (key: string, body: { moduleKey: string; title: string; payload: Record<string, unknown> }) =>
    api<unknown>(`/form-drafts/${encodeURIComponent(key)}`, { method: 'PUT', body }),
  remove: (key: string) => api<unknown>(`/form-drafts/${encodeURIComponent(key)}`, { method: 'DELETE' }),
};

export type { ResourceDef };

export interface IntegrationOverview {
  zones: Array<{ value: string; label: string }>;
  qiniu: { configured: boolean; accessKey: string; secretKeyConfigured: boolean; bucket: string; zone: string; domain: string; isPrivate: boolean };
  vision: { configured: boolean; baseUrl: string; apiKeyConfigured: boolean; model: string; enabled: boolean };
}

export interface AssetDetails {
  operationLogs: Array<{ id: string; action: string; label: string | null; actor: string; note: string | null; createdAt: string }>;
  storageSpaces: Array<{ id: number; title: string; parentId: number | null; status: string; locationType: string | null }>;
  archiveItems: Array<{ id: number; title: string; archiveNo: string | null; status: string; locationId: number }>;
}
export interface LocationContentGroup {
  type: string;
  typeLabel: string;
  items: Array<{ id: number; title: string; status: string; statusLabel: string; slots: string[] }>;
}

/** 固定资产流转/盘点、位置存放内容 */
export const assetApi = {
  transition: (id: number, body: { action: string; userId?: number | null; locationId?: number | null; reason?: string; note?: string }) =>
    api<ResourceDto>(`/resources/fixed-assets/${id}/transition`, { method: 'POST', body }),
  inventory: (items: Array<{ id: number; result: string; locationId?: number | null }>, note: string) =>
    api<{ ok: true; present: number; moved: number; missing: number; skipped: number[] }>('/resources/fixed-assets/inventory', { method: 'POST', body: { items, note } }),
  details: (id: number) => api<AssetDetails>(`/resources/fixed-assets/${id}/asset-details`),
  locationContents: (id: number) => api<LocationContentGroup[]>(`/resources/locations/${id}/contents`),
};

export const settingsApi = {
  overview: () => api<IntegrationOverview>('/settings/integrations'),
  saveQiniu: (body: { accessKey: string; secretKey?: string; bucket: string; zone: string; domain: string; isPrivate: boolean }) =>
    api<IntegrationOverview>('/settings/integrations/qiniu', { method: 'PUT', body }),
  saveVision: (body: { baseUrl: string; apiKey?: string; model: string; enabled: boolean }) =>
    api<IntegrationOverview>('/settings/integrations/vision', { method: 'PUT', body }),
  testQiniu: () => api<{ ok: boolean; message: string }>('/settings/integrations/qiniu/test', { method: 'POST', body: {} }),
  testVision: () => api<{ ok: boolean; message: string }>('/settings/integrations/vision/test', { method: 'POST', body: {} }),
};

export interface RevenueTotals { sales: number; refund: number; adCost: number; platformFee: number; purchaseCost: number; otherCost: number; profit: number; orders: number; days: number }
export interface RevenueResult { licenseId: number; licenseTitle: string; from: string; to: string; stores: Array<{ storeId: number; name: string } & RevenueTotals>; total: RevenueTotals }

export interface RecentChange { id: string; type: string; typeLabel: string; resourceId: number; name: string; action: string; note: string | null; actor: string; createdAt: string }

export interface DataIssuesResult {
  total: number;
  groups: Array<{ key: string; label: string; description: string; resourceType: string; count: number; rows: Array<{ id: number; type: string; name: string; detail: string }> }>;
}
