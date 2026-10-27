import { Body, Controller, Get, Put } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { FeishuNoticeService } from './feishu-notice.service';

class SwitchDto { @IsBoolean() enabled!: boolean; @IsOptional() @IsString() @MaxLength(200) note?: string }

/** 飞书通知开关（外部发送，默认关）：看开关由同步页权限决定，改开关只有公司管理员 */
@Controller('finance/feishu-notice')
export class FeishuNoticeController {
  constructor(private readonly feishu: FeishuNoticeService) {}

  @RequirePermission('finance.jst-sync.view')
  @Get('switch')
  async get(@CurrentUser() u: AuthUser) { return { ...(await this.feishu.getSwitch(u.companyId)), counts: await this.feishu.counts(u.companyId) }; }

  @RequirePermission('finance.jst-sync.view')
  @Put('switch')
  set(@CurrentUser() u: AuthUser, @Body() b: SwitchDto) { return this.feishu.setSwitch(u, b.enabled, b.note); }
}
