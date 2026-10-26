import { api } from '../../api/client';
import type { CatalogGroup } from '@kudesi/shared';

export interface DepartmentNode { id: number; name: string; sortOrder: number; status: 'active' | 'inactive'; children: DepartmentNode[] }
export type PositionLevel = 'boss' | 'manager' | 'staff';
export const LEVEL_LABELS: Record<PositionLevel, string> = { boss: '老板', manager: '管理', staff: '员工' };
export const DUTY_CATEGORIES = ['岗位职责', '入职培训', '绩效考核', '监督规则', '流程节点说明'] as const;
export interface PositionDto {
  id: number; name: string; departmentId: number | null; workspaceType: string; permissions: string[]; userCount: number;
  level: PositionLevel; supervisorPositionId: number | null; description: string | null; status: 'active' | 'inactive';
}
export interface DutyDto {
  id: number; category: string; title: string; description: string | null; frequency: string | null; relatedModule: string | null;
  completionStandard: string | null; isKey: boolean; status: 'active' | 'inactive';
}
export interface PositionProfile {
  position: { id: number; name: string; departmentId: number | null; departmentName: string | null; workspaceType: string; level: PositionLevel; supervisorPositionId: number | null; supervisorPositionName: string | null; description: string | null; status: 'active' | 'inactive' };
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
}
export interface StaffDetail extends StaffDto { allow: string[]; deny: string[] }

export const WORKSPACE_LABELS: Record<string, string> = {
  boss: '老板', general: '综合', operations: '运营', finance: '财务', cashier: '出纳', warehouse: '仓库', purchasing: '采购', support: '客服', blank: '空白（无默认工作台）',
};

export const orgApi = {
  catalog: () => api<CatalogGroup[]>('/org/permission-catalog'),
  departments: () => api<DepartmentNode[]>('/org/departments'),
  addDepartment: (name: string, parentId?: number) => api('/org/departments', { method: 'POST', body: { name, parentId } }),
  updateDepartment: (id: number, body: { name?: string; parentId?: number | null; sortOrder?: number; status?: 'active' | 'inactive'; reason?: string }) => api(`/org/departments/${id}`, { method: 'PATCH', body }),
  deleteDepartment: (id: number, transferToId?: number) => api(`/org/departments/${id}`, { method: 'DELETE', body: { transferToId } }),
  positions: () => api<PositionDto[]>('/org/positions'),
  addPosition: (body: { name: string; departmentId: number | null; workspaceType: string; level?: PositionLevel; supervisorPositionId?: number | null; description?: string }) => api('/org/positions', { method: 'POST', body }),
  updatePosition: (id: number, body: { name?: string; departmentId?: number | null; workspaceType?: string; level?: PositionLevel; supervisorPositionId?: number | null; description?: string | null; status?: 'active' | 'inactive'; reason?: string }) => api(`/org/positions/${id}`, { method: 'PATCH', body }),
  setPositionPermissions: (id: number, permissions: string[]) => api(`/org/positions/${id}/permissions`, { method: 'PUT', body: { permissions } }),
  deletePosition: (id: number) => api(`/org/positions/${id}`, { method: 'DELETE' }),
  positionProfile: (id: number) => api<PositionProfile>(`/org/positions/${id}/profile`),
  addDuty: (positionId: number, body: Partial<DutyDto> & { category: string; title: string }) => api(`/org/positions/${positionId}/duties`, { method: 'POST', body }),
  updateDuty: (id: number, body: Partial<DutyDto> & { reason?: string }) => api(`/org/position-duties/${id}`, { method: 'PATCH', body }),
  deleteDuty: (id: number) => api(`/org/position-duties/${id}`, { method: 'DELETE' }),
  handoverPreview: (id: number) => api<HandoverPreview>(`/org/staff/${id}/handover-preview`),
  staff: () => api<StaffDto[]>('/org/staff'),
  staffOne: (id: number) => api<StaffDetail>(`/org/staff/${id}`),
  addStaff: (body: { account: string; name: string; departmentId: number | null; positionId: number | null; extraPositionIds?: number[]; managerId?: number | null; title?: string; baseSalary?: number | null }) =>
    api<{ staff: StaffDetail; initialPassword: string }>('/org/staff', { method: 'POST', body }),
  updateStaff: (id: number, body: { name?: string; departmentId?: number | null; positionId?: number | null; extraPositionIds?: number[]; managerId?: number | null; title?: string | null; baseSalary?: number | null }) => api<StaffDetail>(`/org/staff/${id}`, { method: 'PATCH', body }),
  setOverrides: (id: number, allow: string[], deny: string[]) => api<StaffDetail>(`/org/staff/${id}/overrides`, { method: 'PUT', body: { allow, deny } }),
  setStatus: (id: number, status: 'active' | 'disabled', reason?: string, handoverToUserId?: number) => api<StaffDetail>(`/org/staff/${id}/status`, { method: 'POST', body: { status, reason, handoverToUserId } }),
  resetPassword: (id: number) => api<{ password: string }>(`/org/staff/${id}/reset-password`, { method: 'POST', body: {} }),
};

export function flattenDepartments(nodes: DepartmentNode[], depth = 0): Array<{ id: number; name: string; depth: number }> {
  return nodes.flatMap((n) => [{ id: n.id, name: n.name, depth }, ...flattenDepartments(n.children, depth + 1)]);
}
