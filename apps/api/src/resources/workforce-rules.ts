import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import {
  WORKFORCE_FILE_FIELDS, WORKFORCE_MAX_FILES, WORKFORCE_PAY_LABELS, createChecker, todayShanghai,
  validateWorkforceTerms, workforceCooperation, workforceHourlyCents, type WorkforceEmployment,
} from '@kudesi/shared';
import { AuditLog, Department, EmployeeCompensationRecord, Position, ResourceRecord, User } from '../entities';
import { doHandover, handoverCounts, suggestHandoverTarget } from '../org/handover';
import type { AfterSaveContext, BeforeSaveContext } from './resource-rules';

/**
 * 兼职与临时工的专属规则（通用校验在 ResourcesService，这里只放这一类才有的）：
 * - 每条档案对应一个员工账号：同公司、在职、不是公司管理员、不能换人；姓名取自员工；
 * - 期限与单价按旧系统规则校验（临时工必填结束日期、结束不早于开始、单价 0~1000 万元、附件合计 ≤ 20）；
 * - 保存后把用工类型同步给员工账号，“计时且单价>0”同步为员工时薪（直播主播工资默认取它），写薪资变更记录；
 * - 停用：员工账号一并停用并交接待办/流程步骤/周期任务；重新启用：账号恢复。
 */

async function nameOf(em: EntityManager, model: typeof Position | typeof Department | typeof User, companyId: number, id: number | null | undefined): Promise<string> {
  if (!id) return '';
  const row = await em.findOne(model as never, { where: { id, companyId } as never }) as { name?: string } | null;
  return row?.name ?? '';
}

export async function workforceBeforeSave(ctx: BeforeSaveContext): Promise<void> {
  const { em, user, data, existing } = ctx;
  const userId = Number(data.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw new BadRequestException('请选择登录账号（员工）');
  if (existing && Number(existing.data.userId) !== userId) throw new BadRequestException('不能更换档案对应的员工，请新建一条档案');
  const person = await em.findOne(User, { where: { id: userId, companyId: user.companyId } });
  if (!person) throw new BadRequestException('员工不存在');
  if (person.isCompanyAdmin) throw new BadRequestException('公司管理员不能列为兼职或临时工');
  if (!existing && person.status !== 'active' && !em.queryRunner?.data.legacyImport) throw new BadRequestException('这个账号已停用，请先在人员档案里启用');

  // 姓名取自员工；账号/部门/岗位/上级的快照只用于搜索，列表和详情读的时候按员工当前资料实时取
  data.name = person.name;
  data.account = person.account ?? '';
  data.departmentName = await nameOf(em, Department, user.companyId, person.departmentId);
  data.positionName = await nameOf(em, Position, user.companyId, person.positionId);
  data.managerName = await nameOf(em, User, user.companyId, person.managerId);

  const problem = validateWorkforceTerms({ employmentType: data.employmentType, contractStartDate: data.contractStartDate, contractEndDate: data.contractEndDate, payRate: data.payRate });
  if (problem) throw new BadRequestException(problem);

  const files = WORKFORCE_FILE_FIELDS.reduce((n, k) => n + (Array.isArray(data[k]) ? (data[k] as unknown[]).length : 0), 0);
  if (files > WORKFORCE_MAX_FILES) throw new BadRequestException(`每人最多上传 ${WORKFORCE_MAX_FILES} 个附件，请先删除不用的`);
}

async function auditUser(em: EntityManager, ctx: AfterSaveContext, u: User, action: string, detail: Record<string, unknown>) {
  await em.save(AuditLog, em.create(AuditLog, { companyId: ctx.user.companyId, actorId: ctx.user.id, action, resourceType: 'user', resourceId: String(u.id), detail }));
}

export async function workforceAfterSave(ctx: AfterSaveContext): Promise<void> {
  const { em, user, record, existing } = ctx;
  if (em.queryRunner?.data.legacyImport) return; // 迁入只带资料：不改员工账号、不写薪资记录、不触发停用交接（员工本身由迁入流程建好）
  const person = await em.findOne(User, { where: { id: Number(record.data.userId), companyId: user.companyId } });
  if (!person) return;
  const data = record.data;

  // 1) 用工类型同步给员工账号（人员档案、直播主播名单都按它认兼职）
  const type = data.employmentType as WorkforceEmployment;
  if (person.employmentType !== type) {
    const before = person.employmentType;
    person.employmentType = type;
    await em.save(person);
    await auditUser(em, ctx, person, 'user.update', { employmentType: type, from: before, via: 'workforce' });
  }

  // 2) 计薪同步：计时且单价>0 → 员工时薪（分/小时）；从计时改成别的方式 → 员工计薪回到月薪、清掉时薪。只在本次改了计薪时同步
  const payChanged = !existing || existing.data.payMethod !== data.payMethod || existing.data.payRate !== data.payRate;
  if (payChanged && createChecker(user.permissions)('org.staff.salary')) {
    const rate = workforceHourlyCents(data.payMethod, data.payRate);
    const before = { type: person.payType, hourly: person.hourlyRate ?? null };
    let title = '';
    if (rate !== null && (person.payType !== 'hourly' || person.hourlyRate !== rate)) {
      title = person.payType !== 'hourly' ? '计薪方式变更' : '时薪变更';
      person.payType = 'hourly';
      person.hourlyRate = rate;
    } else if (rate === null && existing?.data.payMethod === 'hourly' && data.payMethod !== 'hourly' && person.payType === 'hourly') {
      title = '计薪方式变更';
      person.payType = 'monthly';
      person.hourlyRate = null;
    }
    if (title) {
      await em.save(person);
      await auditUser(em, ctx, person, 'user.salary', { hourlyFrom: before.hourly, hourlyTo: person.hourlyRate ?? null, via: 'workforce' });
      await em.insert(EmployeeCompensationRecord, {
        companyId: user.companyId, userId: person.id, recordType: 'salary_change', title,
        amount: (person.payType === 'hourly' ? person.hourlyRate : person.baseSalary) ?? 0,
        effectiveDate: todayShanghai(),
        reason: `兼职与临时工档案：${WORKFORCE_PAY_LABELS[data.payMethod as keyof typeof WORKFORCE_PAY_LABELS] ?? ''}${typeof data.payRate === 'number' ? ` ${(data.payRate / 100).toFixed(2)} 元` : ''}`,
        sourceType: 'workforce', actorId: user.id, payPeriod: null, sourceId: String(record.id),
      });
    }
  }

  // 3) 停用 / 重新启用：员工账号跟着停用并交接；重新启用只恢复账号（岗位保留）
  if (existing && existing.status !== 'inactive' && record.status === 'inactive') {
    if (person.id === user.id) throw new BadRequestException('不能停用自己');
    if (person.status === 'active') {
      const reason = ctx.reason?.trim() || '兼职/临时工停用';
      const counts = await handoverCounts(em, person);
      let handover: Awaited<ReturnType<typeof doHandover>> | null = null;
      if (counts.workItems + counts.flowSteps + counts.routines > 0) {
        const target = await suggestHandoverTarget(em, person);
        if (!target) throw new ConflictException('找不到可以接收交接的在职人员，请先到人员档案指定后再停用');
        handover = await doHandover(em, user, person, target, `停用原因：${reason}`);
      }
      person.status = 'disabled';
      await em.save(person);
      await auditUser(em, ctx, person, 'user.disable', { reason, via: 'workforce', handover: handover ? { toUserId: handover.toUserId, workItems: handover.workItems, flowSteps: handover.flowSteps, routines: handover.routines } : null });
    }
  } else if (existing && existing.status === 'inactive' && record.status !== 'inactive' && person.status !== 'active') {
    person.status = 'active';
    await em.save(person);
    await auditUser(em, ctx, person, 'user.enable', { via: 'workforce' });
  }
}

/** 不允许删除：旧系统没有删除，合作结束用“停用”（保留记录和历史）。 */
export function workforceBeforeDelete(): never {
  throw new BadRequestException('兼职与临时工档案不能删除，合作结束请用“停用”');
}

/** 列表/详情读时才算的字段：合作状态按今天实时算；账号、部门、岗位、上级、账号状态、最近登录取员工当前资料。 */
export async function deriveWorkforce(em: EntityManager, companyId: number, records: ResourceRecord[]): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  const today = todayShanghai();
  const userIds = [...new Set(records.map((r) => Number(r.data.userId)).filter((n) => Number.isInteger(n) && n > 0))];
  const users = userIds.length ? await em.find(User, { where: { companyId, id: In(userIds) } }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const need = (pick: (u: User) => number | null | undefined) => [...new Set(users.map(pick).filter((n): n is number => typeof n === 'number'))];
  const depts = need((u) => u.departmentId);
  const poss = need((u) => u.positionId);
  const mgrs = need((u) => u.managerId);
  const deptName = new Map((depts.length ? await em.find(Department, { where: { companyId, id: In(depts) } }) : []).map((d) => [d.id, d.name]));
  const posName = new Map((poss.length ? await em.find(Position, { where: { companyId, id: In(poss) } }) : []).map((p) => [p.id, p.name]));
  const mgrName = new Map((mgrs.length ? await em.find(User, { where: { companyId, id: In(mgrs) }, select: ['id', 'name'] }) : []).map((m) => [m.id, m.name]));
  for (const r of records) {
    const u = byId.get(Number(r.data.userId));
    const row: Record<string, unknown> = { cooperation: workforceCooperation(r.data, r.status, today) };
    if (u) {
      Object.assign(row, {
        account: u.account ?? '',
        departmentName: (u.departmentId && deptName.get(u.departmentId)) || '',
        positionName: (u.positionId && posName.get(u.positionId)) || '',
        managerName: (u.managerId && mgrName.get(u.managerId)) || '',
        accountStatus: u.status,
        lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16) : '',
      });
    }
    out.set(r.id, row);
  }
  return out;
}

