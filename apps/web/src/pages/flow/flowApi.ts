import type {SkuInspection} from './SkuInspectionView';
import type { FieldDef, FlowAction } from '@kudesi/shared';
import { api } from '../../api/client';

export interface FlowConfirmation{token:string;confirmed:boolean;reason:string}
export interface TemplateInfo { key: string; label: string; description: string; fields: FieldDef[]; stepFields: Record<string, FieldDef[]>; active: boolean; version: number | null; custom?: boolean; steps?: Array<{ name: string; type: string }>; startable?: boolean }
export interface RunRow {
  id: number; templateKey: string; templateLabel: string; title: string; status: string; requesterName: string; stepName: string | null; handlers: string[];
  canDelete?:boolean;batchRef?:string;specCount?:number;completedSpecs?:number;progress?:Array<{name:string;handlers:string[];count:number;returned:boolean}>;
  dueAt: string | null; createdAt: string; finishedAt: string | null; overdue: boolean; stepEnteredAt?: string | null;
}
export interface RunList { total: number; page: number; pageSize: number; rows: RunRow[] }
export interface TodoRow { storeId?: number | null; storeName?: string | null; id: number; kind: string; description: string | null; runId: number | null; title: string; stepName: string; enteredVia: string; templateLabel: string; runTitle: string; requesterName: string; dueAt: string | null; createdAt: string; finishedAt: string | null; overdue: boolean; feedbackPreset?: string | null; completionStandard?: string | null; requiresReview?: number | boolean; reviewNote?: string | null; status?: string; batchKey?: string | null; batchName?: string | null; batchCount?: number }
export interface TodoList { total: number; counts: { pending: number; overdue: number; returned: number; cc: number; taskReview?: number }; rows: TodoRow[] }
export interface RunStep {
  id: number; seq: number; key: string; name: string; type: string; status: string; action: FlowAction | null; comment: string | null; form: Record<string, unknown> | null;
  formRefLabels: Record<string, string>; enteredVia: string; enteredAt: string; finishedAt: string | null; dueAt: string | null; handledByName: string | null; recipients: string[];
}
export interface RunDetailDto {
  syncIntents?:Array<{bundleId:number;state:string}>;
  inspection?:SkuInspection;
  stepDraft?:{canSave:boolean;stepId:number;form:Record<string,unknown>};
  historicalTasks?:Array<{id:number;sourceTaskId:string;stepId:number;title:string;status:string;createdAt:string;dueAt:string|null;finishedAt:string|null;submittedAt:string|null;doneNote:string|null;completionStandard:string|null;assigneeName:string;supervisorName:string|null}>;
  legacyHistory?:{sourceRunId:string;status:string;itemStatus?:string;createdAt:string|null;request?:{fields:FieldDef[];values:Record<string,unknown>};steps:Array<{stepId:number;sourceRecordId:string;name:string;comment:string|null;enteredAt:string|null;finishedAt:string|null;fields:FieldDef[];values:Record<string,unknown>}>};
  initialForm?: Record<string, unknown>;
  id: number; templateKey: string; templateLabel: string; title: string; status: string; revision: number; requesterId: number; requesterName: string; createdAt: string; finishedAt: string | null; dueAt: string | null;
  payload: Record<string, unknown>; refLabels: Record<string, string>; fields: FieldDef[]; stepFields: Record<string, FieldDef[]>; files?: Record<number, { id: number; name: string; mime: string; size: number }>;
  activeSteps?: Array<{ id: number; key: string; name: string; recipients: Array<{ id: number; name: string }>; dueAt: string | null }>;
  activeStep: { id: number; key: string; name: string; type: string; enteredVia: string; dueAt: string | null; recipients: Array<{ id: number; name: string }> } | null;
  steps: RunStep[]; events: Array<{ id: number; action: FlowAction|'legacy'; note: string | null; actorName: string; createdAt: string }>; ccs: Array<{ userId: number; name: string }>;
  links: { ledgerHistoryId?: number; docId: number | null; docNo: string | null; borrowRecordId: number | null };
  me: { canPass: boolean; canReturn: boolean; canCancel: boolean; canReject: boolean; returnBlockedReason: string | null; cancelBlockedReason: string | null; canResubmit: boolean; canWithdraw: boolean; canTransfer: boolean; canAbnormal?: boolean; stepFields: FieldDef[] };
}
export interface AssignedRow { storeId?: number | null; storeName?: string | null; id: number; title: string; description: string | null; status: string; dueAt: string | null; createdAt: string; finishedAt: string | null; doneNote: string | null; assigneeName: string; overdue: boolean;
  assigneeId?: number; supervisorId?: number | null; supervisorName?: string | null; creatorName?: string | null; requiresReview?: boolean; feedbackPreset?: string | null; completionStandard?: string | null;
  submitPayload?: Record<string, unknown> | null; submittedAt?: string | null; reviewNote?: string | null; stage?: string; isAbnormal?: boolean; delayId?: number | null; delayDueAt?: string | null; delayReason?: string | null }
export interface TaskBody { title: string; description?: string; assigneeId?: number; dueDate?: string; supervisorId?: number; requiresReview?: boolean; feedbackPreset?: string; completionStandard?: string }
export interface RoutineDto { supervisorId?: number | null; requiresReview?: boolean; feedbackPreset?: string | null; completionStandard?: string | null; id: number; title: string; description: string | null; assigneeId: number; assigneeName: string; frequency: 'daily' | 'weekly' | 'monthly'; weekday: number | null; monthDay: number | null; dueDays: number; active: boolean }
export type RoutineBody = { supervisorId?: number | null; requiresReview?: boolean; feedbackPreset?: string | null; completionStandard?: string | null; title: string; description?: string; assigneeId: number; frequency: string; weekday?: number | null; monthDay?: number | null; dueDays: number; active?: boolean };
export interface NotificationDto { unread: number; items: Array<{ id: number; kind: string; title: string; body: string | null; link: string | null; createdAt: string; read: boolean }> }

export interface ApplicationDraftTemplate {id:number;version:number;status:string;label:string;steps:Array<{key:string;name:string;type:string;handlerName:string}>;issues:string[]}
export interface ApplicationHeader {canDelete?:boolean;batchKey:string;title:string;requesterId:number;definitionId:number;definitionVersion:number;headerVersion:string;shared:Record<string,unknown>;steps:Array<{key:string;name:string;type:string;handlerName?:string}>;createdAt:string;canAdd:boolean}
export interface ApplicationDraftResult {batchKey:string;headerVersion:string;runs:Array<{id:number;revision:number}>}
export interface DraftReference {id:number;code:string;name:string;spec:string;clear:boolean;restrictedUsage:boolean;successful:Array<{id:number;code:string;name:string}>;inProgress:Array<{runId:number;itemId:string;batchRef:string;title:string;specName:string;status:string;requesterName:string;createdAt:string;nodeName:string;ownerName:string;matchedLines:Array<{role:string;quantity:number}>}>}
const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== false) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};
const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body });

export const flowApi = {
  applicationDraftTemplates:(key:string)=>api<{templates:ApplicationDraftTemplate[]}>(`/flow/application-drafts/templates/${encodeURIComponent(key)}`),
  createApplicationDrafts:(body:{templateKey:string;definitionId:number;requestKey:string;confirmations:Record<string,boolean>;payloads:Record<string,unknown>[]})=>post<ApplicationDraftResult>('/flow/runs/drafts',body),
  applicationDraftHeader:(key:string,ref:string)=>api<ApplicationHeader>(`/flow/application-drafts/${encodeURIComponent(key)}/${encodeURIComponent(ref)}`),
  addApplicationDrafts:(key:string,ref:string,body:{headerVersion:string;requestKey:string;payloads:Record<string,unknown>[]})=>post<ApplicationDraftResult>(`/flow/application-drafts/${encodeURIComponent(key)}/${encodeURIComponent(ref)}/items`,body),
  saveApplicationDraft:(id:number,body:{revision:number;payload:Record<string,unknown>})=>api<RunDetailDto>(`/flow/runs/${id}/draft`,{method:'PUT',body}),
  saveApplicationDraftShared:(key:string,ref:string,body:{headerVersion:string;expected:Array<{id:number;revision:number}>;payload:Record<string,unknown>})=>api<{ok:true;headerVersion:string}>(`/flow/application-drafts/${encodeURIComponent(key)}/${encodeURIComponent(ref)}/shared`,{method:'PUT',body}),
  submitApplicationDrafts:(key:string,ref:string,body:{requestKey:string;comment?:string;items:Array<{id:number;revision:number;confirmation?:FlowConfirmation}>})=>post<{ref:string;ok:number;failed:number;results:Array<{runId:number;ok:boolean;message?:string}>}>(`/flow/application-drafts/${encodeURIComponent(key)}/${encodeURIComponent(ref)}/submit`,body),
  removeApplicationDraft:(id:number,revision:number,reason:string)=>api<{ok:true;headerVersion:string}>(`/flow/runs/${id}/draft`,{method:'DELETE',body:{revision,reason}}),
  removeApplicationDraftBatch:(key:string,ref:string,body:{headerVersion:string;expected:Array<{id:number;revision:number}>;reason:string})=>api<{ok:true}>(`/flow/application-drafts/${encodeURIComponent(key)}/${encodeURIComponent(ref)}`,{method:'DELETE',body}),

  templates: () => api<TemplateInfo[]>('/flow/templates'),
  start: (templateKey: string, payload: Record<string, unknown>, requestKey: string) => post<RunDetailDto>('/flow/runs', { templateKey, payload, requestKey }),
  runs: (p: { groupSku?:boolean; view: 'started' | 'cc' | 'all'; status?: string; templateKey?: string; keyword?: string; overdue?: boolean; departmentId?: number; handler?: string; returned?: boolean; page?: number; pageSize?: number }) => api<RunList>(`/flow/runs${qs(p)}`),
  run: (id: number) => api<RunDetailDto>(`/flow/runs/${id}`),
  saveStepDraft:(id:number,body:{revision:number;stepId:number;form:Record<string,unknown>;draftContext?:Record<string,unknown>})=>api<RunDetailDto>(`/flow/runs/${id}/step-draft`,{method:'PUT',body}),
  pass: (id: number, b: { revision: number; stepId: number; form?: Record<string, unknown>; comment?: string }) => post<RunDetailDto>(`/flow/runs/${id}/pass`, b),
  back: (id: number, b: { revision: number; stepId: number; reason: string }) => post<RunDetailDto>(`/flow/runs/${id}/return`, b),
  abnormal: (id: number, b: { revision: number; stepId: number; reason: string }) => post<RunDetailDto>(`/flow/runs/${id}/abnormal`, b),
  cancel: (id: number, b: { revision: number; stepId: number; reason: string }) => post<RunDetailDto>(`/flow/runs/${id}/cancel`, b),
  reject: (id: number, b: { revision: number; stepId: number; reason: string }) => post<RunDetailDto>(`/flow/runs/${id}/reject`, b),
  withdraw: (id: number, b: { revision: number; reason?: string }) => post<RunDetailDto>(`/flow/runs/${id}/withdraw`, b),
  resubmit: (id: number, b: { revision: number; payload: Record<string, unknown> }) => post<RunDetailDto>(`/flow/runs/${id}/resubmit`, b),
  transfer: (id: number, b: { revision: number; toUserId: number; reason: string }) => post<RunDetailDto>(`/flow/runs/${id}/transfer`, b),
  todos: (p: { tab: string; keyword?: string; page?: number }) => api<TodoList>(`/flow/todos${qs(p)}`),
  notifications: (unread?: boolean) => api<NotificationDto>(`/flow/notifications${unread ? '?unread=1' : ''}`),
  createTask: (b: TaskBody) => post<{ id: number }>('/tasks', b),
  completeTask: (id: number, note?: string, extra: { payload?: Record<string, unknown>; abnormal?: boolean } = {}) => post<{ ok: true; status?: string }>(`/tasks/${id}/complete`, { note, ...extra }),
  supervised: (p: { status?: string; page?: number }) => api<{ total: number; page: number; pageSize: number; rows: AssignedRow[] }>(`/tasks/supervised${qs(p)}`),
  reviewCounts: () => api<{ review: number; delay: number }>('/tasks/review-counts'),
  reviewTask: (id: number, action: 'approve' | 'return', comment?: string) => post<{ ok: true }>(`/tasks/${id}/review`, { action, comment }),
  delayTask: (id: number, dueDate: string, reason: string) => post<{ id: number }>(`/tasks/${id}/delay`, { dueDate, reason }),
  decideDelay: (id: number, approve: boolean, comment?: string) => post<{ ok: true }>(`/tasks/delays/${id}/decide`, { approve, comment }),
  cancelTask: (id: number) => post<{ ok: true }>(`/tasks/${id}/cancel`, {}),
  assigned: (p: { status?: string; page?: number }) => api<{ total: number; page: number; pageSize: number; rows: AssignedRow[] }>(`/tasks/assigned${qs(p)}`),
  routines: () => api<RoutineDto[]>('/tasks/routines'),
  saveRoutine: (id: number | null, b: RoutineBody) => (id ? api<{ id: number }>(`/tasks/routines/${id}`, { method: 'PUT', body: b }) : post<{ id: number }>('/tasks/routines', b)),
  setRoutineActive: (id: number, active: boolean) => post<{ ok: true }>(`/tasks/routines/${id}/active`, { active }),
  reassign: (b: { fromUserId: number; toUserId: number; templateKey?: string; stepKey?: string; reason: string; dryRun?: boolean }) => post<ReassignResult>('/flow/reassign', b),
  markRead: (ids?: number[]) => post<{ ok: true }>('/flow/notifications/read', ids ? { ids } : {}),
};

export interface ReassignResult { count?: number; items?: Array<{ runId: number; title: string; stepName: string; templateLabel: string }>; moved?: number; skipped?: Array<{ runId: number; message: string }> }

export const RUN_TONE: Record<string, string> = { running: 'warn', completed: 'ok', cancelled: '', rejected: 'bad' };
export const newRequestKey = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random().toString(16).slice(2)}`).replace(/-/g, '').slice(0, 32);
export const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-') : '');
