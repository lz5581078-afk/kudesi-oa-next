import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { AssistantService } from './assistant.service';

class AssistantDto {
  @IsString() @MaxLength(80) appId!: string;
  @IsOptional() @IsString() @MaxLength(200) appSecret?: string;
  @IsString() @MaxLength(100) tenantKey!: string;
  @IsBoolean() enabled!: boolean;
  @IsBoolean() morningEnabled!: boolean;
  @IsBoolean() welcomeEnabled!: boolean;
  @IsString() @MaxLength(1000) morningText!: string;
  @IsString() @MaxLength(1000) welcomeText!: string;
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(100, { each: true }) departmentIds!: string[];
}

@Controller('settings/feishu-assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}
  @Get() @RequirePermission('system.integrations.view')
  overview(@CurrentUser() user: AuthUser) { return this.assistant.overview(user.companyId); }
  @Put() @RequirePermission('system.integrations.edit')
  save(@CurrentUser() user: AuthUser, @Body() body: AssistantDto) { return this.assistant.save(user, body); }
  @Post('test') @RequirePermission('system.integrations.edit')
  test(@CurrentUser() user: AuthUser) { return this.assistant.test(user); }
}
