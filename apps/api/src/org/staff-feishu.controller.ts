import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { StaffFeishuService } from './staff-feishu.service';
class TestNoticeDto {
  @IsUUID('4') requestId!:string;
  @IsOptional() @IsString() @MaxLength(100) title?:string;
  @IsOptional() @IsString() @MaxLength(2000) body?:string;
}
class ResetBindingsDto { @IsString() @Matches(/^[a-f0-9]{64}$/) fingerprint!:string }
@Controller('org/staff-feishu')
export class StaffFeishuController {
  constructor(private readonly service:StaffFeishuService) {}
  @RequirePermission('org.staff.view') @Get()
  statuses(@CurrentUser() u:AuthUser){return this.service.statuses(u);}
  @RequirePermission('org.staff.view','org.staff.edit') @Get('reset-preview')
  resetPreview(@CurrentUser() u:AuthUser){return this.service.resetPreview(u);}
  @RequirePermission('org.staff.view','org.staff.edit') @Post('reset-bindings')
  resetBindings(@CurrentUser() u:AuthUser,@Body() b:ResetBindingsDto){return this.service.resetBindings(u,b.fingerprint);}
  @Throttle({default:{limit:20,ttl:60000}})
  @RequirePermission('org.staff.view','org.staff.edit') @Post(':id/test-notifications')
  send(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:TestNoticeDto){return this.service.sendTest(u,id,b.requestId,{title:b.title,body:b.body});}
  @RequirePermission('org.staff.view','org.staff.edit') @Get(':id/test-notifications/:jobId')
  status(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Param('jobId',ParseIntPipe) jobId:number){return this.service.testStatus(u,id,jobId);}
}
