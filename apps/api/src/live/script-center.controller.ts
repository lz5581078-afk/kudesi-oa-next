import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AuthenticatedOnly, AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { FilesService, MAX_UPLOAD_BYTES, type UploadedFile as Upload } from '../integrations/files.service';
import { can } from './live-core';

class Named {
  @IsString() @Length(1, 100) name!: string;
}
class ProductFolder extends Named {
  @IsOptional() @IsString() @MaxLength(80) category?: string;
}
class FolderCategory {
  @IsString() @MaxLength(80) category!: string;
}
class Media extends Named {
  @IsIn(['background', 'image', 'video']) category!: string;
}
class Cue {
  @IsInt() @Min(1) asset!: number;
  @IsInt() @Min(0) start!: number;
  @IsInt() @Min(1) end!: number;
}
class Script extends Named {
  @IsString() @MaxLength(10000) notes!: string;
  @IsString() @MaxLength(30000) body!: string;
  @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => Cue) cues!: Cue[];
  @IsInt() @Min(1) revision!: number;
}
function nameOf(value: string) {
  if (!value.trim()) throw new BadRequestException('请填写名称');
  return value.trim();
}
@Controller('live/scripts')
export class ScriptCenterController {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly files: FilesService,
  ) {}
  private view(u: AuthUser) {
    if (!can(u, 'features.live.view') && !can(u, 'live.manage')) throw new ForbiddenException();
  }
  private async version(company: number, id: number) {
    const [v] = await this.db.query(
      'SELECT id,folder_id folderId,name,notes,body,cues,revision FROM live_script_versions WHERE company_id=? AND id=?',
      [company, id],
    );
    if (!v) throw new NotFoundException('话术版本不存在');
    return { ...v, cues: typeof v.cues === 'string' ? JSON.parse(v.cues) : v.cues };
  }
  @AuthenticatedOnly()
  @Get()
  async library(@CurrentUser() u: AuthUser) {
    this.view(u);
    const [folders, versions] = await Promise.all([
      this.db.query('SELECT id,name,category FROM live_script_folders WHERE company_id=? ORDER BY name,id', [
        u.companyId,
      ]),
      this.db.query(
        'SELECT id,name,folder_id folderId FROM live_script_versions WHERE company_id=? ORDER BY id DESC',
        [u.companyId],
      ),
    ]);
    return { folders, versions };
  }
  @RequirePermission('live.manage')
  @Post('folders')
  async folder(@CurrentUser() u: AuthUser, @Body() dto: ProductFolder) {
    try {
      const row = await this.db.query('INSERT INTO live_script_folders(company_id,name,category) VALUES(?,?,?)', [
        u.companyId,
        nameOf(dto.name),
        dto.category?.trim() ?? '',
      ]);
      return { id: row.insertId };
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') throw new ConflictException('已有同名产品文件夹');
      throw e;
    }
  }
  @RequirePermission('live.manage')
  @Put('folders/:id/category')
  async classify(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: FolderCategory) {
    const result = await this.db.query('UPDATE live_script_folders SET category=? WHERE company_id=? AND id=?', [dto.category.trim(), u.companyId, id]);
    if (!result.affectedRows) throw new NotFoundException('产品文件夹不存在');
    return { category: dto.category.trim() };
  }
  @RequirePermission('live.manage')
  @Post('folders/:id/versions')
  async create(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: Named) {
    const result = await this.db.query(
      "INSERT INTO live_script_versions(company_id,folder_id,name,notes,body,cues) SELECT company_id,id,?,'','',JSON_ARRAY() FROM live_script_folders WHERE company_id=? AND id=?",
      [nameOf(dto.name), u.companyId, id],
    );
    if (!result.affectedRows) throw new NotFoundException('产品文件夹不存在');
    return { id: result.insertId };
  }
  @AuthenticatedOnly()
  @Get('versions/:id')
  async detail(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number) {
    this.view(u);
    const version = await this.version(u.companyId, id);
    const assets = await this.db.query(
      "SELECT id,name,field_key category FROM resource_files WHERE company_id=? AND resource_type='live-script-media' AND resource_id=? ORDER BY id",
      [u.companyId, id],
    );
    return { ...version, assets };
  }
  @RequirePermission('live.manage')
  @Put('versions/:id')
  async save(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: Script) {
    const ids = [...new Set(dto.cues.map((c) => c.asset))];
    if (dto.cues.some((c) => c.start >= c.end || c.end > dto.body.length))
      throw new BadRequestException('标注范围超出正文');
    if (ids.length) {
      const assets = await this.db.query(
        "SELECT id FROM resource_files WHERE company_id=? AND resource_type='live-script-media' AND resource_id=? AND id IN (?)",
        [u.companyId, id, ids],
      );
      if (assets.length !== ids.length) throw new BadRequestException('标注只能使用本版本素材');
    }
    const result = await this.db.query(
      'UPDATE live_script_versions SET name=?,notes=?,body=?,cues=?,revision=revision+1 WHERE company_id=? AND id=? AND revision=?',
      [nameOf(dto.name), dto.notes, dto.body, JSON.stringify(dto.cues), u.companyId, id, dto.revision],
    );
    if (!result.affectedRows) throw new ConflictException('版本已变更，请保留草稿并重新打开版本核对');
    return { revision: dto.revision + 1 };
  }
  @RequirePermission('live.manage')
  @Post('versions/:id/assets')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2 } }))
  async upload(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Media,
    @UploadedFile() file: Upload,
  ) {
    const name = nameOf(dto.name);
    await this.version(u.companyId, id);
    const info = await this.files.putScriptMedia(u.companyId, u.id, id, dto.category, name, file);
    return { id: info.id, name: info.name, category: dto.category };
  }
  @AuthenticatedOnly()
  @Get('versions/:id/assets/:asset/url')
  async url(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('asset', ParseIntPipe) asset: number,
    @Query('download') download?: string,
  ) {
    this.view(u);
    const [row] = await this.db.query(
      "SELECT id FROM resource_files WHERE company_id=? AND resource_type='live-script-media' AND resource_id=? AND id=?",
      [u.companyId, id, asset],
    );
    if (!row) throw new NotFoundException('素材不存在');
    return this.files.urlOf(u.companyId, asset, 'live-script-media', download === '1');
  }
}
