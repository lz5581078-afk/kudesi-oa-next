import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { MAX_UPLOAD_BYTES } from '../integrations/files.service';
import { PurchaseService } from './purchase.service';

class ProductsQuery {
  @IsOptional() @IsString() @MaxLength(50) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page?: number;
}
class IdsQuery { @IsString() @MaxLength(400) ids!: string }
class FollowupBody { @IsString() @MaxLength(10) promisedShipAt!: string; @IsOptional() @IsString() @MaxLength(500) comment?: string }
class ControlBody { @IsIn(['amend', 'cancel_remaining']) mode!: 'amend' | 'cancel_remaining'; @IsString() @MaxLength(500) comment!: string }
class UploadBody { @Type(() => Number) @IsInt() @Min(1) runId!: number }
class FileQuery { @Type(() => Number) @IsInt() @Min(1) runId!: number }

/** 采购申请中心的辅助接口。申请、办理、退回、废除都在统一流程接口里；价格和付款在这里按权限脱敏。 */
@Controller('flow/purchase')
export class PurchaseController {
  constructor(private readonly svc: PurchaseService) {}

  @RequirePermission('flow.apply.view')
  @Get('products')
  products(@CurrentUser() user: AuthUser, @Query() q: ProductsQuery) { return this.svc.products(user, { keyword: q.keyword, categoryId: q.categoryId, page: q.page ?? 1 }); }

  /** 列表进度；只返回有权看到的流程（能不能看由流程可见性决定，这里再按列表接口返回的编号查） */
  @AuthenticatedOnly()
  @Get('progress')
  progress(@CurrentUser() user: AuthUser, @Query() q: IdsQuery) {
    const ids = q.ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
    return this.svc.progressVisible(user, ids);
  }

  @AuthenticatedOnly()
  @Get('runs/:id/state')
  state(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.state(user, id); }

  @AuthenticatedOnly()
  @Get('runs/:id/options')
  options(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.svc.options(user, id); }

  @AuthenticatedOnly()
  @Post('runs/:id/followup')
  followup(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: FollowupBody) { return this.svc.followup(user, id, b); }

  @AuthenticatedOnly()
  @Post('runs/:id/control')
  control(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ControlBody) { return this.svc.control(user, id, b.mode, b.comment); }

  @AuthenticatedOnly()
  @Post('evidence')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@CurrentUser() user: AuthUser, @Body() b: UploadBody, @UploadedFile() file: { originalname: string; buffer: Buffer; size: number } | undefined) { return this.svc.upload(user, b.runId, file); }

  @AuthenticatedOnly()
  @Get('evidence/:fileId/url')
  fileUrl(@CurrentUser() user: AuthUser, @Param('fileId', ParseIntPipe) fileId: number, @Query() q: FileQuery) { return this.svc.fileUrl(user, q.runId, fileId); }
}
