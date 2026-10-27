import type { CaseStage, ServiceSummary, SupervisionRuleDef } from '@kudesi/shared';
import { api } from '../../api/client';

export interface FileInfo { id: number; name: string; mime: string; size: number }
export interface LogRow { id: number; kind: string; content: string; userName: string; createdAt: string }
interface Common {
  id: number; runId: number; storeId: number; storeName: string; orderNo: string; amountCents: number; reason: string; createdAt: string; finishedAt: string | null; createdByName: string;
  stage: CaseStage; open: boolean; dueAt: string | null; overdue: boolean; returnedBack: boolean; handlers: string[]; stepName: string | null;
}
export interface CaseRow extends Common { caseNo: string; buyerName: string | null; caseType: string; refundCents: number | null; attachmentCount: number }
export interface CaseDetailDto extends CaseRow {
  resolution: string | null; dueDate: string | null; source: string; supervisors: string[]; files: FileInfo[]; logs: LogRow[];
  sameOrder: Array<{ id: number; caseNo: string; caseType: string; amountCents: number; stage: CaseStage; createdAt: string }>;
}
export interface CaseStats { open: number; late: number; soon: number; done: number; total: number; openAmountCents: number; lateAmountCents: number }
export interface CaseList { total: number; page: number; pageSize: number; stats: CaseStats; rows: CaseRow[] }
export interface StoreOption { id: number; name: string; status: string; platform: string | null; claimStatus?: string | null; operatorName: string }

export interface AppealRow extends Common {
  appealNo: string; appealType: string; deadlineAt: string | null; platformAppealNo: string | null; result: 'approved' | 'rejected' | null; resultNote: string | null; parentId: number | null; evidenceCount: number; canReconsider: boolean;
}
export interface AppealDetailDto extends AppealRow {
  submittedAt: string | null; source: string; supervisors: string[]; files: FileInfo[]; logs: LogRow[];
  sameOrder: Array<{ id: number; appealNo: string; appealType: string; result: string | null; stage: CaseStage; createdAt: string }>;
}
export interface AppealStats { open: number; late: number; soon: number; toSubmit: number; awaiting: number; monthReconsider: number; canReconsider: number; openAmountCents: number }
export interface AppealList { total: number; page: number; pageSize: number; stats: AppealStats; rows: AppealRow[] }
export interface AppealStore extends StoreOption { storeNo: string | null; open: number; late: number }

export interface ExceptionRow {
  id: number; sourceType: string; sourceId: number | null; runId: number | null; title: string; detail: string | null; severity: 'urgent' | 'important' | 'normal'; status: string; level: number;
  ownerId: number | null; ownerName: string; storeName: string; dueAt: string | null; createdAt: string; escalatedAt: string | null; closeReason: string | null; closedByName: string; closedAt: string | null; canClose: boolean;
}
export interface SupervisionOverview {
  asOf: string; summary: ServiceSummary; exceptions: ExceptionRow[]; closed: ExceptionRow[];
  people: Array<{ id: number; name: string; title: string | null; status: string; pending: number; overdue: number; exceptions: number }>;
  assignmentAlerts: Array<{ id: number; kind: string; runId: number | null; title: string; ownerName: string; dueAt: string | null }>;
  rules: SupervisionRuleDef[]; canManage: boolean;
}

const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== false) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};
const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body });

async function uploadTo(path: string, file: File): Promise<FileInfo> {
  const form = new FormData();
  form.set('file', file);
  return api<FileInfo>(path, { method: 'POST', form });
}

export interface CaseInput { storeId: number; orderNo: string; buyerName?: string; caseType: string; amountCents: number; reason: string; dueDate?: string; requestKey: string }
export interface AppealInput { storeId: number; appealType: string; orderNo: string; amountCents: number; reason: string; deadlineDate?: string; parentId?: number; requestKey: string }

export const serviceApi = {
  asStores: () => api<StoreOption[]>('/after-sales/stores'),
  asList: (p: { filter?: string; keyword?: string; storeId?: number; caseType?: string; mine?: boolean; page?: number; pageSize?: number }) => api<CaseList>(`/after-sales${qs({ ...p, mine: p.mine ? '1' : undefined })}`),
  asCreate: (b: CaseInput) => post<{ id: number; runId: number }>('/after-sales', b),
  asDetail: (id: number) => api<CaseDetailDto>(`/after-sales/${id}`),
  asLog: (id: number, content: string, kind: 'note' | 'urge') => post<{ ok: true }>(`/after-sales/${id}/logs`, { content, kind }),
  asUpload: (id: number, file: File) => uploadTo(`/after-sales/${id}/files`, file),
  asRemoveFile: (id: number, fileId: number) => api<{ ok: true }>(`/after-sales/${id}/files/${fileId}`, { method: 'DELETE' }),
  asFileUrl: (id: number, fileId: number) => api<{ url: string; name: string; mime: string }>(`/after-sales/${id}/files/${fileId}/url`),

  apStores: () => api<AppealStore[]>('/appeals/stores'),
  apList: (p: { storeId?: number; type?: string; status?: string; keyword?: string; page?: number; pageSize?: number }) => api<AppealList>(`/appeals${qs(p)}`),
  apCreate: (b: AppealInput) => post<{ id: number; runId: number }>('/appeals', b),
  apDetail: (id: number) => api<AppealDetailDto>(`/appeals/${id}`),
  apLog: (id: number, content: string, kind: 'note' | 'urge') => post<{ ok: true }>(`/appeals/${id}/logs`, { content, kind }),
  apUpload: (id: number, file: File) => uploadTo(`/appeals/${id}/files`, file),
  apRemoveFile: (id: number, fileId: number) => api<{ ok: true }>(`/appeals/${id}/files/${fileId}`, { method: 'DELETE' }),
  apFileUrl: (id: number, fileId: number) => api<{ url: string; name: string; mime: string }>(`/appeals/${id}/files/${fileId}/url`),

  supervision: () => api<SupervisionOverview>('/supervision'),
  supSummary: () => api<ServiceSummary>('/supervision/summary'),
  supScan: () => post<{ created: number; escalated: number; resolved: number }>('/supervision/scan', {}),
  supRegister: (b: { title: string; detail?: string; severity: string; ownerId?: number; storeId?: number }) => post<{ id: number }>('/supervision/exceptions', b),
  supDetail: (id: number) => api<{ logs: LogRow[] }>(`/supervision/exceptions/${id}`),
  supClose: (id: number, reason: string) => post<{ ok: true }>(`/supervision/exceptions/${id}/close`, { reason }),
  supFollow: (id: number, content: string) => post<{ ok: true }>(`/supervision/exceptions/${id}/logs`, { content }),
  supSaveRule: (target: string, b: Partial<Omit<SupervisionRuleDef, 'targetType' | 'name'>>) => api<{ ok: true }>(`/supervision/rules/${target}`, { method: 'PUT', body: b }),
};
