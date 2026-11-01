import { In, type EntityManager } from 'typeorm';
import { createChecker, matchesPermission, resolvePermissions } from '@kudesi/shared';
import { AuditLog, FlowRun, PositionPermission, User, UserPermissionOverride, WorkItem } from '../entities';
import type { LegacyWorkflowSource } from './protocol';

/** Restore only capabilities supported by the captured legacy read-only policy.
 * Explicit denies survive. No administrator, cost-edit or external-write grant. */
export async function restoreWorkflowAccess(em: EntityManager, opts: { companyId: number; sourceCompanyId: number; actorId: number; source: NonNullable<LegacyWorkflowSource['access']>; currentFinanceIds?:number[]; lookup(type: string, id: unknown): number | undefined }) {
  if (!em.queryRunner?.isTransactionActive || !em.queryRunner.data.legacyImport || !/^[a-f0-9]{64}$/.test(opts.source.policyHash)) throw new Error('旧权限恢复缺少迁移事务或策略证据');
  const grants: Array<{ userId: number; permission: string }> = [], denied: Array<{ userId: number; permission: string }> = [];
  const members = await em.find(User, { where: { companyId: opts.companyId, status: 'active' } });
  const taskPeople = new Set<number>();
  for (const task of await em.find(WorkItem, { where: { companyId: opts.companyId, kind: 'task' } })) {
    taskPeople.add(task.assigneeId); if (task.supervisorId) taskPeople.add(task.supervisorId);
  }
  const financeIds = new Set<number>(opts.currentFinanceIds??[]);
  for (const run of await em.find(FlowRun, { where: { companyId: opts.companyId, templateKey: 'sku-batch-apply', status: 'running' } })) {
    const review = (run.stepsSnapshot as Array<{ key: string; assignee?: { source: string; id?: number } }>).find(s => s.key === 'review')?.assignee;
    for (const user of members) if ((review?.source === 'employee' && review.id === user.id) || (review?.source === 'department' && review.id === user.departmentId) || (review?.source === 'position' && (review.id === user.positionId || user.extraPositionIds?.includes(review.id!)))) financeIds.add(user.id);
  }
  const seen = new Set<number>();
  for (const fact of opts.source.employees) {
    if (typeof fact.canUseWorkflow !== 'boolean' || typeof fact.canViewCosts !== 'boolean') throw new Error('旧权限证据类型不合法');
    const targetId = opts.lookup('user', fact.employeeId);
    if (!targetId) throw new Error('旧权限证据的人员未迁入');
    if (seen.has(targetId)) throw new Error('旧权限人员身份发生合并'); seen.add(targetId);
    const member = members.find(u => u.id === targetId);
    if (!member) { if (fact.canUseWorkflow || fact.canViewCosts) throw new Error('旧在职权限与目标人员状态不一致'); continue; }
    const requested: string[] = [];
    if (fact.canUseWorkflow === true) requested.push('flow.apply.view', 'workbench.todos.view', 'workbench.started.view');
    if (fact.canUseWorkflow === true && taskPeople.has(member.id)) requested.push('workbench.tasks.view');
    if (fact.canViewCosts === true) requested.push('product.cost.view', 'product.price.view', 'resource.finance-ledger-history.view');
    if (financeIds.has(member.id)) {
      if (!fact.canUseWorkflow || !fact.canViewCosts) throw new Error('原财务办理人没有旧系统成本查看资格，禁止扩大授权');
      requested.push('resource.finance-bundles.create', 'resource.finance-bundles.edit');
    }
    const positions = [member.positionId, ...(member.extraPositionIds ?? [])].filter((n): n is number => !!n);
    const pp = positions.length ? await em.find(PositionPermission, { where: { positionId: In(positions) } }) : [];
    const overrides = await em.find(UserPermissionOverride, { where: { userId: member.id } });
    const can = createChecker(resolvePermissions({ isCompanyAdmin: member.isCompanyAdmin, positionPermissions: pp.map(p => p.permission), overrides: overrides.map(o => ({ permission: o.permission, effect: o.effect })) }));
    for (const permission of requested) {
      if (can(permission)) continue;
      if (overrides.some(o => o.effect === 'deny' && matchesPermission(o.permission, permission))) { denied.push({ userId: member.id, permission }); continue; }
      await em.insert(UserPermissionOverride, { userId: member.id, permission, effect: 'allow' }); grants.push({ userId: member.id, permission });
    }
  }
  if ([...financeIds].some(id => !seen.has(id))) throw new Error('原财务办理人缺少旧权限证据');
  if (grants.length) await em.insert(AuditLog, { companyId: opts.companyId, actorId: opts.actorId, action: 'legacy.workflow.access', resourceType: 'company', resourceId: String(opts.companyId), detail: { sourceCompanyId: opts.sourceCompanyId, policyHash: opts.source.policyHash, grants, denied } });
  return { grants, denied };
}
