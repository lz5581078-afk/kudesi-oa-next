import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsUUID } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { StaffFeishuService } from './staff-feishu.service';
class TestNoticeDto { @IsUUID('4') requestId!:string; }
@Controller('org/staff-feishu')
export class StaffFeishuController {
  constructor(private readonly service:StaffFeishuService) {}
  @RequirePermission('org.staff.view') @Get()
  statuses(@CurrentUser() u:AuthUser){return this.service.statuses(u);}
  @Throttle({default:{limit:20,ttl:60000}})
  @RequirePermission('org.staff.view','org.staff.edit') @Post(':id/test-notifications')
  send(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:TestNoticeDto){return this.service.sendTest(u,id,b.requestId);}
  @RequirePermission('org.staff.view','org.staff.edit') @Get(':id/test-notifications/:jobId')
  status(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Param('jobId',ParseIntPipe) jobId:number){return this.service.testStatus(u,id,jobId);}
}
