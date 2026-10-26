import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { isLegacyPassword, verifyPassword } from './password';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { CurrentUserDto, LoginResponse, resolvePermissions } from '@kudesi/shared';
import { AuditLog, Company, PlatformAdmin, Position, PositionPermission, User, UserPermissionOverride } from '../entities';

// 用户不存在时也做一次哈希比较，避免通过响应时间判断账号是否存在
const LOGIN_FAILED = '账号或密码不正确';
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(Company) private readonly companies: Repository<Company>,
    @InjectRepository(PlatformAdmin) private readonly platformAdmins: Repository<PlatformAdmin>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Position) private readonly positions: Repository<Position>,
    @InjectRepository(PositionPermission) private readonly positionPermissions: Repository<PositionPermission>,
    @InjectRepository(UserPermissionOverride) private readonly overrides: Repository<UserPermissionOverride>,
    @InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>,
  ) {}

  /**
   * 登录只填账号和密码：账号全系统唯一（平台管理员与员工账号互不重名），
   * 先找平台管理员，再找员工。无论哪一项错都返回同一句提示。
   */
  async login(account: string, password: string): Promise<LoginResponse> {
    const name = account.trim();
    const admin = await this.platformAdmins.findOne({ where: { account: name } });
    const matches = admin ? [] : await this.users.find({ where: { account: name }, take: 2 });
    // 同名账号（历史遗留）不可能判断是谁，直接按失败处理，绝不串到别的公司
    const user = matches.length === 1 ? matches[0] : null;
    const passwordOk = await verifyPassword(password, admin?.passwordHash ?? user?.passwordHash ?? DUMMY_HASH);

    if (admin) {
      if (!passwordOk || admin.status !== 'active') throw new UnauthorizedException(LOGIN_FAILED);
      await this.platformAdmins.update({ id: admin.id }, { lastLoginAt: new Date() });
      const accessToken = await this.jwt.signAsync({ sub: admin.id, typ: 'platform' });
      return { type: 'platform', accessToken, admin: { id: admin.id, name: admin.name, account: admin.account } };
    }

    const company = user ? await this.companies.findOne({ where: { id: user.companyId } }) : null;
    if (!company || !user || !passwordOk || user.status !== 'active' || company.status !== 'active') {
      throw new UnauthorizedException(LOGIN_FAILED);
    }
    const upgrade = isLegacyPassword(user.passwordHash);
    const result = await this.users.update({ id: user.id, companyId: user.companyId, passwordHash: user.passwordHash }, { lastLoginAt: new Date(), ...(upgrade ? { passwordHash: await bcrypt.hash(password, 10) } : {}) });
    if (result && result.affected === 0) throw new UnauthorizedException(LOGIN_FAILED);
    const accessToken = await this.jwt.signAsync({ sub: user.id, cid: user.companyId });
    return { type: 'company', accessToken, user: await this.buildCurrentUser(user, company) };
  }

  /** 修改自己的密码：必须验证旧密码；新密码至少 10 位且不能与旧密码相同。 */
  async changePassword(userId: number, companyId: number, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.findOneOrFail({ where: { id: userId, companyId } });
    if (!(await verifyPassword(oldPassword, user.passwordHash))) {
      throw new BadRequestException('当前密码不正确');
    }
    if (newPassword.length < 10) throw new BadRequestException('新密码至少 10 位');
    if (newPassword === oldPassword) throw new BadRequestException('新密码不能与当前密码相同');
    const changed = await this.users.update(
      { id: userId, companyId, passwordHash: user.passwordHash },
      { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false },
    );
    if (changed && changed.affected === 0) throw new BadRequestException('密码已变更，请重新登录后操作');
    await this.audits.save(
      this.audits.create({
        companyId,
        actorId: userId,
        action: 'user.change_password',
        resourceType: 'user',
        resourceId: String(userId),
        detail: null,
      }),
    );
  }

  async me(userId: number, companyId: number): Promise<CurrentUserDto> {
    const user = await this.users.findOneOrFail({ where: { id: userId, companyId } });
    const company = await this.companies.findOneOrFail({ where: { id: companyId } });
    return this.buildCurrentUser(user, company);
  }

  private async buildCurrentUser(user: User, company: Company): Promise<CurrentUserDto> {
    const position = user.positionId ? await this.positions.findOne({ where: { id: user.positionId } }) : null;
    const positionRows = (
      await Promise.all([user.positionId, ...(user.extraPositionIds ?? [])].filter((x): x is number => !!x).map((positionId) => this.positionPermissions.find({ where: { positionId } })))
    ).flat();
    const overrideRows = await this.overrides.find({ where: { userId: user.id } });
    return {
      id: user.id,
      name: user.name,
      account: user.account ?? '',
      companyId: company.id,
      companyName: company.name,
      positionName: position?.name ?? null,
      mustChangePassword: user.mustChangePassword,
      permissions: resolvePermissions({
        isCompanyAdmin: user.isCompanyAdmin,
        positionPermissions: positionRows.map((row) => row.permission),
        overrides: overrideRows.map((row) => ({ permission: row.permission, effect: row.effect })),
      }),
    };
  }
}
