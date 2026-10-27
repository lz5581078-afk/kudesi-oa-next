import { Controller, Post } from '@nestjs/common';
import { AuthUser, AuthenticatedOnly, CurrentUser } from '../common/auth.decorators';
import { EmployeePartyService } from './employee-party.service';

@Controller('finance')
export class EmployeePartyController {
  constructor(private readonly employeeParties: EmployeePartyService) {}

  /** 开单选“员工”作往来对象前先同步一下员工名单（权限在服务里检查：要有制单权限） */
  @AuthenticatedOnly() @Post('employee-parties/sync')
  sync(@CurrentUser() u: AuthUser) { return this.employeeParties.sync(u); }
}
