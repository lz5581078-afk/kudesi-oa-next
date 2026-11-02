import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { cashierWithdrawalPermissions, deskAccessPermissions, permissionCatalog, type DeskAccessPlan } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, Company, Department, Position, PositionPermission, User, UserPermissionOverride } from '../entities';

@Injectable()
export class DeskAccessService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  private async snapshot(em: EntityManager, actor: AuthUser): Promise<DeskAccessPlan> {
    const admin = await em.findOne(User, { where: { id: actor.id, companyId: actor.companyId, status: 'active', isCompanyAdmin: true } });
    if (!actor.permissions.isCompanyAdmin || !admin) throw new ForbiddenException('仅公司管理员可按岗位工作台配置权限');
    const company = await em.findOneByOrFail(Company, { id: actor.companyId });
    const departments = await em.find(Department, { where: { companyId: actor.companyId }, order: { id: 'ASC' } });
    const positions = await em.find(Position, { where: { companyId: actor.companyId }, order: { id: 'ASC' } });
    const users = await em.find(User, { where: { companyId: actor.companyId }, order: { id: 'ASC' } });
    const grants = positions.length ? await em.find(PositionPermission, { where: { positionId: In(positions.map((p) => p.id)) }, order: { id: 'ASC' } }) : [];
    const overrides = users.length ? await em.find(UserPermissionOverride, { where: { userId: In(users.map((u) => u.id)) }, order: { id: 'ASC' } }) : [];
    const hrNames = new Set(['人事部', '人事综合部']);
    const protectedIds = new Set(departments.filter((d) => hrNames.has(d.name.trim())).map((d) => d.id));
    if (!protectedIds.size) throw new ConflictException('未识别需保留原权限的人事部门，已停止操作，请先核对保留范围');
    let changed = true;
    while (changed) { changed = false; for (const d of departments) if (d.parentId != null && protectedIds.has(d.parentId) && !protectedIds.has(d.id)) { protectedIds.add(d.id); changed = true; } }
    const protectedPositions = new Set(positions.filter((p) => p.departmentId != null && protectedIds.has(p.departmentId)).map((p) => p.id));
    const hrUsers = new Set(users.filter((u) => (u.departmentId != null && protectedIds.has(u.departmentId)) || [u.positionId, ...(u.extraPositionIds ?? [])].some((id) => id != null && protectedPositions.has(id))).map((u) => u.id));
    // 人事员工如有兼岗，共用岗位的原授权也要保留，避免间接改变人事权限。
    for (const u of users.filter((u) => hrUsers.has(u.id))) for (const id of [u.positionId, ...(u.extraPositionIds ?? [])]) if (id != null) protectedPositions.add(id);
    const labels = new Map(permissionCatalog().flatMap((g) => g.items.map((i) => [i.key, i.label] as const)));
    const plans = positions.map((p) => {
      const before = grants.filter((g) => g.positionId === p.id).map((g) => g.permission).sort();
      const preserved = protectedPositions.has(p.id) || p.status !== 'active';
      const after = preserved ? before : deskAccessPermissions(p.workspaceType, p.level);
      return { id: p.id, name: p.name, departmentName: departments.find((d) => d.id === p.departmentId)?.name ?? '未分部门', workspaceType: p.workspaceType,
        preserved, before, after, added: after.filter((k) => !before.includes(k)), removed: before.filter((k) => !after.includes(k)),
        pages: after.filter((k) => k.endsWith('.view')).map((k) => labels.get(k) ?? k) };
    });
    const staff = users.map((u) => {
      const assigned = [u.positionId, ...(u.extraPositionIds ?? [])].filter((id): id is number => id != null);
      const hr = hrUsers.has(u.id);
      const noPosition = !assigned.some((id) => positions.some((p) => p.id === id && p.status === 'active'));
      const reason = hr ? '人事部原权限保留' : u.isCompanyAdmin ? '公司管理员身份及个人授权保留' : u.status !== 'active' ? '停用员工保留' : noPosition ? '未分配有效岗位，保留原授权' : '按主岗及兼岗合并，清除原个人额外授权/拒绝';
      return { id: u.id, name: u.name, preserved: hr || u.isCompanyAdmin || u.status !== 'active' || noPosition, reason,
        before: overrides.filter((o) => o.userId === u.id).map((o) => ({ permission: o.permission, effect: o.effect })) };
    });
    const fingerprint = createHash('sha256').update(JSON.stringify({ companyId: company.id,
      departments: departments.map((d) => [d.id, d.name, d.parentId, d.status]),
      positions: positions.map((p) => [p.id, p.name, p.departmentId, p.workspaceType, p.level, p.status]),
      assignments: users.map((u) => [u.id, u.name, u.departmentId, u.positionId, u.extraPositionIds, u.isCompanyAdmin, u.status]), grants: plans.map((p) => [p.id, p.before, p.after]), staff,
    })).digest('hex');
    return { companyId: company.id, companyName: company.name, fingerprint, positions: plans, staff,
      protectedDepartments: departments.filter((d) => protectedIds.has(d.id)).map((d) => d.name),
      changedPositions: plans.filter((p) => p.added.length || p.removed.length).length,
      changedStaff: staff.filter((u) => !u.preserved && u.before.length).length };
  }

  /** 仅给当前公司的有效出纳岗位补授三项提现能力，保留所有原授权与个人拒绝。 */
  private async cashierSnapshot(em: EntityManager, actor: AuthUser): Promise<DeskAccessPlan> {
    const admin = await em.findOneBy(User, { id: actor.id, companyId: actor.companyId, status: 'active', isCompanyAdmin: true });
    if (!actor.permissions.isCompanyAdmin || !admin) throw new ForbiddenException('仅公司管理员可补授出纳权限');
    const company = await em.findOneByOrFail(Company, { id: actor.companyId });
    const positions = await em.find(Position, { where: { companyId: actor.companyId, workspaceType: 'cashier', status: 'active' }, order: { id: 'ASC' } });
    const rows = positions.length ? await em.find(PositionPermission, { where: { positionId: In(positions.map((p) => p.id)) } }) : [];
    const plans = positions.map((p) => {
      const before = rows.filter((r) => r.positionId === p.id).map((r) => r.permission).sort();
      const after = [...new Set([...before, ...cashierWithdrawalPermissions()])].sort();
      return { id: p.id, name: p.name, departmentName: '出纳岗位', workspaceType: p.workspaceType, preserved: false,
        before, after, added: after.filter((key) => !before.includes(key)), removed: [], pages: ['财务 › 店铺提现', '店铺登录管理', '受控远程协助'] };
    });
    const fingerprint = createHash('sha256').update(JSON.stringify({ companyId: company.id, positions: plans })).digest('hex');
    return { companyId: company.id, companyName: company.name, fingerprint, positions: plans, staff: [], protectedDepartments: [],
      changedPositions: plans.filter((p) => p.added.length).length, changedStaff: 0 };
  }

  previewCashier(actor: AuthUser) { return this.ds.transaction('REPEATABLE READ', (em) => this.cashierSnapshot(em, actor)); }

  applyCashier(actor: AuthUser, fingerprint: string) {
    return this.ds.transaction('SERIALIZABLE', async (em) => {
      await em.findOneOrFail(Company, { where: { id: actor.companyId }, lock: { mode: 'pessimistic_write' } });
      const plan = await this.cashierSnapshot(em, actor);
      if (plan.fingerprint !== fingerprint) throw new ConflictException('预览后岗位或权限已变化，请重新预览');
      for (const p of plan.positions) if (p.added.length) await em.insert(PositionPermission, p.added.map((permission) => ({ positionId: p.id, permission })));
      await em.save(AuditLog, em.create(AuditLog, { companyId: actor.companyId, actorId: actor.id, action: 'position.cashier-withdrawal.grant', resourceType: 'company', resourceId: String(actor.companyId), detail: { fingerprint: plan.fingerprint, positions: plan.positions } }));
      return { changedPositions: plan.changedPositions, changedStaff: 0 };
    });
  }

  preview(actor: AuthUser) { return this.ds.transaction('REPEATABLE READ', (em) => this.snapshot(em, actor)); }

  apply(actor: AuthUser, fingerprint: string) {
    return this.ds.transaction('SERIALIZABLE', async (em) => {
      // 同一公司的批量权限更新串行，预览后岗位、部门、人员或权限变化一律要求重看预览。
      await em.findOneOrFail(Company, { where: { id: actor.companyId }, lock: { mode: 'pessimistic_write' } });
      const plan = await this.snapshot(em, actor);
      if (plan.fingerprint !== fingerprint) throw new ConflictException('预览后岗位或权限已变化，请重新预览');
      for (const p of plan.positions.filter((p) => p.added.length || p.removed.length)) {
        await em.delete(PositionPermission, { positionId: p.id });
        if (p.after.length) await em.save(PositionPermission, p.after.map((permission) => em.create(PositionPermission, { positionId: p.id, permission })));
      }
      for (const u of plan.staff.filter((u) => !u.preserved && u.before.length)) await em.delete(UserPermissionOverride, { userId: u.id });
      await em.save(AuditLog, em.create(AuditLog, { companyId: actor.companyId, actorId: actor.id, action: 'position.desk-permissions.apply', resourceType: 'company', resourceId: String(actor.companyId), detail: { ...plan } }));
      return { changedPositions: plan.changedPositions, changedStaff: plan.changedStaff };
    });
  }
}
