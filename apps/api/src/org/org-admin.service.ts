import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { allGrantableKeys, createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, Department, EmployeeCompensationRecord, FlowRun, PlatformAdmin, FlowStep, Position, PositionDuty, PositionPermission, ResourceChangeLog, ResourceRecord, TaskRoutine, User, UserPermissionOverride, WorkItem, WorkspaceType } from '../entities';

/** 岗位条目分类：前 5 类是岗位档案的主要分区，后 5 类对应旧系统的“其他条目” */
export const DUTY_CATEGORIES = ['岗位职责', '入职培训', '绩效考核', '监督规则', '流程节点说明', '日常工作', '周期工作', '审批职责', '资料维护', '其他'] as const;
export const EMPLOYMENT_TYPES = ['regular', 'part_time', 'temp'] as const;
export const PAY_TYPES = ['monthly', 'hourly'] as const;
/** 删除部门时，停用员工归档到的系统部门（不出现在组织架构里，与旧系统一致） */
export const DEPARTED_DEPARTMENT = '离职员工';
export const POSITION_LEVELS = ['boss', 'manager', 'staff'] as const;

export const WORKSPACE_TYPES: WorkspaceType[] = ['boss', 'general', 'operations', 'finance', 'cashier', 'warehouse', 'purchasing', 'support', 'blank'];

/** 只含容易读的字符，避免 0/O、1/l 混淆 */
const PASSWORD_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) out += PASSWORD_CHARS[crypto.randomInt(PASSWORD_CHARS.length)];
  return out;
}

export interface StaffDto {
  id: number;
  account: string;
  name: string;
  departmentId: number | null;
  positionId: number | null;
  positionName: string | null;
  /** 兼任岗位（不含主岗位） */
  extraPositionIds: number[];
  isCompanyAdmin: boolean;
  status: 'active' | 'disabled';
  lastLoginAt: Date | null;
  managerId: number | null;
  title: string | null;
  payType: 'monthly' | 'hourly';
  employmentType: 'regular' | 'part_time' | 'temp';
  /** 底薪（分）；没有 org.staff.salary 权限时不返回 */
  baseSalary?: number | null;
  /** 时薪（分/小时）；没有 org.staff.salary 权限时不返回 */
  hourlyRate?: number | null;
}

/** 部门、岗位、员工与权限管理。所有查询都带 companyId（取自令牌），所有变更写审计。 */
@Injectable()
export class OrgAdminService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  private audit(em: EntityManager, actor: AuthUser, action: string, resourceType: string, resourceId: number, detail: Record<string, unknown> | null) {
    return em.save(AuditLog, em.create(AuditLog, { companyId: actor.companyId, actorId: actor.id, action, resourceType, resourceId: String(resourceId), detail }));
  }

  /** 校验权限键都在清单里；非管理员只能授予自己拥有的权限，防止越权提升。 */
  private checkGrantable(actor: AuthUser, keys: string[]) {
    const valid = allGrantableKeys();
    const bad = keys.filter((k) => !valid.has(k));
    if (bad.length > 0) throw new BadRequestException(`包含不存在的权限：${bad.slice(0, 3).join('、')}`);
    if (!actor.permissions.isCompanyAdmin) {
      const can = createChecker(actor.permissions);
      if (keys.some((k) => !can(k))) throw new ForbiddenException('不能授予自己没有的权限');
    }
  }

  private async mustDepartment(em: EntityManager, companyId: number, id: number | null | undefined) {
    if (id === null || id === undefined) return null;
    const d = await em.findOne(Department, { where: { id, companyId } });
    if (!d || d.isSystem) throw new BadRequestException('部门不存在');
    return d;
  }

  // ---------- 部门 ----------
  /** 改部门：名称、上级、同级排序；上级不能是自己或自己的下级（防止成环）。 */
  async updateDepartment(actor: AuthUser, id: number, input: { name?: string; parentId?: number | null; sortOrder?: number; status?: 'active' | 'inactive'; managerId?: number | null; reason?: string }) {
    return this.ds.transaction(async (em) => {
      const d = await em.findOne(Department, { where: { id, companyId: actor.companyId } });
      if (!d) throw new NotFoundException('部门不存在');
      if (d.isSystem) throw new ConflictException('系统归档部门不可编辑');
      const before = { name: d.name, parentId: d.parentId, sortOrder: d.sortOrder, status: d.status, managerId: d.managerId };
      if (input.managerId !== undefined) {
        if (input.managerId !== null && input.managerId !== d.managerId) await this.mustActiveUser(em, actor.companyId, input.managerId, '部门主管');
        d.managerId = input.managerId;
      }
      if (input.name !== undefined) d.name = input.name.trim();
      if (input.parentId !== undefined && input.parentId !== d.parentId) {
        if (input.parentId !== null) {
          if (input.parentId === id) throw new BadRequestException('上级部门不能是自己');
          await this.mustDepartment(em, actor.companyId, input.parentId);
          // 沿上级链往上走，遇到自己就是成环
          let cur: number | null = input.parentId;
          for (let guard = 0; cur !== null && guard < 100; guard++) {
            if (cur === id) throw new BadRequestException('上级部门不能是自己的下级部门');
            const up: Department | null = await em.findOne(Department, { where: { id: cur, companyId: actor.companyId } });
            cur = up?.parentId ?? null;
          }
        }
        d.parentId = input.parentId;
      }
      if (input.sortOrder !== undefined) d.sortOrder = input.sortOrder;
      let reason: string | undefined;
      if (input.status !== undefined && input.status !== d.status) {
        if (input.status === 'inactive') {
          reason = input.reason?.trim();
          if (!reason || reason.length < 2) throw new BadRequestException('停用部门必须填写原因');
        }
        d.status = input.status;
      }
      await em.save(d);
      await this.audit(em, actor, 'department.update', 'department', id, { from: before, to: { name: d.name, parentId: d.parentId, sortOrder: d.sortOrder, status: d.status, managerId: d.managerId }, ...(reason ? { reason } : {}) });
      return d;
    });
  }

  /**
   * 删除部门：空部门直接删；有下级部门、岗位、在职员工或固定资产时，必须指定一个接收部门，全部转过去再删。
   * 停用的员工不占用接收部门，归档到系统部门“离职员工”（旧系统同样处理）。
   */
  async deleteDepartment(actor: AuthUser, id: number, transferToId?: number | null) {
    return this.ds.transaction(async (em) => {
      const d = await em.findOne(Department, { where: { id, companyId: actor.companyId } });
      if (!d) throw new NotFoundException('部门不存在');
      if (d.isSystem) throw new ConflictException('系统归档部门不能删除');
      const [kids, positions, users] = await Promise.all([
        em.count(Department, { where: { companyId: actor.companyId, parentId: id } }),
        em.find(Position, { where: { companyId: actor.companyId, departmentId: id } }),
        em.find(User, { where: { companyId: actor.companyId, departmentId: id } }),
      ]);
      const activeUsers = users.filter((u) => u.status === 'active');
      const inactiveUsers = users.filter((u) => u.status !== 'active');
      // 固定资产的“所属部门”存在资料数据里，也要跟着转移（旧系统同样处理并写日志）
      const assets = await em
        .createQueryBuilder(ResourceRecord, 'r')
        .where('r.companyId = :c AND r.type = :t', { c: actor.companyId, t: 'fixed-assets' })
        .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.departmentId')) = :d", { d: String(id) })
        .getMany();
      const moved = { kids, positions: positions.length, users: activeUsers.length, assets: assets.length, archivedUsers: inactiveUsers.length };
      if (kids + positions.length + activeUsers.length + assets.length > 0) {
        if (!transferToId) throw new ConflictException('部门下还有下级部门、岗位、在职员工或固定资产，请选择一个接收部门后再删除');
        if (transferToId === id) throw new BadRequestException('接收部门不能是被删除的部门');
        const target = await this.mustDepartment(em, actor.companyId, transferToId);
        // 接收部门不能是被删除部门的下级，否则下级部门会挂到自己下面
        let cur: number | null = transferToId;
        for (let guard = 0; cur !== null && guard < 100; guard++) {
          if (cur === id) throw new BadRequestException('接收部门不能是被删除部门的下级部门');
          const up: Department | null = await em.findOne(Department, { where: { id: cur, companyId: actor.companyId } });
          cur = up?.parentId ?? null;
        }
        // 岗位编码在部门内唯一：接收部门已有相同编码就不能转
        const keys = positions.map((p) => p.positionKey).filter((k): k is string => !!k);
        if (keys.length) {
          const clash = await em.find(Position, { where: { companyId: actor.companyId, departmentId: transferToId, positionKey: In(keys) } });
          if (clash.length) throw new ConflictException(`接收部门已有相同岗位编码：${clash.map((c) => c.positionKey).join('、')}。请先调整岗位编码或选择其他部门`);
        }
        await em.update(Department, { companyId: actor.companyId, parentId: id }, { parentId: transferToId });
        await em.update(Position, { companyId: actor.companyId, departmentId: id }, { departmentId: transferToId });
        await em.update(User, { companyId: actor.companyId, departmentId: id, status: 'active' }, { departmentId: transferToId });
        for (const a of assets) {
          const before = { title: a.title, status: a.status, ...a.data };
          a.data = { ...a.data, departmentId: transferToId };
          await em.save(ResourceRecord, a);
          await em.insert(ResourceChangeLog, {
            companyId: actor.companyId, resourceType: 'fixed-assets', resourceId: a.id, action: 'department_transferred', actorId: actor.id,
            beforeJson: before as never, afterJson: { title: a.title, status: a.status, ...a.data } as never,
            note: `部门「${d.name}」已删除，资产转到「${target!.name}」`,
          });
        }
      }
      if (inactiveUsers.length) {
        let departed = await em.findOne(Department, { where: { companyId: actor.companyId, isSystem: true, name: DEPARTED_DEPARTMENT } });
        if (!departed) {
          departed = await em.save(Department, em.create(Department, { companyId: actor.companyId, parentId: null, name: DEPARTED_DEPARTMENT, sortOrder: 2147483647, status: 'inactive', managerId: null, isSystem: true }));
        }
        await em.update(User, { companyId: actor.companyId, departmentId: id, status: In(['disabled']) }, { departmentId: departed.id });
      }
      await em.delete(Department, { id, companyId: actor.companyId });
      await this.audit(em, actor, 'department.delete', 'department', id, { name: d.name, transferToId: transferToId ?? null, moved });
      return { ok: true, moved };
    });
  }

  /** 部门档案：主管、人数、岗位、人员（含直属上级和所在职责组）、下级部门。 */
  async departmentProfile(actor: AuthUser, id: number) {
    const em = this.ds.manager;
    const d = await em.findOne(Department, { where: { id, companyId: actor.companyId } });
    if (!d || d.isSystem) throw new NotFoundException('部门不存在');
    const [positions, users, kids, allUsers] = await Promise.all([
      em.find(Position, { where: { companyId: actor.companyId, departmentId: id }, order: { sortOrder: 'ASC', id: 'ASC' } }),
      em.find(User, { where: { companyId: actor.companyId, departmentId: id }, order: { id: 'ASC' } }),
      em.find(Department, { where: { companyId: actor.companyId, parentId: id, isSystem: false }, order: { sortOrder: 'ASC', id: 'ASC' } }),
      em.find(User, { where: { companyId: actor.companyId }, select: ['id', 'name', 'departmentId', 'status'] }),
    ]);
    const nameOf = new Map(allUsers.map((u) => [u.id, u.name]));
    const parent = d.parentId ? await em.findOne(Department, { where: { id: d.parentId, companyId: actor.companyId } }) : null;
    // 职责组：职责组成员是资料（duty-group-members），按成员找所属组
    const memberRows = users.length
      ? (await em.find(ResourceRecord, { where: { companyId: actor.companyId, type: 'duty-group-members' }, select: ['id', 'data'] })).filter((r) => users.some((u) => u.id === Number(r.data.userId)))
      : [];
    const groupIds = [...new Set(memberRows.map((r) => Number(r.data.groupId)))];
    const groups = groupIds.length ? await em.find(ResourceRecord, { where: { companyId: actor.companyId, type: 'duty-groups', id: In(groupIds) }, select: ['id', 'title'] }) : [];
    const groupName = new Map(groups.map((g) => [g.id, g.title]));
    const posName = new Map(positions.map((p) => [p.id, p.name]));
    const posAll = await this.positionMap(em, actor.companyId);
    const headcount = async (deptId: number) => allUsers.filter((u) => u.departmentId === deptId && u.status === 'active').length;
    return {
      department: { id: d.id, name: d.name, parentId: d.parentId, parentName: parent?.name ?? null, status: d.status, managerId: d.managerId, managerName: d.managerId ? nameOf.get(d.managerId) ?? null : null },
      headcount: users.filter((u) => u.status === 'active').length,
      positions: positions.map((p) => ({ id: p.id, name: p.name, level: p.level, status: p.status, userCount: users.filter((u) => u.status === 'active' && (u.positionId === p.id || (u.extraPositionIds ?? []).includes(p.id))).length })),
      staff: users.map((u) => ({
        id: u.id, name: u.name, account: u.account ?? '', status: u.status, positionName: u.positionId ? posName.get(u.positionId) ?? posAll.get(u.positionId) ?? null : null,
        managerName: u.managerId ? nameOf.get(u.managerId) ?? null : null,
        groups: memberRows.filter((r) => Number(r.data.userId) === u.id).map((r) => groupName.get(Number(r.data.groupId)) ?? '').filter(Boolean),
      })),
      children: await Promise.all(kids.map(async (k) => ({ id: k.id, name: k.name, status: k.status, headcount: await headcount(k.id) }))),
    };
  }

  // ---------- 岗位 ----------
  async listPositions(actor: AuthUser) {
    const rows = await this.ds.manager.find(Position, { where: { companyId: actor.companyId }, order: { sortOrder: 'ASC', id: 'ASC' } });
    const ids = rows.map((r) => r.id);
    const perms = ids.length ? await this.ds.manager.find(PositionPermission, { where: { positionId: In(ids) } }) : [];
    const people = await this.ds.manager.find(User, { where: { companyId: actor.companyId }, select: ['id', 'positionId', 'extraPositionIds'] });
    const countOf = (pid: number) => people.filter((u) => u.positionId === pid || (u.extraPositionIds ?? []).includes(pid)).length;
    return rows.map((r) => ({
      id: r.id, name: r.name, positionKey: r.positionKey, departmentId: r.departmentId, workspaceType: r.workspaceType,
      level: r.level, supervisorPositionId: r.supervisorPositionId, description: r.description, status: r.status,
      permissions: perms.filter((p) => p.positionId === r.id).map((p) => p.permission).sort(),
      userCount: countOf(r.id),
    }));
  }

  async createPosition(actor: AuthUser, input: { name: string; positionKey?: string | null; departmentId?: number | null; workspaceType: WorkspaceType; level?: 'boss' | 'manager' | 'staff'; supervisorPositionId?: number | null; description?: string }) {
    if (!WORKSPACE_TYPES.includes(input.workspaceType)) throw new BadRequestException('岗位类型不合法');
    return this.ds.transaction(async (em) => {
      await this.mustDepartment(em, actor.companyId, input.departmentId);
      const name = input.name.trim();
      if (await em.findOne(Position, { where: { companyId: actor.companyId, name } })) throw new ConflictException('已有同名岗位');
      if (input.level && !POSITION_LEVELS.includes(input.level)) throw new BadRequestException('岗位层级不合法');
      if (input.supervisorPositionId) await this.mustPosition(em, actor.companyId, input.supervisorPositionId);
      const positionKey = input.positionKey?.trim() || null;
      await this.checkPositionKey(em, actor.companyId, input.departmentId ?? null, positionKey, null);
      const p = await em.save(Position, em.create(Position, { companyId: actor.companyId, positionKey, name, departmentId: input.departmentId ?? null, workspaceType: input.workspaceType, sortOrder: 0, level: input.level ?? 'staff', supervisorPositionId: input.supervisorPositionId ?? null, description: input.description?.trim() || null, status: 'active' }));
      await this.audit(em, actor, 'position.create', 'position', p.id, { name, workspaceType: p.workspaceType });
      return p;
    });
  }

  /** 岗位编码在同一部门内唯一（可以不填） */
  private async checkPositionKey(em: EntityManager, companyId: number, departmentId: number | null, key: string | null, selfId: number | null) {
    if (!key) return;
    const dup = await em.findOne(Position, { where: { companyId, departmentId: departmentId === null ? IsNull() : departmentId, positionKey: key } });
    if (dup && dup.id !== selfId) throw new ConflictException(`这个部门里已有岗位编码「${key}」`);
  }

  async updatePosition(actor: AuthUser, id: number, input: { name?: string; positionKey?: string | null; departmentId?: number | null; workspaceType?: WorkspaceType; level?: 'boss' | 'manager' | 'staff'; supervisorPositionId?: number | null; description?: string | null; status?: 'active' | 'inactive'; reason?: string }) {
    return this.ds.transaction(async (em) => {
      const p = await em.findOne(Position, { where: { id, companyId: actor.companyId } });
      if (!p) throw new NotFoundException('岗位不存在');
      if (input.name !== undefined) {
        const name = input.name.trim();
        const dup = await em.findOne(Position, { where: { companyId: actor.companyId, name } });
        if (dup && dup.id !== id) throw new ConflictException('已有同名岗位');
        p.name = name;
      }
      if (input.departmentId !== undefined) {
        await this.mustDepartment(em, actor.companyId, input.departmentId);
        p.departmentId = input.departmentId;
      }
      if (input.positionKey !== undefined) p.positionKey = input.positionKey?.trim() || null;
      if (input.departmentId !== undefined || input.positionKey !== undefined) await this.checkPositionKey(em, actor.companyId, p.departmentId, p.positionKey, id);
      if (input.workspaceType !== undefined) {
        if (!WORKSPACE_TYPES.includes(input.workspaceType)) throw new BadRequestException('岗位类型不合法');
        p.workspaceType = input.workspaceType;
      }
      if (input.level !== undefined) {
        if (!POSITION_LEVELS.includes(input.level)) throw new BadRequestException('岗位层级不合法');
        p.level = input.level;
      }
      if (input.supervisorPositionId !== undefined) {
        if (input.supervisorPositionId !== null) {
          if (input.supervisorPositionId === id) throw new BadRequestException('上级岗位不能是自己');
          await this.mustPosition(em, actor.companyId, input.supervisorPositionId);
          let cur: number | null = input.supervisorPositionId;
          for (let guard = 0; cur !== null && guard < 100; guard++) {
            if (cur === id) throw new BadRequestException('上级岗位不能是自己的下级岗位');
            const up: Position | null = await em.findOne(Position, { where: { id: cur, companyId: actor.companyId } });
            cur = up?.supervisorPositionId ?? null;
          }
        }
        p.supervisorPositionId = input.supervisorPositionId;
      }
      if (input.description !== undefined) p.description = input.description?.trim() || null;
      let reason: string | undefined;
      if (input.status !== undefined && input.status !== p.status) {
        if (input.status === 'inactive') {
          reason = input.reason?.trim();
          if (!reason || reason.length < 2) throw new BadRequestException('停用岗位必须填写原因');
          if ((await this.usersOnPosition(em, actor.companyId, id, true)).length > 0) throw new ConflictException('还有在职员工在这个岗位上，请先给他们换岗位再停用');
        }
        p.status = input.status;
      }
      await em.save(p);
      const { reason: _r, ...rest } = input;
      await this.audit(em, actor, 'position.update', 'position', id, { ...rest, ...(reason ? { reason } : {}) });
      return p;
    });
  }

  async setPositionPermissions(actor: AuthUser, id: number, permissions: string[]) {
    const keys = [...new Set(permissions)];
    this.checkGrantable(actor, keys);
    return this.ds.transaction(async (em) => {
      const p = await em.findOne(Position, { where: { id, companyId: actor.companyId } });
      if (!p) throw new NotFoundException('岗位不存在');
      // 非管理员不能改动自己所在岗位的权限（否则可以给自己加权限）
      if (!actor.permissions.isCompanyAdmin) {
        const me = await em.findOne(User, { where: { id: actor.id, companyId: actor.companyId } });
        if (me?.positionId === id || (me?.extraPositionIds ?? []).includes(id)) throw new ForbiddenException('不能修改自己所在岗位的权限');
      }
      const old = (await em.find(PositionPermission, { where: { positionId: id } })).map((x) => x.permission);
      await em.delete(PositionPermission, { positionId: id });
      if (keys.length > 0) await em.insert(PositionPermission, keys.map((permission) => ({ positionId: id, permission })));
      await this.audit(em, actor, 'position.permissions', 'position', id, {
        added: keys.filter((k) => !old.includes(k)), removed: old.filter((k) => !keys.includes(k)),
      });
      return { id, permissions: keys.sort() };
    });
  }

  async deletePosition(actor: AuthUser, id: number) {
    await this.ds.transaction(async (em) => {
      const p = await em.findOne(Position, { where: { id, companyId: actor.companyId } });
      if (!p) throw new NotFoundException('岗位不存在');
      if ((await this.usersOnPosition(em, actor.companyId, id)).length > 0) throw new ConflictException('还有员工在这个岗位上，不能删除');
      await em.delete(PositionPermission, { positionId: id });
      await em.delete(PositionDuty, { companyId: actor.companyId, positionId: id });
      await em.update(Position, { companyId: actor.companyId, supervisorPositionId: id }, { supervisorPositionId: null });
      await em.delete(Position, { id, companyId: actor.companyId });
      await this.audit(em, actor, 'position.delete', 'position', id, { name: p.name });
    });
  }

  // ---------- 岗位档案：职责 / 培训 / 考核 / 监督规则 / 流程节点说明 ----------
  /** 岗位档案详情：基础信息、条目、在岗人员、岗位权限、操作记录。 */
  async positionProfile(actor: AuthUser, id: number) {
    const em = this.ds.manager;
    const p = await em.findOne(Position, { where: { id, companyId: actor.companyId } });
    if (!p) throw new NotFoundException('岗位不存在');
    const [duties, staff, perms, dept, sup] = await Promise.all([
      em.find(PositionDuty, { where: { companyId: actor.companyId, positionId: id }, order: { id: 'ASC' } }),
      this.usersOnPosition(em, actor.companyId, id),
      em.find(PositionPermission, { where: { positionId: id } }),
      p.departmentId ? em.findOne(Department, { where: { id: p.departmentId, companyId: actor.companyId } }) : null,
      p.supervisorPositionId ? em.findOne(Position, { where: { id: p.supervisorPositionId, companyId: actor.companyId } }) : null,
    ]);
    const dutyIds = duties.map((d) => String(d.id));
    const logs: Array<{ id: number; action: string; resourceType: string; resourceId: string; detail: unknown; createdAt: Date; actorName: string | null }> = await em.query(
      `SELECT a.id, a.action, a.resource_type AS resourceType, a.resource_id AS resourceId, a.detail, a.created_at AS createdAt, u.name AS actorName
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.company_id = ? AND ((a.resource_type = 'position' AND a.resource_id = ?)${dutyIds.length ? ` OR (a.resource_type = 'position_duty' AND a.resource_id IN (${dutyIds.map(() => '?').join(',')}))` : ''})
       ORDER BY a.id DESC LIMIT 100`,
      [actor.companyId, String(id), ...dutyIds],
    );
    return {
      position: { id: p.id, name: p.name, positionKey: p.positionKey, departmentId: p.departmentId, departmentName: dept?.name ?? null, workspaceType: p.workspaceType, level: p.level, supervisorPositionId: p.supervisorPositionId, supervisorPositionName: sup?.name ?? null, description: p.description, status: p.status },
      duties: duties.map((d) => ({ id: d.id, category: d.category, title: d.title, description: d.description, frequency: d.frequency, relatedModule: d.relatedModule, completionStandard: d.completionStandard, isKey: d.isKey, status: d.status })),
      staff: staff.map((u) => ({ id: u.id, name: u.name, status: u.status, concurrent: u.positionId !== id })),
      permissions: perms.map((x) => x.permission).sort(),
      logs,
    };
  }

  private cleanDuty(input: { category?: string; title?: string; description?: string | null; frequency?: string | null; relatedModule?: string | null; completionStandard?: string | null; isKey?: boolean }) {
    if (input.category !== undefined && !(DUTY_CATEGORIES as readonly string[]).includes(input.category)) throw new BadRequestException('条目分类不合法');
    if (input.title !== undefined && !input.title.trim()) throw new BadRequestException('标题不能为空');
    const t = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
    return { category: input.category, title: input.title?.trim(), description: t(input.description), frequency: t(input.frequency), relatedModule: t(input.relatedModule), completionStandard: t(input.completionStandard), isKey: input.isKey };
  }

  async createDuty(actor: AuthUser, positionId: number, input: { category: string; title: string; description?: string; frequency?: string; relatedModule?: string; completionStandard?: string; isKey?: boolean }) {
    const c = this.cleanDuty(input);
    return this.ds.transaction(async (em) => {
      await this.mustPosition(em, actor.companyId, positionId);
      const d = await em.save(PositionDuty, em.create(PositionDuty, { companyId: actor.companyId, positionId, category: c.category!, title: c.title!, description: c.description ?? null, frequency: c.frequency ?? null, relatedModule: c.relatedModule ?? null, completionStandard: c.completionStandard ?? null, isKey: !!c.isKey, status: 'active' }));
      await this.audit(em, actor, 'position_duty.create', 'position_duty', d.id, { positionId, category: d.category, title: d.title });
      return d;
    });
  }

  async updateDuty(actor: AuthUser, id: number, input: { category?: string; title?: string; description?: string | null; frequency?: string | null; relatedModule?: string | null; completionStandard?: string | null; isKey?: boolean; status?: 'active' | 'inactive'; reason?: string }) {
    const c = this.cleanDuty(input);
    return this.ds.transaction(async (em) => {
      const d = await em.findOne(PositionDuty, { where: { id, companyId: actor.companyId } });
      if (!d) throw new NotFoundException('岗位条目不存在');
      for (const [k, v] of Object.entries(c)) if (v !== undefined) (d as unknown as Record<string, unknown>)[k] = v;
      let reason: string | undefined;
      if (input.status !== undefined && input.status !== d.status) {
        if (input.status === 'inactive') {
          reason = input.reason?.trim();
          if (!reason || reason.length < 2) throw new BadRequestException('停用岗位条目必须填写原因');
        }
        d.status = input.status;
      }
      await em.save(d);
      await this.audit(em, actor, 'position_duty.update', 'position_duty', id, { title: d.title, status: d.status, ...(reason ? { reason } : {}) });
      return d;
    });
  }

  async deleteDuty(actor: AuthUser, id: number) {
    await this.ds.transaction(async (em) => {
      const d = await em.findOne(PositionDuty, { where: { id, companyId: actor.companyId } });
      if (!d) throw new NotFoundException('岗位条目不存在');
      await em.delete(PositionDuty, { id, companyId: actor.companyId });
      await this.audit(em, actor, 'position_duty.delete', 'position_duty', id, { positionId: d.positionId, title: d.title });
    });
  }

  // ---------- 员工 ----------
  /** 兼任岗位校验：都存在、不含主岗位、不重复。 */
  private async cleanExtraPositions(em: EntityManager, companyId: number, primary: number | null, ids: number[] | undefined) {
    const list = [...new Set(ids ?? [])];
    if (primary !== null && list.includes(primary)) throw new BadRequestException('兼任岗位不能和主岗位相同');
    if (list.length > 0 && !primary) throw new BadRequestException('请先选择主岗位，再添加兼任岗位');
    for (const pid of list) await this.mustPosition(em, companyId, pid);
    return list;
  }

  /** 在某个岗位上的员工（主岗位或兼任都算）。 */
  private async usersOnPosition(em: EntityManager, companyId: number, positionId: number, activeOnly = false) {
    const all = await em.find(User, { where: { companyId, ...(activeOnly ? { status: 'active' as const } : {}) }, order: { id: 'ASC' } });
    return all.filter((u) => u.positionId === positionId || (u.extraPositionIds ?? []).includes(positionId));
  }

  private canSalary(actor: AuthUser) { return createChecker(actor.permissions)('org.staff.salary'); }

  private toStaff(u: User, positions: Map<number, string>, withSalary = false): StaffDto {
    return {
      id: u.id, account: u.account ?? '', name: u.name, departmentId: u.departmentId, positionId: u.positionId,
      positionName: u.positionId ? positions.get(u.positionId) ?? null : null,
      extraPositionIds: u.extraPositionIds ?? [],
      isCompanyAdmin: u.isCompanyAdmin, status: u.status, lastLoginAt: u.lastLoginAt,
      managerId: u.managerId, title: u.title, payType: u.payType, employmentType: u.employmentType,
      ...(withSalary ? { baseSalary: u.baseSalary, hourlyRate: u.hourlyRate } : {}),
    };
  }

  private async positionMap(em: EntityManager, companyId: number) {
    return new Map((await em.find(Position, { where: { companyId }, select: ['id', 'name'] })).map((p) => [p.id, p.name]));
  }

  async listStaff(actor: AuthUser): Promise<StaffDto[]> {
    const em = this.ds.manager;
    const [users, pm] = await Promise.all([em.find(User, { where: { companyId: actor.companyId }, order: { id: 'ASC' } }), this.positionMap(em, actor.companyId)]);
    const sal = this.canSalary(actor);
    return users.map((u) => this.toStaff(u, pm, sal));
  }

  async getStaff(actor: AuthUser, id: number) {
    const em = this.ds.manager;
    const u = await em.findOne(User, { where: { id, companyId: actor.companyId } });
    if (!u) throw new NotFoundException('员工不存在');
    const ov = await em.find(UserPermissionOverride, { where: { userId: id } });
    return {
      ...this.toStaff(u, await this.positionMap(em, actor.companyId), this.canSalary(actor)),
      allow: ov.filter((o) => o.effect === 'allow').map((o) => o.permission).sort(),
      deny: ov.filter((o) => o.effect === 'deny').map((o) => o.permission).sort(),
    };
  }

  private async mustPosition(em: EntityManager, companyId: number, id: number | null | undefined) {
    if (id === null || id === undefined) return;
    if (!(await em.findOne(Position, { where: { id, companyId } }))) throw new BadRequestException('岗位不存在');
  }

  /** 新员工的初始密码由系统随机生成，只在这次返回里出现一次，首次登录必须改。 */
  async createStaff(actor: AuthUser, input: { account: string; name: string; departmentId?: number | null; positionId?: number | null; managerId?: number | null; title?: string; baseSalary?: number | null; payType?: 'monthly' | 'hourly'; hourlyRate?: number | null; employmentType?: 'regular' | 'part_time' | 'temp'; extraPositionIds?: number[] }) {
    const account = input.account.trim();
    const initialPassword = generatePassword();
    const passwordHash = await bcrypt.hash(initialPassword, 10);
    const id = await this.ds.transaction(async (em) => {
      await this.mustDepartment(em, actor.companyId, input.departmentId);
      await this.mustPosition(em, actor.companyId, input.positionId);
      const extra = await this.cleanExtraPositions(em, actor.companyId, input.positionId ?? null, input.extraPositionIds);
      if (input.managerId) await this.mustActiveUser(em, actor.companyId, input.managerId, '直属上级');
      if (((input.baseSalary !== undefined && input.baseSalary !== null) || (input.hourlyRate !== undefined && input.hourlyRate !== null) || (input.payType !== undefined && input.payType !== 'monthly')) && !this.canSalary(actor)) throw new ForbiddenException('没有设置底薪的权限');
      // 账号全系统唯一（登录不填公司），提示不透露是哪家公司在用
      if ((await em.findOne(User, { where: { account } })) || (await em.findOne(PlatformAdmin, { where: { account } }))) throw new ConflictException('这个账号已经存在，请换一个');
      const u = await em.save(User, em.create(User, {
        companyId: actor.companyId, account, passwordHash, name: input.name.trim(),
        departmentId: input.departmentId ?? null, positionId: input.positionId ?? null, extraPositionIds: extra.length ? extra : null,
        managerId: input.managerId ?? null, title: input.title?.trim() || null, baseSalary: input.baseSalary ?? null,
        payType: input.payType ?? 'monthly', hourlyRate: input.hourlyRate ?? null, employmentType: input.employmentType ?? 'regular',
        isCompanyAdmin: false, status: 'active', mustChangePassword: true,
      }));
      await this.audit(em, actor, 'user.create', 'user', u.id, { account, positionId: u.positionId, extraPositionIds: u.extraPositionIds });
      return u.id;
    });
    return { staff: await this.getStaff(actor, id), initialPassword };
  }

  private async mustActiveUser(em: EntityManager, companyId: number, id: number, what: string) {
    const u = await em.findOne(User, { where: { id, companyId } });
    if (!u) throw new BadRequestException(`${what}不存在`);
    if (u.status !== 'active') throw new BadRequestException(`${what}已停用，请选在职员工`);
    return u;
  }

  private async mustEditable(em: EntityManager, actor: AuthUser, id: number) {
    const u = await em.findOne(User, { where: { id, companyId: actor.companyId } });
    if (!u) throw new NotFoundException('员工不存在');
    // 公司管理员只能由管理员自己改，避免有“修改员工”权限的人动老板
    if (u.isCompanyAdmin && !actor.permissions.isCompanyAdmin) throw new ForbiddenException('不能修改公司管理员');
    return u;
  }

  private payText(type: string, base: number | null, hourly: number | null) {
    const yuan = (v: number | null) => ((v ?? 0) / 100).toFixed(2);
    return type === 'hourly' ? `时薪 ${yuan(hourly)} 元/小时` : `月薪 ${yuan(base)} 元/月`;
  }

  async updateStaff(actor: AuthUser, id: number, input: { name?: string; departmentId?: number | null; positionId?: number | null; managerId?: number | null; title?: string | null; baseSalary?: number | null; payType?: 'monthly' | 'hourly'; hourlyRate?: number | null; employmentType?: 'regular' | 'part_time' | 'temp'; extraPositionIds?: number[] }) {
    await this.ds.transaction(async (em) => {
      const u = await this.mustEditable(em, actor, id);
      if ((input.positionId !== undefined || input.extraPositionIds !== undefined) && id === actor.id && !actor.permissions.isCompanyAdmin) throw new ForbiddenException('不能修改自己的岗位');
      if (input.name !== undefined) u.name = input.name.trim();
      if (input.departmentId !== undefined) { await this.mustDepartment(em, actor.companyId, input.departmentId); u.departmentId = input.departmentId; }
      if (input.positionId !== undefined) { await this.mustPosition(em, actor.companyId, input.positionId); u.positionId = input.positionId; }
      if (input.positionId !== undefined || input.extraPositionIds !== undefined) {
        const extra = await this.cleanExtraPositions(em, actor.companyId, u.positionId, input.extraPositionIds ?? (u.positionId ? (u.extraPositionIds ?? []).filter((x) => x !== u.positionId) : []));
        u.extraPositionIds = extra.length ? extra : null;
      }
      if (input.managerId !== undefined) {
        if (input.managerId !== null) {
          if (input.managerId === id) throw new BadRequestException('直属上级不能是自己');
          if (input.managerId !== u.managerId) await this.mustActiveUser(em, actor.companyId, input.managerId, '直属上级');
          // 沿上级链往上走，遇到自己就是成环
          let cur: number | null = input.managerId;
          for (let guard = 0; cur !== null && guard < 100; guard++) {
            if (cur === id) throw new BadRequestException('直属上级不能是自己的下级');
            cur = (await em.findOne(User, { where: { id: cur, companyId: actor.companyId }, select: ['id', 'managerId'] }))?.managerId ?? null;
          }
        }
        u.managerId = input.managerId;
      }
      if (input.title !== undefined) u.title = input.title?.trim() || null;
      if (input.employmentType !== undefined) u.employmentType = input.employmentType;
      let salaryChange: { from: number | null; to: number | null } | null = null;
      const beforePay = { type: u.payType, base: u.baseSalary ?? null, hourly: u.hourlyRate ?? null };
      if (input.baseSalary !== undefined || input.payType !== undefined || input.hourlyRate !== undefined) {
        if (!this.canSalary(actor)) throw new ForbiddenException('没有设置底薪的权限');
      }
      if (input.baseSalary !== undefined) {
        if ((u.baseSalary ?? null) !== input.baseSalary) salaryChange = { from: u.baseSalary ?? null, to: input.baseSalary };
        u.baseSalary = input.baseSalary;
      }
      if (input.payType !== undefined) u.payType = input.payType;
      if (input.hourlyRate !== undefined) u.hourlyRate = input.hourlyRate;
      await em.save(u);
      const { baseSalary: _salary, hourlyRate: _hourly, ...logged } = input;
      await this.audit(em, actor, 'user.update', 'user', id, { ...logged });
      if (salaryChange) await this.audit(em, actor, 'user.salary', 'user', id, salaryChange);
      // 月薪、时薪或计薪方式变了：写一条薪资变更记录（员工档案的“薪资变更”里看）
      const payChanged = beforePay.type !== u.payType || (u.payType === 'hourly' ? beforePay.hourly !== (u.hourlyRate ?? null) : beforePay.base !== (u.baseSalary ?? null));
      if (payChanged) {
        await em.insert(EmployeeCompensationRecord, {
          companyId: actor.companyId, userId: id, recordType: 'salary_change',
          title: beforePay.type !== u.payType ? '计薪方式变更' : u.payType === 'hourly' ? '时薪变更' : '月薪变更',
          amount: (u.payType === 'hourly' ? u.hourlyRate : u.baseSalary) ?? 0,
          effectiveDate: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
          reason: `${this.payText(beforePay.type, beforePay.base, beforePay.hourly)} 调整为 ${this.payText(u.payType, u.baseSalary ?? null, u.hourlyRate ?? null)}`,
          sourceType: 'employee_profile', actorId: actor.id, payPeriod: null, sourceId: null,
        });
      }
    });
    return this.getStaff(actor, id);
  }

  async setOverrides(actor: AuthUser, id: number, allow: string[], deny: string[]) {
    const a = [...new Set(allow)];
    const d = [...new Set(deny)];
    if (a.some((k) => d.includes(k))) throw new BadRequestException('同一项权限不能既允许又拒绝');
    this.checkGrantable(actor, a);
    this.checkGrantable(actor, d); // 拒绝也要在清单里；非管理员只能拒绝自己有的项，足够
    if (!actor.permissions.isCompanyAdmin && id === actor.id) throw new ForbiddenException('不能修改自己的权限');
    await this.ds.transaction(async (em) => {
      await this.mustEditable(em, actor, id);
      await em.delete(UserPermissionOverride, { userId: id });
      const rows = [...a.map((permission) => ({ userId: id, permission, effect: 'allow' as const })), ...d.map((permission) => ({ userId: id, permission, effect: 'deny' as const }))];
      if (rows.length > 0) await em.insert(UserPermissionOverride, rows);
      await this.audit(em, actor, 'user.overrides', 'user', id, { allow: a, deny: d });
    });
    return this.getStaff(actor, id);
  }

  // ---------- 停用交接 ----------
  /** 建议的接收人：同岗位（优先同部门）在职同事 → 直属上级 → 公司管理员。 */
  private async suggestHandoverTarget(em: EntityManager, u: User): Promise<{ id: number; name: string; via: string } | null> {
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

  private async handoverCounts(em: EntityManager, u: User) {
    const workItems = await em.count(WorkItem, { where: { companyId: u.companyId, assigneeId: u.id, status: 'open' } });
    const steps = (await em.find(FlowStep, { where: { companyId: u.companyId, status: 'active' }, select: ['id', 'recipients'] })).filter((x) => (x.recipients ?? []).includes(u.id)).length;
    const routines = await em.count(TaskRoutine, { where: { companyId: u.companyId, assigneeId: u.id, active: true } });
    return { workItems, flowSteps: steps, routines, total: workItems + routines };
  }

  /** 停用前预览：有多少待办/流程步骤/周期任务要交接，建议交给谁。 */
  async handoverPreview(actor: AuthUser, id: number) {
    const em = this.ds.manager;
    const u = await em.findOne(User, { where: { id, companyId: actor.companyId } });
    if (!u) throw new NotFoundException('员工不存在');
    const [counts, suggested, candidates] = await Promise.all([
      this.handoverCounts(em, u),
      this.suggestHandoverTarget(em, u),
      em.find(User, { where: { companyId: actor.companyId, status: 'active' }, select: ['id', 'name'], order: { name: 'ASC' } }),
    ]);
    return { counts, suggested, candidates: candidates.filter((c) => c.id !== id).map((c) => ({ id: c.id, name: c.name })) };
  }

  /** 把停用员工手上的待办、流程步骤、周期任务交给接收人，并留下交接记录。 */
  private async doHandover(em: EntityManager, actor: AuthUser, u: User, target: { id: number; name: string }, reason: string) {
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
    await this.audit(em, actor, 'user.handover', 'user', u.id, { ...result, reason });
    return result;
  }

  /** 调岗、请假时手动交接：把员工手上未完成的待办、流程步骤、周期任务交给接收人（不停用）。 */
  async handover(actor: AuthUser, id: number, input: { targetUserId?: number; reason?: string }) {
    const reason = (input.reason ?? '').trim() || '人员档案中手动交接';
    const result = await this.ds.transaction(async (em) => {
      const u = await this.mustEditable(em, actor, id);
      let target: { id: number; name: string } | null = null;
      if (input.targetUserId) {
        if (input.targetUserId === id) throw new BadRequestException('接收人不能是交出人自己');
        target = await this.mustActiveUser(em, actor.companyId, input.targetUserId, '接收人');
      } else target = await this.suggestHandoverTarget(em, u);
      if (!target) throw new ConflictException('找不到可以接收交接的在职人员，请指定接收人');
      return this.doHandover(em, actor, u, target, reason);
    });
    return result;
  }

  /** 人员记录：人事记录、薪资变更、工资发放、奖励、处罚、任务、流程、交接。薪酬类要 org.staff.salary 权限。 */
  async staffRecords(actor: AuthUser, id: number) {
    const em = this.ds.manager;
    const u = await em.findOne(User, { where: { id, companyId: actor.companyId } });
    if (!u) throw new NotFoundException('员工不存在');
    const nameOf = async (ids: Array<number | null>) => {
      const list = [...new Set(ids.filter((x): x is number => !!x))];
      const rows = list.length ? await em.find(User, { where: { companyId: actor.companyId, id: In(list) }, select: ['id', 'name'] }) : [];
      return new Map(rows.map((r) => [r.id, r.name]));
    };
    const hrLogs: Array<{ id: string; action: string; actorName: string | null; detail: unknown; createdAt: Date }> = await em.query(
      `SELECT a.id, a.action, a.detail, a.created_at AS createdAt, u.name AS actorName
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.company_id = ? AND a.resource_type = 'user' AND a.resource_id = ? ORDER BY a.id DESC LIMIT 50`,
      [actor.companyId, String(id)],
    );
    const sal = this.canSalary(actor);
    const comp = async (type: string) => {
      if (!sal) return [];
      const rows = await em.find(EmployeeCompensationRecord, { where: { companyId: actor.companyId, userId: id, recordType: type }, order: { id: 'DESC' }, take: 50 });
      const names = await nameOf(rows.map((r) => r.actorId));
      return rows.map((r) => ({ id: r.id, title: r.title, amount: r.amount, effectiveDate: r.effectiveDate, payPeriod: r.payPeriod, reason: r.reason, actorName: r.actorId ? names.get(r.actorId) ?? null : null, createdAt: r.createdAt }));
    };
    const [salaryChanges, payrollRecords, rewardRecords, penaltyRecords] = await Promise.all([comp('salary_change'), comp('payroll'), comp('reward'), comp('penalty')]);
    const items = await em.find(WorkItem, { where: [{ companyId: actor.companyId, assigneeId: id }, { companyId: actor.companyId, createdBy: id }], order: { id: 'DESC' }, take: 50 });
    const itemNames = await nameOf(items.flatMap((i) => [i.assigneeId, i.createdBy]));
    const runs = await em.find(FlowRun, { where: { companyId: actor.companyId, requesterId: id }, order: { id: 'DESC' }, take: 50 });
    const handled = await em.find(FlowStep, { where: { companyId: actor.companyId, handledBy: id }, order: { id: 'DESC' }, take: 50 });
    const handovers: Array<{ id: string; detail: Record<string, unknown>; actorName: string | null; createdAt: Date; fromUserId: string }> = await em.query(
      `SELECT a.id, a.detail, a.created_at AS createdAt, a.resource_id AS fromUserId, u.name AS actorName
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.company_id = ? AND a.action = 'user.handover' AND (a.resource_id = ? OR JSON_EXTRACT(a.detail, '$.toUserId') = ?) ORDER BY a.id DESC LIMIT 50`,
      [actor.companyId, String(id), id],
    );
    const hn = await nameOf(handovers.flatMap((h) => [Number(h.fromUserId), Number(h.detail?.toUserId)]));
    return {
      hrLogs,
      salaryChanges, payrollRecords, rewardRecords, penaltyRecords,
      tasks: items.map((i) => ({ id: i.id, title: i.title, status: i.status, assigneeName: itemNames.get(i.assigneeId) ?? null, createdByName: i.createdBy ? itemNames.get(i.createdBy) ?? null : null, dueAt: i.dueAt, createdAt: i.createdAt })),
      flows: [
        ...runs.map((r) => ({ id: `run-${r.id}`, title: r.title, kind: '发起的流程', status: r.status, action: null as string | null, createdAt: r.createdAt })),
        ...handled.map((st) => ({ id: `step-${st.id}`, title: st.stepName, kind: '办理的节点', status: st.status, action: st.action, createdAt: st.finishedAt ?? st.enteredAt })),
      ],
      handovers: handovers.map((h) => ({ id: h.id, fromName: hn.get(Number(h.fromUserId)) ?? null, toName: hn.get(Number(h.detail?.toUserId)) ?? (h.detail?.toUserName as string | undefined) ?? null, actorName: h.actorName, reason: (h.detail?.reason as string | undefined) ?? null, workItems: Number(h.detail?.workItems ?? 0), flowSteps: Number(h.detail?.flowSteps ?? 0), routines: Number(h.detail?.routines ?? 0), createdAt: h.createdAt })),
    };
  }

  async setStatus(actor: AuthUser, id: number, status: 'active' | 'disabled', reason?: string, handoverToUserId?: number) {
    if (status === 'disabled' && !(reason && reason.trim().length >= 2)) throw new BadRequestException('停用员工必须填写原因');
    let handover: Awaited<ReturnType<OrgAdminService['doHandover']>> | null = null;
    await this.ds.transaction(async (em) => {
      const u = await this.mustEditable(em, actor, id);
      if (status === 'disabled') {
        if (id === actor.id) throw new BadRequestException('不能停用自己');
        if (u.isCompanyAdmin && (await em.count(User, { where: { companyId: actor.companyId, isCompanyAdmin: true, status: 'active' } })) <= 1) {
          throw new BadRequestException('不能停用最后一个公司管理员');
        }
        const counts = await this.handoverCounts(em, u);
        if (counts.workItems + counts.flowSteps + counts.routines > 0 || handoverToUserId) {
          let target: { id: number; name: string } | null = null;
          if (handoverToUserId) {
            if (handoverToUserId === id) throw new BadRequestException('接收人不能是被停用的员工');
            target = await this.mustActiveUser(em, actor.companyId, handoverToUserId, '接收人');
          } else target = await this.suggestHandoverTarget(em, u);
          if (!target) throw new ConflictException('找不到可以接收交接的在职人员，请指定接收人');
          handover = await this.doHandover(em, actor, u, target, reason!.trim());
        }
      }
      u.status = status;
      await em.save(u);
      await this.audit(em, actor, status === 'disabled' ? 'user.disable' : 'user.enable', 'user', id, status === 'disabled' ? { reason: reason!.trim() } : null);
    });
    return { ...(await this.getStaff(actor, id)), handover };
  }

  async resetPassword(actor: AuthUser, id: number) {
    const password = generatePassword();
    const hash = await bcrypt.hash(password, 10);
    await this.ds.transaction(async (em) => {
      const u = await this.mustEditable(em, actor, id);
      u.passwordHash = hash;
      u.mustChangePassword = true;
      await em.save(u);
      await this.audit(em, actor, 'user.reset_password', 'user', id, null);
    });
    return { password };
  }
}
