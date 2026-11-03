import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { createChecker, resolvePermissions, todayShanghai, validateWorkforceTerms, type EnrollmentTerms } from '@kudesi/shared';
import { accountTransaction } from '../auth/account-transaction';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, Company, Department, PlatformAdmin, Position, PositionPermission, UserPermissionOverride, User } from '../entities';
import { ResourcesService } from '../resources/resources.service';
import { StaffEnrollmentInvite } from './staff-enrollment.entity';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const validToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);

@Injectable()
export class StaffEnrollmentService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly resources: ResourcesService) {}

  private need(actor: AuthUser) {
    if (!createChecker(actor.permissions)('org.staff.create')) throw new ForbiddenException('没有创建员工的权限');
  }
  private async position(em: EntityManager, companyId: number, id: number) {
    const row = await em.findOne(Position, { where: { companyId, id, status: 'active' } });
    if (!row) throw new BadRequestException('岗位已停用或不存在，请联系人事');
    if (row.departmentId) {
      const department = await em.findOne(Department, { where: { id: row.departmentId, companyId, status: 'active' } });
      if (!department) throw new BadRequestException('岗位所在部门已停用，请联系人事');
    }
    return row;
  }
  private audit(em: EntityManager, companyId: number, actorId: number, action: string, id: number, detail: Record<string, unknown>) {
    return em.save(AuditLog, em.create(AuditLog, { companyId, actorId, action, resourceType: 'staff-enrollment', resourceId: String(id), detail }));
  }
  async create(actor: AuthUser, input: { mode: 'general' | 'position'; positionId?: number; validDays?: number } & EnrollmentTerms) {
    this.need(actor);
    if (!['general', 'position'].includes(input.mode)) throw new BadRequestException('请选择二维码类型');
    if (input.mode === 'general' && input.positionId !== undefined) throw new BadRequestException('通用二维码不能预设岗位');
    if (input.mode === 'position' && !Number.isInteger(input.positionId)) throw new BadRequestException('请选择岗位');
    const employmentType = input.employmentType ?? 'regular';
    if (!['regular','part_time','temp'].includes(employmentType)) throw new BadRequestException('请选择有效用工类型');
    if (employmentType !== 'regular' && !createChecker(actor.permissions)('resource.workforce.create')) throw new ForbiddenException('没有创建兼职与临时工档案的权限');
    // New codes carry the employment type only; dates are set when the employee actually joins.
    const contractStartDate = null, contractEndDate = null;
    const token = randomBytes(32).toString('base64url');
    const invite = await this.ds.transaction(async em => {
      const company = await em.findOne(Company, { where: { id: actor.companyId, status: 'active' }, lock: { mode: 'pessimistic_write' } });
      if (!company) throw new ForbiddenException('公司已停用');
      if (input.mode === 'position') await this.position(em, actor.companyId, input.positionId!);
      const replaced = await em.find(StaffEnrollmentInvite, { where: { companyId: actor.companyId, mode: input.mode, ...(input.mode === 'position' ? {positionId: input.positionId!} : {}), revokedAt: IsNull() } });
      for (const previous of replaced) {
        previous.revokedAt = new Date(); await em.save(previous);
        await this.audit(em, actor.companyId, actor.id, 'staff-enrollment.revoke', previous.id, { reason: 'replaced-by-new-code' });
      }
      const row = await em.save(StaffEnrollmentInvite, em.create(StaffEnrollmentInvite, {
        employmentType, contractStartDate, contractEndDate, companyId: actor.companyId, mode: input.mode, positionId: input.mode === 'position' ? input.positionId! : null,
        tokenHash: digest(token), createdBy: actor.id, expiresAt: null, revokedAt: null,
      }));
      await this.audit(em, actor.companyId, actor.id, 'staff-enrollment.create', row.id, { mode: row.mode, employmentType: row.employmentType, contractStartDate: row.contractStartDate, contractEndDate: row.contractEndDate, positionId: row.positionId, expiresAt: row.expiresAt?.toISOString() ?? null });
      return row;
    });
    return { id: invite.id, token, employmentType: invite.employmentType, contractStartDate: invite.contractStartDate, contractEndDate: invite.contractEndDate, mode: invite.mode, positionId: invite.positionId, expiresAt: invite.expiresAt?.toISOString() ?? null };
  }
  async list(actor: AuthUser) {
    this.need(actor);
    const rows = await this.ds.manager.find(StaffEnrollmentInvite, { where: { companyId: actor.companyId }, order: { id: 'DESC' }, take: 100 });
    const positions = await this.ds.manager.find(Position, { where: { companyId: actor.companyId }, select: ['id', 'name'] });
    return rows.map(row => ({ id: row.id, employmentType: row.employmentType, contractStartDate: row.contractStartDate, contractEndDate: row.contractEndDate, mode: row.mode, positionId: row.positionId, positionName: positions.find(p => p.id === row.positionId)?.name ?? '', expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), status: row.revokedAt ? 'revoked' : row.expiresAt && row.expiresAt.getTime() <= Date.now() ? 'expired' : 'active' }));
  }
  async revoke(actor: AuthUser, id: number) {
    this.need(actor);
    await this.ds.transaction(async em => {
      await em.findOne(Company, {where:{id:actor.companyId},lock:{mode:'pessimistic_write'}});
      const row = await em.findOne(StaffEnrollmentInvite, { where: { companyId: actor.companyId, id }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException('没有这个入职二维码');
      if (row.revokedAt) return;
      row.revokedAt = new Date(); await em.save(row);
      await this.audit(em, actor.companyId, actor.id, 'staff-enrollment.revoke', id, {});
    });
    return { ok: true };
  }
  private async resolve(em: EntityManager, token: string, lock = false) {
    if (!validToken(token)) throw new NotFoundException('入职二维码无效，请联系人事重新获取');
    let invite = await em.findOne(StaffEnrollmentInvite, { where: { tokenHash: digest(token) } });
    if (!invite) throw new NotFoundException('入职二维码已失效，请联系人事重新获取');
    const company = await em.findOne(Company, { where: {id: invite.companyId, status:'active'}, ...(lock ? {lock:{mode:'pessimistic_write' as const}} : {}) });
    if (lock) invite = await em.findOne(StaffEnrollmentInvite, {where:{tokenHash:digest(token)},lock:{mode:'pessimistic_write'}});
    if (!invite || invite.revokedAt || invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) throw new NotFoundException('入职二维码已失效，请联系人事重新获取');
    const creator = await em.findOneBy(User, { id: invite.createdBy, companyId: invite.companyId, status: 'active' });
    if (!company || !creator) throw new NotFoundException('入职二维码已失效，请联系人事');
    return { invite, company };
  }
  async preview(token: string) {
    const em = this.ds.manager;
    const { invite, company } = await this.resolve(em, token);
    const departments = await em.find(Department, { where: { companyId: company.id, status: 'active' }, select: ['id', 'name'] });
    const allowed = new Set(departments.map(d => d.id));
    const all = await em.find(Position, { where: { companyId: company.id, status: 'active' }, order: { sortOrder: 'ASC', id: 'ASC' } });
    const positions = all.filter(p => !p.departmentId || allowed.has(p.departmentId));
    if (invite.mode === 'position') await this.position(em, company.id, invite.positionId!);
    return {
      companyName: company.name, employmentType: invite.employmentType, contractStartDate: invite.contractStartDate, contractEndDate: invite.contractEndDate, mode: invite.mode, expiresAt: invite.expiresAt?.toISOString() ?? null,
      position: invite.mode === 'position' ? { id: invite.positionId!, name: positions.find(p => p.id === invite.positionId)?.name ?? '' } : null,
      positions: invite.mode === 'general' ? positions.map(p => ({ id: p.id, name: p.name, departmentName: departments.find(d => d.id === p.departmentId)?.name ?? '' })) : [],
    };
  }
  private async issuer(em: EntityManager, companyId: number, id: number): Promise<AuthUser> {
    const person = await em.findOneByOrFail(User, { companyId, id, status: 'active' });
    const ids = [person.positionId, ...(person.extraPositionIds ?? [])].filter((id): id is number => !!id);
    const positions = ids.length ? await em.find(Position, { where: { companyId, id: In(ids), status: 'active' } }) : [];
    const rows = positions.length ? await em.find(PositionPermission, { where: { positionId: In(positions.map(p => p.id)) } }) : [];
    const overrides = await em.find(UserPermissionOverride, { where: { userId: id } });
    const permissions = resolvePermissions({ isCompanyAdmin: person.isCompanyAdmin, positionPermissions: rows.map(r => r.permission), overrides });
    const actor = { id, companyId, name: person.name, permissions };
    this.need(actor);
    if (!createChecker(permissions)('resource.workforce.create')) throw new ForbiddenException('发码人已无兼职与临时工建档权限，请联系人事重新获取入职码');
    return actor;
  }
  async join(input: { token: string; name: string; phone: string; password: string; positionId?: number }) {
    const name = input.name.trim(), phone = input.phone.trim();
    if (!name || name.length > 50) throw new BadRequestException('请填写姓名（最多50字）');
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new BadRequestException('请填写有效的11位手机号');
    if (input.password.length < 10 || input.password.length > 64 || Buffer.byteLength(input.password, 'utf8') > 72) throw new BadRequestException('密码需至少10位，过长时请缩短后重试');
    await this.resolve(this.ds.manager, input.token);
    const passwordHash = await bcrypt.hash(input.password, 10);
    return accountTransaction(this.ds, phone, async em => {
      const { invite, company } = await this.resolve(em, input.token, true);
      if (invite.mode === 'position' && input.positionId !== undefined && input.positionId !== invite.positionId) throw new BadRequestException('二维码已固定岗位，不能更换');
      const positionId = invite.mode === 'position' ? invite.positionId : input.positionId;
      if (!positionId || !Number.isInteger(positionId)) throw new BadRequestException('请选择岗位');
      const position = await this.position(em, company.id, positionId);
      if (await em.findOneBy(User, { account: phone }) || await em.findOneBy(PlatformAdmin, { account: phone })) throw new ConflictException('该手机号暂不能注册，请直接登录或联系人事');
      const user = await em.save(User, em.create(User, { companyId: company.id, account: phone, passwordHash, name,
        departmentId: position.departmentId, positionId: position.id, extraPositionIds: null,
        managerId: null, title: null, baseSalary: null, payType: 'monthly', hourlyRate: null, employmentType: invite.employmentType,
        isCompanyAdmin: false, status: 'active', mustChangePassword: false,
      }));
      if (invite.employmentType !== 'regular') {
        const contractStartDate = invite.contractStartDate || todayShanghai();
        const problem = validateWorkforceTerms({...invite,contractStartDate});
        if (problem) throw new BadRequestException(problem);
        if (invite.contractEndDate && invite.contractEndDate < todayShanghai()) throw new BadRequestException('合作期已结束，请联系人事重新获取入职码');
        const issuer = await this.issuer(em, company.id, invite.createdBy);
        await this.resources.createRecord(em, issuer, 'workforce', {
          userId: user.id, employmentType: invite.employmentType, phone,
          contractStartDate, contractEndDate: invite.contractEndDate,
        }, '员工扫描入职码自动建档');
      }
      await this.audit(em, company.id, user.id, 'user.self-enroll', user.id, { inviteId: invite.id, positionId: position.id, mode: invite.mode, employmentType: invite.employmentType });
      return { account: phone, companyName: company.name, positionName: position.name };
    });
  }
}
