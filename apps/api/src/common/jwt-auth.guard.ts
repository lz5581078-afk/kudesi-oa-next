import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { resolvePermissions } from '@kudesi/shared';
import { Company, PlatformAdmin, PositionPermission, User, UserPermissionOverride } from '../entities';
import { AuthUser, IS_PUBLIC, PLATFORM_ONLY } from './auth.decorators';

interface TokenPayload {
  sub: number;
  cid?: number;
  /** 平台管理员令牌带 typ=platform，没有公司 */
  typ?: 'platform';
}

/**
 * 全局登录守卫。令牌只证明“你是谁、哪家公司”，
 * 状态（是否停用、岗位、权限）每次请求都从数据库重新读取，
 * 所以停用员工、调岗、改权限立即生效，不用等令牌过期。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(PlatformAdmin) private readonly platformAdmins: Repository<PlatformAdmin>,
    @InjectRepository(Company) private readonly companies: Repository<Company>,
    @InjectRepository(PositionPermission) private readonly positionPermissions: Repository<PositionPermission>,
    @InjectRepository(UserPermissionOverride) private readonly overrides: Repository<UserPermissionOverride>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('请先登录');

    let payload: TokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenPayload>(header.slice(7));
    } catch {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }

    const platformOnly = this.reflector.getAllAndOverride<boolean>(PLATFORM_ONLY, [context.getHandler(), context.getClass()]);
    if (payload.typ === 'platform') {
      // 平台管理员令牌只能访问平台后台接口，不能碰任何公司业务接口
      if (!platformOnly) throw new ForbiddenException('平台管理员不能访问企业业务接口');
      const admin = await this.platformAdmins.findOne({ where: { id: payload.sub } });
      if (!admin || admin.status !== 'active') throw new UnauthorizedException('账号不可用');
      request.platformAdmin = { id: admin.id, name: admin.name, account: admin.account };
      return true;
    }
    if (platformOnly) throw new ForbiddenException('仅平台管理员可以执行该操作');
    if (!payload.cid) throw new UnauthorizedException('登录已失效，请重新登录');

    const user = await this.users.findOne({ where: { id: payload.sub, companyId: payload.cid } });
    if (!user || user.status !== 'active') throw new UnauthorizedException('账号不可用');
    const company = await this.companies.findOne({ where: { id: user.companyId } });
    if (!company || company.status !== 'active') throw new UnauthorizedException('公司已停用');

    const positionRows = (
      await Promise.all([user.positionId, ...(user.extraPositionIds ?? [])].filter((x): x is number => !!x).map((positionId) => this.positionPermissions.find({ where: { positionId } })))
    ).flat();
    const overrideRows = await this.overrides.find({ where: { userId: user.id } });

    const authUser: AuthUser = {
      id: user.id,
      companyId: user.companyId,
      name: user.name,
      permissions: resolvePermissions({
        isCompanyAdmin: user.isCompanyAdmin,
        positionPermissions: positionRows.map((row) => row.permission),
        overrides: overrideRows.map((row) => ({ permission: row.permission, effect: row.effect })),
      }),
    };
    request.user = authUser;
    return true;
  }
}
