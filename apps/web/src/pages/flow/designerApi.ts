import type { CustomSchema, FieldDef, NodeTemplate, StepDef, TimeoutPolicy, TimeoutNotifications, TimeoutPenalty } from '@kudesi/shared';
import { api } from '../../api/client';

export interface DirectoryRow {
  key: string; label: string; description: string; custom: boolean; kind: string;
  departmentId: number | null; departmentName: string;
  status: 'active' | 'inactive'; version: number | null; hasDraft: boolean; everPublished: boolean;
  stepCount: number; issues: string[]; runCount: number; runningCount: number; updatedAt: string | null;
}
export interface DirectoryDto { templates: DirectoryRow[]; canManage: boolean }

export interface DesignerSchema { fields: FieldDef[]; stepFields: Record<string, FieldDef[]>; posting: CustomSchema['posting'] }
export interface DesignerVersion { id: number | null; version: number; status: string; steps: StepDef[]; escalateUserIds: number[]; publishedAt: string | null; createdAt: string | null; schema: DesignerSchema | null }
export interface DesignerDefinition {
  template: { key: string; label: string; description: string; steps: StepDef[]; custom: boolean; departmentId: number | null; fields: FieldDef[]; stepFields: Record<string, FieldDef[]>; posting: CustomSchema['posting'] | null };
  active: DesignerVersion | null;
  draft: DesignerVersion;
  history: Array<{ version: number; status: string; publishedAt: string | null; stepCount: number }>;
  names: Record<string, string>;
}

export type NodeTemplateDto = NodeTemplate & { revision: number };
export interface NodeCenterDto {
  templates: NodeTemplateDto[];
  business: Array<{ key: string; name: string; flowLabel: string; type: string; dueMinutes: number | null; fields: FieldDef[] }>;
  categories: string[]; canManage: boolean;
}

export interface PolicyDto {
  policy: Partial<TimeoutPolicy>;
  effective: { policy: { notifications: TimeoutNotifications; penalties: TimeoutPenalty }; sources: { notifications: string; penalties: string } };
  inherited: { policy: { notifications: TimeoutNotifications; penalties: TimeoutPenalty }; sources: { notifications: string; penalties: string } };
  revision: number; overrides: Array<{ templateKey: string; nodeKey: string }>; canManage: boolean;
}
export interface LedgerRow {
  id: number; runId: number; templateKey: string; templateLabel: string; stepKey: string; assigneeId: number; assigneeName: string; soleOwner: boolean; title: string;
  dueAt: string; endedAt: string | null; overdueMinutes: number; status: string;
  penaltyId: number | null; calculatedCents: number | null; confirmedCents: number | null; penaltyStatus: string | null; penaltyReason: string | null; penaltyRevision: number | null;
  notifications: Array<{ level: string; atMinutes: number; recipientIds: number[]; error: string | null }>;
}
export interface LedgerDto { total: number; page: number; pageSize: number; canDecide: boolean; rows: LedgerRow[] }

const q = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

export const designerApi = {
  directory: () => api<DirectoryDto>('/flow/directory'),
  create: (b: { name: string; description?: string; departmentId?: number | null; sourceKey?: string | null }) => post<{ key: string }>('/flow/templates', b),
  updateMeta: (key: string, b: { name?: string; description?: string; departmentId?: number | null }) => api<{ ok: true }>(`/flow/templates/${key}/meta`, { method: 'PUT', body: b }),
  remove: (key: string) => api<{ ok: true }>(`/flow/templates/${key}`, { method: 'DELETE' }),
  definition: (key: string) => api<DesignerDefinition>(`/flow/definitions/${key}`),
  saveDraft: (key: string, steps: StepDef[], escalateUserIds: number[], schema?: DesignerSchema | null) => api<{ ok: true }>(`/flow/definitions/${key}/draft`, { method: 'PUT', body: { steps, escalateUserIds, ...(schema ? { schema } : {}) } }),
  publish: (key: string) => post<{ ok: true; version: number }>(`/flow/definitions/${key}/publish`),
  deactivate: (key: string) => post<{ ok: true }>(`/flow/definitions/${key}/deactivate`),
  activate: (key: string, version: number) => post<{ ok: true }>(`/flow/definitions/${key}/activate`, { version }),
  discardDraft: (key: string) => post<{ ok: true }>(`/flow/definitions/${key}/discard-draft`),
  nodeCenter: () => api<NodeCenterDto>('/flow/node-templates'),
  nodesForDesigner: () => api<NodeCenterDto>('/flow/node-templates/for-designer'),
  saveNode: (b: { key?: string | null; sourceKey?: string | null; revision?: number; name: string; description?: string; category: string; type: string; dueMinutes?: number | null; fields: FieldDef[] }) => post<{ key: string; revision: number }>('/flow/node-templates', b),
  deleteNode: (key: string) => api<{ ok: true }>(`/flow/node-templates/${key}`, { method: 'DELETE' }),
  policy: (templateKey: string, nodeKey: string) => api<PolicyDto>(`/flow/timeout-policy${q({ templateKey, nodeKey })}`),
  savePolicy: (templateKey: string, nodeKey: string, policy: Partial<TimeoutPolicy>, revision: number) => api<{ revision: number }>('/flow/timeout-policy', { method: 'PUT', body: { templateKey, nodeKey, policy, revision } }),
  ledger: (p: { templateKey?: string; status?: string; page?: number }) => api<LedgerDto>(`/flow/timeout-ledger${q(p)}`),
  decide: (id: number, b: { status: 'confirmed' | 'waived'; amountCents: number; reason: string; revision: number }) => post<{ ok: true }>(`/flow/timeout-penalties/${id}/decide`, b),
};
