import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser, AuthenticatedOnly, CurrentUser } from '../common/auth.decorators';
import { FeeArchiveService } from './fee-archive.service';
import { FeeSnapshotService } from './fee-snapshot.service';

class SnapshotDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) remark?: string;
}

@Controller('finance/fee-archive')
export class FeeArchiveController {
  constructor(private readonly fees: FeeArchiveService, private readonly snapshots: FeeSnapshotService) {}

  /** 权限在服务里按资料权限检查（新建费用档案 + 新建费用类别） */
  @AuthenticatedOnly() @Post('seed')
  seed(@CurrentUser() u: AuthUser) { return this.fees.seed(u); }

  // 费用档案存档表：权限同样在服务里按费用档案/费用类别的资料权限检查
  @AuthenticatedOnly() @Get('snapshots')
  snapshotList(@CurrentUser() u: AuthUser) { return this.snapshots.list(u); }

  @AuthenticatedOnly() @Post('snapshots')
  snapshotCreate(@CurrentUser() u: AuthUser, @Body() dto: SnapshotDto) { return this.snapshots.create(u, dto.name, dto.remark); }

  @AuthenticatedOnly() @Get('snapshots/:id')
  snapshotView(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.snapshots.view(u, id); }

  @AuthenticatedOnly() @Post('snapshots/:id/restore')
  snapshotRestore(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.snapshots.restore(u, id); }

  @AuthenticatedOnly() @Delete('snapshots/:id')
  snapshotRemove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.snapshots.remove(u, id); }
}
