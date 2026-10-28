import { api } from '../../api/client';
import type { CatalogGroup } from '@kudesi/shared';

export interface DepartmentNode { id: number; name: string; managerId?: number | null; sortOrder: number; status: 'active' | 'inactive'; children: DepartmentNode[] }
export type PositionLevel = 'boss' | 'manager' | 'staff';
export const LEVEL_LABELS: Record<PositionLevel, string> = { boss: '老板', manager: '管理', staff: '员工' };
export const DUTY_CATEGORIES = ['岗位职责', '入职培训', '绩效考核', '监督规则', '流程节点说明', '日常工作', '周期工作', '审批职责', '资料维护', '其他'] as const;
export interface PositionDto {
  id: number; name: string; departmentId: number | null; workspaceType: string; permissions: string[]; userCount: number;
  level: PositionLevel; supervisorPositionId: number | null; description: string | null; status: 'active' | 'inactive'; positionKey?: string | null;
  /** 启用中的岗位条目（职责、培训、考核等）数量 */
  dutyCount?: number;
}
export interface DutyDto {
  id: number; category: string; title: string; description: string | null; frequency: string | null; relatedModule: string | null;
  completionStandard: string | null; isKey: boolean; status: 'active' | 'inactive';
}
export interface PositionProfile {
  position: { id: number; name: string; positionKey?: string | null; departmentId: number | null; departmentName: string | null; workspaceType: string; level: PositionLevel; supervisorPositionId: number | null; supervisorPositionName: string | null; description: string | null; status: 'active' | 'inactive' };
  duties: DutyDto[];
  staff: Array<{ id: number; name: string; status: string; concurrent: boolean }>;
  permissions: string[];
  logs: Array<{ id: number; action: string; resourceType: string; resourceId: string; detail: unknown; createdAt: string; actorName: string | null }>;
}
export interface HandoverPreview { counts: { workItems: number; flowSteps: number; routines: number; total: number }; suggested: { id: number; name: string } | null; candidates: Array<{ id: number; name: string }> }
export interface StaffDto {
  id: number; account: string; name: string; departmentId: number | null; positionId: number | null; positionName: string | null;
  isCompanyAdmin: boolean; status: 'active' | 'disabled'; lastLoginAt: string | null;
  managerId: number | null; title: string | null; baseSalary?: number | null; extraPositionIds: number[];
  payType?: PayType; hourlyRate?: number | null; employmentType?: EmploymentType;
}
export type PayType = 'monthly' | 'hourly';
export type EmploymentType = 'regular' | 'part_time' | 'temp';
export const PAY_TYPE_LABELS: Record<PayType, string> = { monthly: '月薪', hourly: '时薪' };
export const EMPLOYMENT_LABELS: Record<EmploymentType, string> = { regular: '正式员工', part_time: '兼职', temp: '临时工' };
export interface CompRecord { id: number; title: string; amount: number; effectiveDate: string | null; payPeriod: string | null; reason: string | null; actorName: string | null; createdAt: string }
export interface StaffRecords {
  hrLogs: Array<{ id: string; action: string; actorName: string | null; detail: unknown; createdAt: string }>;
  salaryChanges: CompRecord[]; payrollRecords: CompRecord[]; rewardRecords: CompRecord[]; penaltyRecords: CompRecord[];
  dutyGroups: Array<{ id: number; groupId: number; groupName: string; role: string | null; source: string; startedAt: string | null; endedAt: string | null; status: string }>;
  tasks: Array<{ id: number; title: string; status: string; assigneeName: string | null; createdByName: string | null; dueAt: string | null; createdAt: string }>;
  flows: Array<{ id: string; title: string; kind: string; status: string; action: string | null; createdAt: string }>;
  handovers: Array<{ id: string; fromName: string | null; toName: string | null; actorName: string | null; reason: string | null; workItems: number; flowSteps: number; routines: number; createdAt: string }>;
}
export interface StaffDetail extends StaffDto { allow: string[]; deny: string[] }

export interface DepartmentProfile {
  department: { id: number; name: string; parentId: number | null; parentName: string | null; status: string; managerId: number | null; managerName: string | null };
  headcount: number;
  positions: Array<{ id: number; name: string; level: PositionLevel; status: string; userCount: number; workspaceType?: string; dutyCount?: number }>;
  staff: Array<{ id: number; name: string; account: string; status: string; positionName: string | null; managerName: string | null; groups?: string[] }>;
  children?: Array<{ id: number; name: string; status: string; headcount: number }>;
  /** 归在本部门的职责组（职责组的“所属部门”） */
  dutyGroups?: Array<{ id: number; title: string; status: string; memberCount: number }>;
  [k: string]: unknown;
}

export const WORKSPACE_LABELS: Record<string, string> = {
  boss: '老板', general: '综合', operations: '运营', finance: '财务', cashier: '出纳', warehouse: '仓库', purchasing: '采购', support: '客服', live_anchor: '直播主播', live_control: '直播中控', blank: '空白（无默认工作台）',
};

export const orgApi = {
  catalog: () => api<CatalogGroup[]>('/org/permission-catalog'),
  departments: () => api<DepartmentNode[]>('/org/departments'),
  exportStaff: () => api<{ csv: string }>('/org/staff/export'),
  importStaff: (csv: string, dryRun: boolean) => api<StaffImportResult>('/org/staff/import', { method: 'POST', body: { csv, dryRun } }),
  staffRecords: (id: number) => api<StaffRecords>(`/org/staff/${id}/records`),
  handover: (id: number, body: { targetUserId?: number; reason?: string }) => api<{ toUserId: number; toUserName: string; workItems: number; flowSteps: number; routines: number }>(`/org/staff/${id}/handover`, { method: 'POST', body }),
  departmentProfile: (id: number) => api<DepartmentProfile>(`/org/departments/${id}/profile`),
  addDepartment: (name: string, parentId?: number) => api('/org/departments', { method: 'POST', body: { name, parentId } }),
  updateDepartment: (id: number, body: { name?: string; parentId?: number | null; managerId?: number | null; sortOrder?: number; status?: 'active' | 'inactive'; reason?: string }) => api(`/org/departments/${id}`, { method: 'PATCH', body }),
  deleteDepartment: (id: number, transferToId?: number) => api(`/org/departments/${id}`, { method: 'DELETE', body: { transferToId } }),
  positions: () => api<PositionDto[]>('/org/positions'),
  addPosition: (body: { name: string; positionKey?: string | null; departmentId: number | null; workspaceType: string; level?: PositionLevel; supervisorPositionId?: number | null; description?: string }) => api('/org/positions', { method: 'POST', body }),
  updatePosition: (id: number, body: { name?: string; positionKey?: string | null; departmentId?: number | null; workspaceType?: string; level?: PositionLevel; supervisorPositionId?: number | null; description?: string | null; status?: 'active' | 'inactive'; reason?: string }) => api(`/org/positions/${id}`, { method: 'PATCH', body }),
  setPositionPermissions: (id: number, permissions: string[]) => api(`/org/positions/${id}/permissions`, { method: 'PUT', body: { permissions } }),
  deletePosition: (id: number) => api(`/org/positions/${id}`, { method: 'DELETE' }),
  positionProfile: (id: number) => api<PositionProfile>(`/org/positions/${id}/profile`),
  addDuty: (positionId: number, body: Partial<DutyDto> & { category: string; title: string }) => api(`/org/positions/${positionId}/duties`, { method: 'POST', body }),
  updateDuty: (id: number, body: Partial<DutyDto> & { reason?: string }) => api(`/org/position-duties/${id}`, { method: 'PATCH', body }),
  deleteDuty: (id: number) => api(`/org/position-duties/${id}`, { method: 'DELETE' }),
  handoverPreview: (id: number) => api<HandoverPreview>(`/org/staff/${id}/handover-preview`),
  staff: () => api<StaffDto[]>('/org/staff'),
  staffOne: (id: number) => api<StaffDetail>(`/org/staff/${id}`),
  addStaff: (body: { account: string; name: string; departmentId: number | null; positionId: number | null; extraPositionIds?: number[]; managerId?: number | null; title?: string; baseSalary?: number | null; payType?: PayType; hourlyRate?: number | null; employmentType?: EmploymentType }) =>
    api<{ staff: StaffDetail; initialPassword: string }>('/org/staff', { method: 'POST', body }),
  updateStaff: (id: number, body: { name?: string; departmentId?: number | null; positionId?: number | null; extraPositionIds?: number[]; managerId?: number | null; title?: string | null; baseSalary?: number | null; payType?: PayType; hourlyRate?: number | null; employmentType?: EmploymentType }) => api<StaffDetail>(`/org/staff/${id}`, { method: 'PATCH', body }),
  setOverrides: (id: number, allow: string[], deny: string[]) => api<StaffDetail>(`/org/staff/${id}/overrides`, { method: 'PUT', body: { allow, deny } }),
  setStatus: (id: number, status: 'active' | 'disabled', reason?: string, handoverToUserId?: number) => api<StaffDetail>(`/org/staff/${id}/status`, { method: 'POST', body: { status, reason, handoverToUserId } }),
  resetPassword: (id: number) => api<{ password: string }>(`/org/staff/${id}/reset-password`, { method: 'POST', body: {} }),
};

export function flattenDepartments(nodes: DepartmentNode[], depth = 0): Array<{ id: number; name: string; depth: number }> {
  return nodes.flatMap((n) => [{ id: n.id, name: n.name, depth }, ...flattenDepartments(n.children, depth + 1)]);
}

export interface StaffImportResult {
  dryRun: boolean; error?: string;
  summary: { create: number; update: number; skip: number; error: number };
  rows: Array<{ line: number; name: string; account: string; action: 'create' | 'update' | 'skip' | 'error'; message: string; initialPassword?: string }>;
}
