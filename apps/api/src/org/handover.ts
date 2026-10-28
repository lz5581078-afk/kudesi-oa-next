import { EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, FlowStep, TaskRoutine, User, WorkItem } from '../entities';

/**
 * 员工停用时的工作交接（人员档案“停用员工”和兼职与临时工“停用”共用一份实现）：
 * 把待办、流程步骤、周期任务交给接收人，并留下交接记录。
 */

/** 建议的接收人：同岗位（优先同部门）在职同事 → 直属上级 → 公司管理员。 */
export async function suggestHandoverTarget(em: EntityManager, u: User): Promise<{ id: number; name: string; via: string } | null> {
  const others = (id: number) => id !== u.id;
  if (u.positionId) {
    const mates = (await em.find(User, { where: { companyId: u.companyId, positionId: u.positionId, status: 'active' }, order: { id: 'ASC' } })).filter((x) => others(x.id));
    const m = mates.find((x) => u.departmentId && x.departmentId === u.departmentId) ?? mates[0];
    if (m) return { id: m.id, name: m.name, via: '同岗位同事' };
  }
  if (u.managerId) {
    const m = await em.findOne(User, { where: { id: u.managerId, companyId: u.companyId, status: 'active' } });
    if (m && others(m.id)) return { id: m.id, name: m.name, via: '直属上级' };
  }
  const admin = (await em.find(User, { where: { companyId: u.companyId, isCompanyAdmin: true, status: 'active' }, order: { id: 'ASC' } })).find((x) => others(x.id));
  return admin ? { id: admin.id, name: admin.name, via: '公司管理员' } : null;
}

export async function handoverCounts(em: EntityManager, u: User) {
  const workItems = await em.count(WorkItem, { where: { companyId: u.companyId, assigneeId: u.id, status: 'open' } });
  const steps = (await em.find(FlowStep, { where: { companyId: u.companyId, status: 'active' }, select: ['id', 'recipients'] })).filter((x) => (x.recipients ?? []).includes(u.id)).length;
  const routines = await em.count(TaskRoutine, { where: { companyId: u.companyId, assigneeId: u.id, active: true } });
  return { workItems, flowSteps: steps, routines, total: workItems + routines };
}

/** 把停用员工手上的待办、流程步骤、周期任务交给接收人，并留下交接记录。 */
export async function doHandover(em: EntityManager, actor: AuthUser, u: User, target: { id: number; name: string }, reason: string) {
  const items = await em.find(WorkItem, { where: { companyId: u.companyId, assigneeId: u.id, status: 'open' } });
  let moved = 0, merged = 0;
  for (const it of items) {
    const dup = it.stepId ? await em.findOne(WorkItem, { where: { companyId: u.companyId, stepId: it.stepId, assigneeId: target.id, status: 'open' } }) : null;
    if (dup) { it.status = 'cancelled'; it.doneNote = `员工停用，已合并到 ${target.name} 的待办`; it.finishedAt = new Date(); merged += 1; }
    else { it.assigneeId = target.id; moved += 1; }
    await em.save(it);
  }
  let steps = 0;
  for (const st of await em.find(FlowStep, { where: { companyId: u.companyId, status: 'active' } })) {
    if (!(st.recipients ?? []).includes(u.id)) continue;
    st.recipients = [...new Set(st.recipients.map((r) => (r === u.id ? target.id : r)))];
    await em.save(st);
    steps += 1;
  }
  const routines = await em.update(TaskRoutine, { companyId: u.companyId, assigneeId: u.id, active: true }, { assigneeId: target.id });
  const result = { toUserId: target.id, toUserName: target.name, workItems: moved, mergedWorkItems: merged, flowSteps: steps, routines: routines.affected ?? 0 };
  await em.save(AuditLog, em.create(AuditLog, { companyId: actor.companyId, actorId: actor.id, action: 'user.handover', resourceType: 'user', resourceId: String(u.id), detail: { ...result, reason } }));
  return result;
}
