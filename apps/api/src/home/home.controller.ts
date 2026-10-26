import { Controller, Get } from '@nestjs/common';
import { AuthenticatedOnly, AuthUser, CurrentUser } from '../common/auth.decorators';
import { HomeService } from './home.service';

/** 首页聚合（只读）：人人可进，具体卡片按各自权限在服务里过滤。 */
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @AuthenticatedOnly()
  @Get()
  get(@CurrentUser() user: AuthUser) { return this.home.get(user); }
}
