import { Controller, Post } from '@nestjs/common';
import { AuthUser, AuthenticatedOnly, CurrentUser } from '../common/auth.decorators';
import { FeeArchiveService } from './fee-archive.service';

@Controller('finance/fee-archive')
export class FeeArchiveController {
  constructor(private readonly fees: FeeArchiveService) {}

  /** 权限在服务里按资料权限检查（新建费用档案 + 新建费用类别） */
  @AuthenticatedOnly() @Post('seed')
  seed(@CurrentUser() u: AuthUser) { return this.fees.seed(u); }
}
