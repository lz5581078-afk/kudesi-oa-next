import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser } from '../common/auth.decorators';
import { FormDraftsService } from './form-drafts.service';

class DraftDto {
  @IsString() @MaxLength(80) moduleKey!: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(40) sourceRecordId?: string;
  @IsObject() payload!: Record<string, unknown>;
}

/** 表单草稿：只能读写自己的；具体权限（新增某类资料）在服务里按资料类型检查。 */
@Controller('form-drafts')
export class FormDraftsController {
  constructor(private readonly drafts: FormDraftsService) {}

  @AuthenticatedOnly()
  @Get(':key')
  get(@CurrentUser() user: AuthUser, @Param('key') key: string) { return this.drafts.get(user, key); }

  @AuthenticatedOnly()
  @Put(':key')
  put(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() dto: DraftDto) { return this.drafts.put(user, key, dto); }

  @AuthenticatedOnly()
  @Delete(':key')
  remove(@CurrentUser() user: AuthUser, @Param('key') key: string) { return this.drafts.remove(user, key); }
}
