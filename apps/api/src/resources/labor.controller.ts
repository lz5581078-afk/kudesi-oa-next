import { Body, Controller, Param, ParseIntPipe, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, AuthenticatedOnly, CurrentUser } from '../common/auth.decorators';
import { LaborCopyService } from './labor-copy.service';

class CopyVersionDto {
  @IsString() @MaxLength(80) versionCode!: string;
  @IsString() @MaxLength(160) versionName!: string;
  @IsOptional() @IsString() @MaxLength(120) periodName?: string;
  @IsOptional() @IsString() @MaxLength(10) effectiveFrom?: string;
  @IsOptional() @IsString() @MaxLength(10) effectiveTo?: string;
  @IsOptional() @IsString() @MaxLength(500) remark?: string;
}

@Controller('finance/labor')
export class LaborController {
  constructor(private readonly copy: LaborCopyService) {}

  /** 权限在服务里按资料权限和成本权限检查 */
  @AuthenticatedOnly() @Post('versions/:id/copy')
  copyVersion(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: CopyVersionDto) {
    return this.copy.copyVersion(u, id, dto);
  }
}
