import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, AuthenticatedOnly, CurrentUser } from '../common/auth.decorators';
import { PackagingImportService, PackagingSheetRows } from './packaging-import.service';

class ImportDto {
  @IsArray() schemes!: Array<Record<string, string>>;
  @IsArray() lines!: Array<Record<string, string>>;
  @IsArray() rules!: Array<Record<string, string>>;
  @IsOptional() @IsString() @MaxLength(40) confirm?: string;
}

@Controller('finance/packaging')
export class PackagingImportController {
  constructor(private readonly svc: PackagingImportService) {}

  /** 权限在服务里按包装方案资料权限检查 */
  @AuthenticatedOnly() @Get('export')
  export(@CurrentUser() u: AuthUser) { return this.svc.exportRows(u); }

  @AuthenticatedOnly() @Post('import/preflight')
  preflight(@CurrentUser() u: AuthUser, @Body() dto: ImportDto) { return this.svc.preflight(u, this.rows(dto)); }

  @AuthenticatedOnly() @Post('import/execute')
  execute(@CurrentUser() u: AuthUser, @Body() dto: ImportDto) { return this.svc.execute(u, this.rows(dto), dto.confirm ?? ''); }

  private rows(dto: ImportDto): PackagingSheetRows { return { schemes: dto.schemes, lines: dto.lines, rules: dto.rules }; }
}
