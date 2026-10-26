import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import type { CompanyApplicationDto, PlatformCompanyDto } from '@kudesi/shared';
import { PlatformAdminUser } from '../common/auth.decorators';
import { AuditLog, Company, CompanyApplication, PlatformAdmin, User } from '../entities';
import { provisionCompany } from '../org/company-provisioning';

export interface ApplyInput {
  companyName: string;
  contactName: string;
  contactPhone: string;
  password: string;
  contactTitle?: string;
  remark?: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** 平台后台：企业申请（公开提交、平台审核）与公司管理。身份只来自令牌，这里的操作人参数都是 @CurrentPlatformAdmin()。 */
@Injectable()
export class PlatformService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 账号全系统唯一：员工、平台管理员都不能重名 */
  private async accountTaken(em: EntityManager, account: string): Promise<boolean> {
    return !!((await em.findOne(User, { where: { account } })) || (await em.findOne(PlatformAdmin, { where: { account } })));
  }

  /** 公开接口：提交开通申请。管理员账号 = 联系人手机号，密码只存哈希。 */
  async apply(input: ApplyInput): Promise<void> {
    const account = input.contactPhone.trim();
    await this.ds.transaction(async (em) => {
      // 提示不区分“已被使用”还是“已被别人申请”，避免被用来探测账号
      if (await this.accountTaken(em, account)) throw new ConflictException('该手机号无法用于申请，请更换或联系平台');
      if (await em.findOne(CompanyApplication, { where: { adminAccount: account, status: 'pending' } })) {
        throw new ConflictException('该手机号已有一份待审核的申请，请等待审核');
      }
      await em.save(
        em.create(CompanyApplication, {
          companyName: input.companyName.trim(),
          contactName: input.contactName.trim(),
          contactPhone: account,
          adminAccount: account,
          adminPasswordHash: await bcrypt.hash(input.password, 10),
          contactTitle: input.contactTitle?.trim() || null,
          remark: input.remark?.trim() || null,
          status: 'pending',
        }),
      );
    });
  }

  async listApplications(): Promise<CompanyApplicationDto[]> {
    const rows = await this.ds.query(`
      SELECT a.*, p.name AS reviewer_name, c.name AS company_name_approved
      FROM company_applications a
      LEFT JOIN platform_admins p ON p.id = a.reviewed_by
      LEFT JOIN companies c ON c.id = a.approved_company_id
      ORDER BY FIELD(a.status, 'pending', 'approved', 'rejected'), a.created_at DESC, a.id DESC`);
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      companyName: String(r.company_name),
      contactName: String(r.contact_name),
      contactPhone: String(r.contact_phone),
      contactTitle: (r.contact_title as string | null) ?? null,
      remark: (r.remark as string | null) ?? null,
      status: r.status as CompanyApplicationDto['status'],
      rejectReason: (r.reject_reason as string | null) ?? null,
      reviewedAt: iso(r.reviewed_at as Date | null),
      reviewedByName: (r.reviewer_name as string | null) ?? null,
      approvedCompanyId: r.approved_company_id == null ? null : Number(r.approved_company_id),
      approvedCompanyName: (r.company_name_approved as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
    }));
  }

  private async lockPending(em: EntityManager, id: number): Promise<CompanyApplication> {
    const app = await em.findOne(CompanyApplication, { where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!app) throw new NotFoundException('没有这份申请');
    if (app.status !== 'pending') throw new ConflictException('这份申请已经处理过了');
    return app;
  }

  /** 通过：开通公司（默认部门/岗位/销售平台）+ 管理员账号，同一事务，失败整体回滚。 */
  async approve(admin: PlatformAdminUser, id: number): Promise<{ companyId: number; companyName: string; adminAccount: string }> {
    return this.ds.transaction(async (em) => {
      const app = await this.lockPending(em, id);
      if (await this.accountTaken(em, app.adminAccount)) throw new ConflictException('该手机号已被其他账号使用，无法开通，请驳回并说明原因');
      let code = '';
      for (let i = 0; i < 5 && !code; i += 1) {
        const candidate = crypto.randomBytes(4).toString('hex');
        if (!(await em.findOne(Company, { where: { code: candidate } }))) code = candidate;
      }
      if (!code) throw new ConflictException('公司标识生成失败，请重试');
      const company = await provisionCompany(em, {
        code,
        name: app.companyName,
        adminAccount: app.adminAccount,
        adminName: app.contactName,
        adminPasswordHash: app.adminPasswordHash,
        mustChangePassword: false,
      });
      await em.update(CompanyApplication, { id: app.id }, { status: 'approved', reviewedBy: admin.id, reviewedAt: new Date(), approvedCompanyId: company.id, rejectReason: null });
      await em.save(em.create(AuditLog, { companyId: company.id, actorId: null, action: 'company.provision', resourceType: 'company', resourceId: String(company.id), detail: { applicationId: app.id, platformAdminId: admin.id } }));
      return { companyId: company.id, companyName: company.name, adminAccount: app.adminAccount };
    });
  }

  async reject(admin: PlatformAdminUser, id: number, reason: string): Promise<void> {
    const text = reason.trim();
    if (!text) throw new BadRequestException('请填写驳回原因');
    await this.ds.transaction(async (em) => {
      const app = await this.lockPending(em, id);
      await em.update(CompanyApplication, { id: app.id }, { status: 'rejected', reviewedBy: admin.id, reviewedAt: new Date(), rejectReason: text });
    });
  }

  async listCompanies(): Promise<PlatformCompanyDto[]> {
    const rows = await this.ds.query(`
      SELECT c.id, c.code, c.name, c.status, c.created_at,
        (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) AS user_count,
        (SELECT GROUP_CONCAT(u.account ORDER BY u.id SEPARATOR ',') FROM users u WHERE u.company_id = c.id AND u.is_company_admin = 1) AS admin_accounts
      FROM companies c ORDER BY c.id`);
    return rows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      code: String(r.code),
      name: String(r.name),
      status: r.status as PlatformCompanyDto['status'],
      userCount: Number(r.user_count),
      adminAccounts: r.admin_accounts ? String(r.admin_accounts).split(',') : [],
      createdAt: (r.created_at as Date).toISOString(),
    }));
  }

  /** 停用公司后，其全部员工立即无法登录/调用（登录守卫每次都核对公司状态）。 */
  async setCompanyStatus(admin: PlatformAdminUser, id: number, status: 'active' | 'suspended'): Promise<void> {
    await this.ds.transaction(async (em) => {
      const company = await em.findOne(Company, { where: { id } });
      if (!company) throw new NotFoundException('没有这家公司');
      if (company.status === status) return;
      await em.update(Company, { id }, { status });
      await em.save(em.create(AuditLog, { companyId: id, actorId: null, action: status === 'suspended' ? 'company.suspend' : 'company.resume', resourceType: 'company', resourceId: String(id), detail: { platformAdminId: admin.id } }));
    });
  }
}
