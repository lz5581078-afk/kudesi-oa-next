import {Body,Controller,Get,Param,ParseIntPipe,Post,Query,UploadedFile,UseInterceptors} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {Type} from 'class-transformer';
import {ArrayMaxSize,IsArray,IsBoolean,IsDateString,IsDefined,IsIn,IsInt,IsObject,IsOptional,IsString,IsUUID,Matches,Max,MaxLength,Min,ValidateIf,ValidateNested} from 'class-validator';
import {AuthenticatedOnly,AuthUser,CurrentUser,RequirePermission} from '../common/auth.decorators';
import {MAX_UPLOAD_BYTES,type UploadedFile as Upload} from '../integrations/files.service';
import {DesktopAfterSalesService} from './desktop-after-sales.service';
import {AFTER_SALES_COLUMNS,AFTER_SALES_MAX_FILTERS,AFTER_SALES_SORT_COLUMNS,type AfterSalesColumnFilter,type DesktopSaleSnapshot} from '@kudesi/shared';
import {DesktopAfterSalesCollectionService} from './desktop-after-sales-collection.service';
import {DesktopAfterSalesCollaborationService} from './desktop-after-sales-collaboration.service';
class SnapshotDto implements DesktopSaleSnapshot {
 @Matches(/^\d{4,40}$/) afterSaleId!:string;
 @ValidateIf((_,value:unknown)=>value!=='') @Matches(/^\d{4,40}$/) internalOrderId!:string;
 @IsString() @MaxLength(100) sourceCompany!:string;
 @IsDateString() capturedAt!:string;
 @IsObject() fields!:DesktopSaleSnapshot['fields'];
}
class ImportDto { @IsOptional() @IsInt() @Min(1) storeId?:number|null; @IsDefined() @ValidateNested() @Type(()=>SnapshotDto) snapshot!:SnapshotDto; }
class MetadataDto{
 @IsInt() @Min(1) version!:number;
 @IsInt() @Min(0) @Max(3) priority!:number;
 @IsOptional() @Matches(/^#[\da-fA-F]{6}$/) rowColor!:string|null;
 @IsString() @MaxLength(8000) report!:string;
}
class RecordDto{ @IsString() @MaxLength(4000) content!:string; }
class ShareDto{
 @IsArray() @ArrayMaxSize(20) @IsInt({each:true}) @Min(1,{each:true}) recipients!:number[];
 @IsString() @MaxLength(500) message!:string;
 @IsBoolean() canWrite!:boolean;
}
class StartFlowDto{
 @IsIn(['refund_only','return_refund','exchange','resend','compensation','other']) caseType!:string;
 @IsInt() @Min(0) @Max(100_000_000_00) amountCents!:number;
 @IsString() @MaxLength(500) reason!:string;
}
class FollowDto {
 @IsInt() @Min(1) version!:number;
 @IsString() @MaxLength(300) progress!:string;
 @IsOptional() @IsInt() @Min(1) ownerId?:number|null;
 @IsOptional() @IsDateString() nextAt?:string|null;
 @IsString() @MaxLength(4000) note!:string;
}
class ListDto {
 @IsOptional() @IsString() @MaxLength(80) keyword?:string;
 @IsOptional() @Type(()=>Number) @IsInt() @Min(1) page?:number;
 @IsOptional() @IsIn(AFTER_SALES_SORT_COLUMNS) sort?:string;
 @IsOptional() @IsIn(['asc','desc']) direction?:string;
}
class ColumnFilterDto implements AfterSalesColumnFilter {
 @IsIn(AFTER_SALES_COLUMNS) column!:AfterSalesColumnFilter['column'];
 @IsString() @MaxLength(120) value!:string;
}
class SearchDto extends ListDto {
 @IsArray() @ArrayMaxSize(AFTER_SALES_MAX_FILTERS) @ValidateNested({each:true}) @Type(()=>ColumnFilterDto) filters!:ColumnFilterDto[];
}
class EventsDto { @IsOptional() @Type(()=>Number) @IsInt() @Min(1) before?:number; }
@Controller('desktop-after-sales')
export class DesktopAfterSalesController {
 constructor(private readonly svc:DesktopAfterSalesService){}
 @Get('options') @RequirePermission('after-sales.workspace.view') options(@CurrentUser() u:AuthUser){return this.svc.options(u);}
 @Get() @RequirePermission('after-sales.workspace.view') list(@CurrentUser() u:AuthUser,@Query() q:ListDto){return this.svc.list(u,q.keyword,q.page,q.sort,q.direction);}
 @Post('search') @RequirePermission('after-sales.workspace.view') search(@CurrentUser() u:AuthUser,@Body() q:SearchDto){return this.svc.list(u,q.keyword,q.page,q.sort,q.direction,q.filters);}
 @Get(':id') @RequirePermission('after-sales.workspace.view') detail(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number){return this.svc.detail(u,id);}
 @Get(':id/events') @RequirePermission('after-sales.workspace.view') history(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Query() q:EventsDto){return this.svc.detail(u,id,q.before);}
 @Post('import') @RequirePermission('after-sales.workspace.view') import(@CurrentUser() u:AuthUser,@Body() b:ImportDto){return this.svc.import(u,b.storeId,b.snapshot);}
 @Post(':id/source') @RequirePermission('after-sales.workspace.view') refreshSource(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:SnapshotDto){return this.svc.refreshSource(u,id,b);}
 @Post(':id/follow') @RequirePermission('after-sales.workspace.view') follow(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:FollowDto){return this.svc.follow(u,id,b);}
 @Post(':id/metadata') @RequirePermission('after-sales.workspace.view') metadata(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:MetadataDto){return this.svc.metadata(u,id,b);}
 @Post(':id/files') @RequirePermission('after-sales.workspace.view') @UseInterceptors(FileInterceptor('file',{limits:{fileSize:MAX_UPLOAD_BYTES,files:1}})) upload(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@UploadedFile() file:Upload|undefined){return this.svc.upload(u,id,file);}
 @Get(':id/files/:fileId/url') @RequirePermission('after-sales.workspace.view') url(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Param('fileId',ParseIntPipe) fileId:number){return this.svc.fileUrl(u,id,fileId);}
}

/** Record-scoped sharing does not grant access to the whole after-sales list. */
@Controller('desktop-after-sales-shared')
export class DesktopAfterSalesSharedController{
 constructor(private readonly svc:DesktopAfterSalesService,private readonly collaboration:DesktopAfterSalesCollaborationService){}
 @Get(':id') @AuthenticatedOnly() async detail(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number){await this.svc.assertAccess(u,id);return this.svc.detail(u,id);}
 @Get(':id/events') @AuthenticatedOnly() async history(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Query() q:EventsDto){await this.svc.assertAccess(u,id);return this.svc.detail(u,id,q.before);}
 @Post(':id/records') @AuthenticatedOnly() record(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:RecordDto){return this.svc.record(u,id,b.content);}
 @Post(':id/metadata') @AuthenticatedOnly() async metadata(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:MetadataDto){await this.svc.assertAccess(u,id,true);return this.svc.metadata(u,id,b);}
 @Post(':id/share') @AuthenticatedOnly() share(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:ShareDto){return this.collaboration.share(u,id,b.recipients,b.message,b.canWrite);}
 @Post(':id/flow') @RequirePermission('after-sales.workspace.view','after-sales.table.view') flow(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:StartFlowDto){return this.collaboration.startFlow(u,id,b);}
 @Get(':id/files/:fileId/url') @AuthenticatedOnly() async url(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Param('fileId',ParseIntPipe) fid:number){await this.svc.assertAccess(u,id);return this.svc.fileUrl(u,id,fid);}
}
class SourceDto{
 @IsString() @MaxLength(100) sourceCompany!:string;
 @IsBoolean() enabled!:boolean;
 @IsInt() @Min(30) @Max(300) intervalSeconds!:number;
}
class ClaimDto{ @IsUUID() clientId!:string; }
class JoinDto{ @IsString() @MaxLength(100) sourceCompany!:string; }
class LeaseDto{ @IsUUID() token!:string; }
class BatchDto extends LeaseDto{
 @IsArray() @ArrayMaxSize(500) @ValidateNested({each:true}) @Type(()=>SnapshotDto) records!:SnapshotDto[];
 @IsInt() @Min(1) @Max(100000) page!:number;
 @IsBoolean() completed!:boolean;
}
class FailDto extends LeaseDto{ @IsString() @MaxLength(500) message!:string; }
class LocalBatchDto{
 @IsArray() @ArrayMaxSize(500) @ValidateNested({each:true}) @Type(()=>SnapshotDto) records!:SnapshotDto[];
}
@Controller('desktop-after-sales-collection')
export class DesktopAfterSalesCollectionController{
 constructor(private readonly svc:DesktopAfterSalesCollectionService){}
 @Get() @RequirePermission('after-sales.workspace.view') list(@CurrentUser() u:AuthUser){return this.svc.list(u);}
 @Post() @RequirePermission('after-sales.workspace.view') configure(@CurrentUser() u:AuthUser,@Body() b:SourceDto){return this.svc.configure(u,b);}
 @Post('join') @RequirePermission('after-sales.workspace.view') join(@CurrentUser() u:AuthUser,@Body() b:JoinDto){return this.svc.join(u,b.sourceCompany);}
 @Post(':id/claim') @RequirePermission('after-sales.workspace.view') claim(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:ClaimDto){return this.svc.claim(u,id,b.clientId);}
 @Post(':id/heartbeat') @RequirePermission('after-sales.workspace.view') heartbeat(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:LeaseDto){return this.svc.heartbeat(u,id,b.token);}
 @Post(':id/commit') @RequirePermission('after-sales.workspace.view') commit(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:BatchDto){return this.svc.commit(u,id,b);}
 @Post(':id/fail') @RequirePermission('after-sales.workspace.view') fail(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:FailDto){return this.svc.fail(u,id,b.token,b.message);}
 @Post(':id/local') @RequirePermission('after-sales.workspace.view') local(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:LocalBatchDto){return this.svc.local(u,id,b.records);}
}
