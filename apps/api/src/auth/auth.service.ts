import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { CurrentUserDto, LoginResponse, resolvePermissions } from '@kudesi/shared';
import { AuditLog, Company, Position, PositionPermission, User, UserPermissionOverride } from '../entities';

// 用户不存在时也做一次哈希比较，避免通过响应时间判断账号是否存在
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(Company) private readonly companies: Repository<Company>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Position) private readonly positions: Repository<Position>,
    @InjectRepository(PositionPermission) private readonly positionPermissions: Repository<PositionPermission>,
    @InjectRepository(UserPermissionOverride) private readonly overrides: Repository<UserPermissionOverride>,
    @InjectRepository(AuditLog) private readonly audits: Repository<AuditLog>,
  ) {}

  async login(companyCode: string, account: string, password: string): Promise<LoginResponse> {
    const company = await this.companies.findOne({ where: { code: companyCode.trim().toLowerCase() } });
    const user = company
      ? await this.users.findOne({ where: { companyId: company.id, account: account.trim() } })
      : null;

    const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!company || !user || !passwordOk || user.status !== 'active' || company.status !== 'active') {
      // 统一提示，不透露具体是哪一项错了
      throw new UnauthorizedException('公司代码、账号或密码不正确');
    }

    await this.users.update({ id: user.id }, { lastLoginAt: new Date() });
    const accessToken = await this.jwt.signAsync({ sub: user.id, cid: user.companyId });
    return { accessToken, user: await this.buildCurrentUser(user, company) };
  }

  /** 修改自己的密码：必须验证旧密码；新密码至少 10 位且不能与旧密码相同。 */
  async changePassword(userId: number, companyId: number, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.findOneOrFail({ where: { id: userId, companyId } });
    if (!(await bcrypt.compare(oldPassword, user.passwordHash))) {
      throw new BadRequestException('当前密码不正确');
    }
    if (newPassword.length < 10) throw new BadRequestException('新密码至少 10 位');
    if (newPassword === oldPassword) throw new BadRequestException('新密码不能与当前密码相同');
    await this.users.update(
      { id: userId, companyId },
      { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false },
    );
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
      account: user.account,
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
