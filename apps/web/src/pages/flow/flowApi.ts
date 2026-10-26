import type { FieldDef, FlowAction, StepDef } from '@kudesi/shared';
import { api } from '../../api/client';

export interface TemplateInfo { key: string; label: string; description: string; fields: FieldDef[]; stepFields: Record<string, FieldDef[]>; active: boolean; version: number | null }
export interface RunRow {
  id: number; templateKey: string; templateLabel: string; title: string; status: string; requesterName: string; stepName: string | null; handlers: string[];
  dueAt: string | null; createdAt: string; finishedAt: string | null; overdue: boolean;
}
export interface RunList { total: number; page: number; pageSize: number; rows: RunRow[] }
export interface TodoRow { id: number; kind: string; description: string | null; runId: number | null; title: string; stepName: string; enteredVia: string; templateLabel: string; runTitle: string; requesterName: string; dueAt: string | null; createdAt: string; finishedAt: string | null; overdue: boolean }
export interface TodoList { total: number; counts: { pending: number; overdue: number; returned: number; cc: number }; rows: TodoRow[] }
export interface RunStep {
  id: number; seq: number; key: string; name: string; type: string; status: string; action: FlowAction | null; comment: string | null; form: Record<string, unknown> | null;
  formRefLabels: Record<string, string>; enteredVia: string; enteredAt: string; finishedAt: string | null; dueAt: string | null; handledByName: string | null; recipients: string[];
}
export interface RunDetailDto {
  id: number; templateKey: string; templateLabel: string; title: string; status: string; revision: number; requesterId: number; requesterName: string; createdAt: string; finishedAt: string | null; dueAt: string | null;
  payload: Record<string, unknown>; refLabels: Record<string, string>; fields: FieldDef[]; stepFields: Record<string, FieldDef[]>;
  activeStep: { id: number; key: string; name: string; type: string; enteredVia: string; dueAt: string | null; recipients: Array<{ id: number; name: string }> } | null;
  steps: RunStep[]; events: Array<{ id: number; action: FlowAction; note: string | null; actorName: string; createdAt: string }>; ccs: Array<{ userId: number; name: string }>;
  links: { docId: number | null; docNo: string | null; borrowRecordId: number | null };
  me: { canPass: boolean; canReturn: boolean; canCancel: boolean; canReject: boolean; returnBlockedReason: string | null; cancelBlockedReason: string | null; canResubmit: boolean; canWithdraw: boolean; canTransfer: boolean; stepFields: FieldDef[] };
}
export interface DefinitionDto {
  template: { key: string; label: string; description: string; steps: StepDef[] };
  active: { version: number; steps: StepDef[]; escalateUserIds: number[] } | null;
  draft: { id: number | null; version: number; steps: StepDef[]; escalateUserIds: number[] };
  history: Array<{ version: number; status: string; publishedAt: string | null }>;
  names: Record<string, string>;
}
export interface AssignedRow { id: number; title: string; description: string | null; status: string; dueAt: string | null; createdAt: string; finishedAt: string | null; doneNote: string | null; assigneeName: string; overdue: boolean }
export interface RoutineDto { id: number; title: string; description: string | null; assigneeId: number; assigneeName: string; frequency: 'daily' | 'weekly' | 'monthly'; weekday: number | null; monthDay: number | null; dueDays: number; active: boolean }
export type RoutineBody = { title: string; description?: string; assigneeId: number; frequency: string; weekday?: number | null; monthDay?: number | null; dueDays: number; active?: boolean };
export interface NotificationDto { unread: number; items: Array<{ id: number; kind: string; title: string; body: string | null; link: string | null; createdAt: string; read: boolean }> }

const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== false) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};
const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body });

export const flowApi = {
  templates: () => api<TemplateInfo[]>('/flow/templates'),
  definition: (key: string) => api<DefinitionDto>(`/flow/definitions/${key}`),
  saveDraft: (key: string, steps: StepDef[], escalateUserIds: number[]) => api<{ ok: true }>(`/flow/definitions/${key}/draft`, { method: 'PUT', body: { steps, escalateUserIds } }),
  publish: (key: string) => post<{ ok: true; version: number }>(`/flow/definitions/${key}/publish`, {}),
  start: (templateKey: string, payload: Record<string, unknown>, requestKey: string) => post<RunDetailDto>('/flow/runs', { templateKey, payload, requestKey }),
  runs: (p: { view: 'started' | 'cc' | 'all'; status?: string; templateKey?: string; keyword?: string; overdue?: boolean; page?: number }) => api<RunList>(`/flow/runs${qs(p)}`),
  run: (id: number) => api<RunDetailDto>(`/flow/runs/${id}`),
  pass: (id: number, b: { revision: number; stepId: number; form?: Record<string, unknown>; comment?: string }) => post<RunDetailDto>(`/flow/runs/${id}/pass`, b),
  back: (id: number, b: { revision: number; stepId: number; reason: string }) => post<RunDetailDto>(`/flow/runs/${id}/return`, b),
  cancel: (id: number, b: { revision: number; stepId: number; reason: string }) => post<RunDetailDto>(`/flow/runs/${id}/cancel`, b),
  reject: (id: number, b: { revision: number; stepId: number; reason: string }) => post<RunDetailDto>(`/flow/runs/${id}/reject`, b),
  withdraw: (id: number, b: { revision: number; reason?: string }) => post<RunDetailDto>(`/flow/runs/${id}/withdraw`, b),
  resubmit: (id: number, b: { revision: number; payload: Record<string, unknown> }) => post<RunDetailDto>(`/flow/runs/${id}/resubmit`, b),
  transfer: (id: number, b: { revision: number; toUserId: number; reason: string }) => post<RunDetailDto>(`/flow/runs/${id}/transfer`, b),
  todos: (p: { tab: string; page?: number }) => api<TodoList>(`/flow/todos${qs(p)}`),
  notifications: (unread?: boolean) => api<NotificationDto>(`/flow/notifications${unread ? '?unread=1' : ''}`),
  createTask: (b: { title: string; description?: string; assigneeId?: number; dueDate?: string }) => post<{ id: number }>('/tasks', b),
  completeTask: (id: number, note?: string) => post<{ ok: true }>(`/tasks/${id}/complete`, { note }),
  cancelTask: (id: number) => post<{ ok: true }>(`/tasks/${id}/cancel`, {}),
  assigned: (p: { status?: string; page?: number }) => api<{ total: number; page: number; pageSize: number; rows: AssignedRow[] }>(`/tasks/assigned${qs(p)}`),
  routines: () => api<RoutineDto[]>('/tasks/routines'),
  saveRoutine: (id: number | null, b: RoutineBody) => (id ? api<{ id: number }>(`/tasks/routines/${id}`, { method: 'PUT', body: b }) : post<{ id: number }>('/tasks/routines', b)),
  setRoutineActive: (id: number, active: boolean) => post<{ ok: true }>(`/tasks/routines/${id}/active`, { active }),
  markRead: (ids?: number[]) => post<{ ok: true }>('/flow/notifications/read', ids ? { ids } : {}),
};

export const RUN_TONE: Record<string, string> = { running: 'warn', completed: 'ok', cancelled: '', rejected: 'bad' };
export const newRequestKey = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random().toString(16).slice(2)}`).replace(/-/g, '').slice(0, 32);
export const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-') : '');
