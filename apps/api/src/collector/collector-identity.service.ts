import { ForbiddenException, Injectable } from '@nestjs/common';
import { createChecker, SPECIAL_PERMISSIONS } from '@kudesi/shared';
import { AuthService } from '../auth/auth.service';
import { AuthUser } from '../common/auth.decorators';
import { SpeechSettingsService } from './speech-settings.service';

@Injectable()
export class CollectorIdentityService {
  constructor(private readonly auth: AuthService, private readonly settings: SpeechSettingsService) {}
  async session(u: AuthUser) {
    const me = await this.auth.me(u.id, u.companyId);
    if (me.mustChangePassword) throw new ForbiddenException('请先在 OA 网页修改初始密码后，再登录采集器');
    if (!createChecker(u.permissions)(SPECIAL_PERMISSIONS.collectorUse)) throw new ForbiddenException('请管理员授予“小白抖音采集器”使用权限');
    const speech = await this.settings.overview(u.companyId);
    return { apiVersion: 1, user: { id: me.id, name: me.name }, company: { id: me.companyId, name: me.companyName }, speech };
  }
}
