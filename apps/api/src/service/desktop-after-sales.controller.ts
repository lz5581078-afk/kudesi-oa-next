import {Body,Controller,Get,Param,ParseIntPipe,Post,Query,UploadedFile,UseInterceptors} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {Type} from 'class-transformer';
import {IsDateString,IsDefined,IsInt,IsObject,IsOptional,IsString,Matches,MaxLength,Min,ValidateNested} from 'class-validator';
import {AuthUser,CurrentUser,RequirePermission} from '../common/auth.decorators';
import {MAX_UPLOAD_BYTES,type UploadedFile as Upload} from '../integrations/files.service';
import {DesktopAfterSalesService} from './desktop-after-sales.service';
import type {DesktopSaleSnapshot} from '@kudesi/shared';
class SnapshotDto implements DesktopSaleSnapshot {
 @Matches(/^\d{4,40}$/) afterSaleId!:string;
 @Matches(/^\d{4,40}$/) internalOrderId!:string;
 @IsString() @MaxLength(100) sourceCompany!:string;
 @IsDateString() capturedAt!:string;
 @IsObject() fields!:DesktopSaleSnapshot['fields'];
}
class ImportDto { @IsInt() @Min(1) storeId!:number; @IsDefined() @ValidateNested() @Type(()=>SnapshotDto) snapshot!:SnapshotDto; }
class FollowDto {
 @IsInt() @Min(1) version!:number;
 @IsString() @MaxLength(300) progress!:string;
 @IsOptional() @IsInt() @Min(1) ownerId?:number|null;
 @IsOptional() @IsDateString() nextAt?:string|null;
 @IsString() @MaxLength(4000) note!:string;
}
class ListDto { @IsOptional() @IsString() @MaxLength(80) keyword?:string; @IsOptional() @Type(()=>Number) @IsInt() @Min(1) page?:number; }
@Controller('desktop-after-sales')
export class DesktopAfterSalesController {
 constructor(private readonly svc:DesktopAfterSalesService){}
 @Get('options') @RequirePermission('after-sales.workspace.view') options(@CurrentUser() u:AuthUser){return this.svc.options(u);}
 @Get() @RequirePermission('after-sales.workspace.view') list(@CurrentUser() u:AuthUser,@Query() q:ListDto){return this.svc.list(u,q.keyword,q.page);}
 @Get(':id') @RequirePermission('after-sales.workspace.view') detail(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number){return this.svc.detail(u,id);}
 @Post('import') @RequirePermission('after-sales.workspace.view') import(@CurrentUser() u:AuthUser,@Body() b:ImportDto){return this.svc.import(u,b.storeId,b.snapshot);}
 @Post(':id/follow') @RequirePermission('after-sales.workspace.view') follow(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() b:FollowDto){return this.svc.follow(u,id,b);}
 @Post(':id/files') @RequirePermission('after-sales.workspace.view') @UseInterceptors(FileInterceptor('file',{limits:{fileSize:MAX_UPLOAD_BYTES,files:1}})) upload(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@UploadedFile() file:Upload|undefined){return this.svc.upload(u,id,file);}
 @Get(':id/files/:fileId/url') @RequirePermission('after-sales.workspace.view') url(@CurrentUser() u:AuthUser,@Param('id',ParseIntPipe) id:number,@Param('fileId',ParseIntPipe) fileId:number){return this.svc.fileUrl(u,id,fileId);}
}
