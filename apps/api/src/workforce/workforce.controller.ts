import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { unfiledWorkforce } from './workforce-contract';

/** 兼职与临时工的辅助接口（档案本身走通用的 /api/resources/workforce）。公司只取自令牌。 */
@Controller('workforce')
export class WorkforceController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 用工类型是兼职/临时工、账号在用但还没建档案的人：这些人的合作期不受登录控制，档案页顶部提示补档案。 */
  @RequirePermission('resource.workforce.view')
  @Get('unfiled')
  unfiled(@CurrentUser() user: AuthUser) {
    return unfiledWorkforce(this.ds.manager, user.companyId);
  }
}
