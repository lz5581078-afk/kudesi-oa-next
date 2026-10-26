import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FilesService, MAX_UPLOAD_BYTES, type UploadedFile as Upload } from '../integrations/files.service';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, Equals, IsArray, IsIn, MinLength, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { OPENING_PREPAYMENT_PERMISSION, DOC_TYPES, type DocType } from '@kudesi/shared';
import { AuthUser, AuthenticatedOnly, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { OPENING_VOUCHER_TYPE, FinanceDocumentsService } from './finance-documents.service';

const TYPES = DOC_TYPES.map((d) => d.type);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class LineDto {
  @IsOptional() @IsInt() @Min(1) productId?: number | null;
  @IsOptional() @IsInt() @Min(1) feeItemId?: number | null;
  @IsNumber({ maxDecimalPlaces: 4 }) qty!: number;
  @IsInt() unitPriceCents!: number;
  @IsOptional() @IsInt() unitCostCents?: number | null;
  @IsOptional() @IsString() @MaxLength(200) memo?: string;
  @IsOptional() @IsString() @MaxLength(20) relatedNode?: string | null;
  @IsOptional() @IsInt() @Min(1) relatedId?: number | null;
  @IsOptional() @IsString() @MaxLength(100) relatedName?: string | null;
}
class AccountDto {
  @IsIn(['out', 'in']) role!: 'out' | 'in';
  @IsInt() @Min(1) bankAccountId!: number;
  @IsInt() @Min(1) amountCents!: number;
}
class SettlementDto {
  @IsInt() @Min(1) sourceDocId!: number;
  @IsOptional() @IsInt() @Min(1) productId?: number | null;
  @IsInt() @Min(1) amountCents!: number;
}
class OpenItemsDto {
  @IsIn(['in', 'out']) dir!: 'in' | 'out';
  @IsIn(['customer', 'store', 'supplier']) partyKind!: string;
  @Type(() => Number) @IsInt() @Min(1) partyId!: number;
}
class SettlementQueryDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) partyId?: number;
  @IsOptional() @IsIn(['receipt', 'payment']) docType?: string;
}
class DocDto {
  @IsOptional() @IsIn(['amount', 'doc', 'product']) settleBy?: 'amount' | 'doc' | 'product' | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SettlementDto) settlements?: SettlementDto[] | null;
  @IsIn(TYPES) type!: DocType;
  @Matches(DATE) date!: string;
  @IsOptional() @IsInt() @Min(1) partyId?: number | null;
  @IsOptional() @IsIn(['customer', 'store', 'supplier']) partyKind?: 'customer' | 'store' | 'supplier' | null;
  @IsOptional() @IsInt() @Min(0) paidCents?: number | null;
  @IsOptional() @IsString() @MaxLength(60) handler?: string | null;
  @IsOptional() @IsString() @MaxLength(60) department?: string | null;
  @IsOptional() @IsString() @MaxLength(32) docNo?: string | null;
  @IsOptional() @IsInt() @Min(1) bankAccountId?: number | null;
  @IsOptional() @IsInt() @Min(1) toBankAccountId?: number | null;
  @IsOptional() @IsInt() @Min(1) warehouseId?: number | null;
  @IsOptional() @IsInt() @Min(1) storeId?: number | null;
  @IsOptional() @IsString() @MaxLength(80) refNo?: string | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AccountDto) accounts?: AccountDto[] | null;
  @IsOptional() @IsInt() amountCents?: number | null;
  @IsOptional() @IsInt() offsetCents?: number | null;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => LineDto) lines?: LineDto[];
  @IsOptional() @IsString() @MaxLength(500) memo?: string;
}
class OpeningPrepaymentDto {
  @IsString() @MinLength(1) @MaxLength(500) reason!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ArrayUnique() @IsInt({ each: true }) @Min(1, { each: true }) fileIds!: number[];
  @Equals(true) confirmed!: boolean;
}
class HeaderDto {
  @IsOptional() @Matches(DATE) date?: string;
  @IsOptional() @IsString() @MaxLength(60) handler?: string | null;
  @IsOptional() @IsString() @MaxLength(500) memo?: string | null;
}
class AuditDto { @IsIn([true, false]) on!: boolean }
class BatchDto {
  @IsIn(['post', 'delete', 'copy']) action!: 'post' | 'delete' | 'copy';
  @IsArray() @IsInt({ each: true }) ids!: number[];
}
class ReasonDto { @IsString() @MaxLength(500) reason!: string }
class ListDto {
  @IsString() scope!: string;
  @IsOptional() @IsIn(['draft', 'issued', 'posted', 'reversed']) status?: string;
  @IsOptional() @IsIn(['in', 'out', 'internal']) direction?: 'in' | 'out' | 'internal';
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsString() @MaxLength(60) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) creatorId?: number;
  @IsOptional() @IsIn(['yes', 'no']) audited?: 'yes' | 'no';
  @IsOptional() @IsIn(TYPES) docType?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}
class InvDto {
  @IsOptional() @Matches(DATE) asOf?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) warehouseId?: number;
  @IsOptional() @IsString() @MaxLength(60) keyword?: string;
  @IsOptional() @IsIn(['normal', 'out']) stockStatus?: 'normal' | 'out';
}
class LedgerDto {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
}
class MonthDto { @IsOptional() @Matches(/^(\d{4}-\d{2}|all)$/) month?: string }
class KeyAccountDto { @IsIn([true, false]) on!: boolean }

// 单据按“单据类型”分权限，类型不固定，所以权限在服务里按类型检查（页面查看权限 + finance.docs.* 操作权限）
@Controller('finance')
export class FinanceDocumentsController {
  constructor(private readonly docs: FinanceDocumentsService, private readonly files: FilesService) {}

  @AuthenticatedOnly() @Get('docs')
  list(@CurrentUser() u: AuthUser, @Query() q: ListDto) {
    return this.docs.list(u, { scope: q.scope as never, direction: q.direction, status: q.status, from: q.from, to: q.to, keyword: q.keyword, creatorId: q.creatorId, audited: q.audited, docType: q.docType, page: q.page ?? 1, pageSize: q.pageSize ?? 20 });
  }
  @AuthenticatedOnly() @Get('docs/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.docs.get(u, id); }

  @AuthenticatedOnly() @Post('docs')
  create(@CurrentUser() u: AuthUser, @Body() b: DocDto) { const { memo, ...input } = b; return this.docs.createDraft(u, input as never, { memo }); }

  @AuthenticatedOnly() @Put('docs/:id')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: DocDto) { const { memo, ...input } = b; return this.docs.updateDraft(u, id, input as never, memo); }

  @AuthenticatedOnly() @Delete('docs/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.docs.deleteDraft(u, id); }

  @AuthenticatedOnly() @Post('docs/:id/issue')
  issue(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.docs.issue(u, id); }

  @AuthenticatedOnly() @Post('docs/:id/unissue')
  unissue(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.docs.unissue(u, id, b.reason); }

  @AuthenticatedOnly() @Post('docs/:id/post')
  post(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.docs.post(u, id); }

  @RequirePermission(OPENING_PREPAYMENT_PERMISSION) @Post('docs/:id/opening-prepayment')
  registerOpening(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: OpeningPrepaymentDto) { return this.docs.registerOpeningPrepayment(u, id, b); }

  @RequirePermission(OPENING_PREPAYMENT_PERMISSION) @Post('docs/:id/opening-vouchers')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async uploadOpeningVoucher(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @UploadedFile() file: Upload) {
    await this.docs.checkOpeningPrepayment(u, id);
    return this.files.putBlob(u.companyId, u.id, OPENING_VOUCHER_TYPE, 'voucher', file);
  }

  @AuthenticatedOnly() @Get('docs/:id/opening-vouchers/:fileId/url')
  async openingVoucherUrl(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Param('fileId', ParseIntPipe) fileId: number) {
    await this.docs.openingVoucher(u, id, fileId);
    return this.files.urlOf(u.companyId, fileId, OPENING_VOUCHER_TYPE);
  }

  @AuthenticatedOnly() @Post('docs/:id/reverse')
  reverse(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: ReasonDto) { return this.docs.reverse(u, id, b.reason); }

  @AuthenticatedOnly() @Put('docs/:id/header')
  header(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: HeaderDto) { return this.docs.editHeader(u, id, b); }

  @AuthenticatedOnly() @Post('docs/:id/audit')
  audit(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: AuditDto) { return this.docs.audit(u, id, b.on); }

  @AuthenticatedOnly() @Post('docs/:id/copy')
  copy(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.docs.copyAsDraft(u, id); }

  @AuthenticatedOnly() @Post('docs-batch')
  batch(@CurrentUser() u: AuthUser, @Body() b: BatchDto) { return this.docs.batch(u, b.action, b.ids); }

  @AuthenticatedOnly() @Get('bank-balances')
  banks(@CurrentUser() u: AuthUser) { return this.docs.bankBalances(u); }

  @AuthenticatedOnly() @Get('open-items')
  openItems(@CurrentUser() u: AuthUser, @Query() q: OpenItemsDto) { return this.docs.openItems(u, q); }

  @AuthenticatedOnly() @Get('settlement-detail')
  settlementDetail(@CurrentUser() u: AuthUser, @Query() q: SettlementQueryDto) { return this.docs.settlementDetail(u, q); }

  @AuthenticatedOnly() @Get('unsettled-receipts')
  unsettledReceipts(@CurrentUser() u: AuthUser, @Query() q: SettlementQueryDto) { return this.docs.unsettledReceipts(u, q); }

  @AuthenticatedOnly() @Get('store-funds')
  storeFunds(@CurrentUser() u: AuthUser) { return this.docs.storeFunds(u); }

  @AuthenticatedOnly() @Get('key-accounts')
  keyAccounts(@CurrentUser() u: AuthUser) { return this.docs.keyAccounts(u); }

  @AuthenticatedOnly() @Put('key-accounts/:id')
  setKeyAccount(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() b: KeyAccountDto) { return this.docs.setKeyAccount(u, id, b.on); }

  @AuthenticatedOnly() @Get('bank-ledger/:id')
  ledger(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: LedgerDto) { return this.docs.bankLedger(u, id, q.from, q.to); }

  @AuthenticatedOnly() @Get('inventory')
  inventory(@CurrentUser() u: AuthUser, @Query() q: InvDto) { return this.docs.inventory(u, q); }

  @AuthenticatedOnly() @Get('overview')
  overview(@CurrentUser() u: AuthUser, @Query() q: MonthDto) { return this.docs.overview(u, q.month); }
}
