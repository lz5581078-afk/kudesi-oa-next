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
  ArrayMinSize,
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
class Stage extends Named {
  @IsInt() @Min(0) length!: number;
}
class Question {
  @IsString() @Length(1, 200) question!: string;
  @IsString() @Length(1, 1500) answer!: string;
}
class Template extends Named {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(80)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  stages!: string[];
}
class TemplateUpdate extends Template {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(80) @IsString({ each: true }) previous!: string[];
}
class Script extends Named {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => Stage)
  outline?: Stage[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => Question)
  faq?: Question[];
  @IsOptional() @IsInt() @Min(1) faqRevision?: number;
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
      'SELECT v.id,v.folder_id folderId,v.name,v.notes,v.body,v.cues,v.revision,v.outline,f.faq,f.faq_revision faqRevision FROM live_script_versions v JOIN live_script_folders f ON f.company_id=v.company_id AND f.id=v.folder_id WHERE v.company_id=? AND v.id=?',
      [company, id],
    );
    if (!v) throw new NotFoundException('话术版本不存在');
    return {
      ...v,
      outline: typeof v.outline === 'string' ? JSON.parse(v.outline) : v.outline,
      faq: typeof v.faq === 'string' ? JSON.parse(v.faq) : (v.faq ?? []),
      cues: typeof v.cues === 'string' ? JSON.parse(v.cues) : v.cues,
    };
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
  @AuthenticatedOnly()
  @Get('templates')
  async templates(@CurrentUser() u: AuthUser) {
    this.view(u);
    const rows = await this.db.query(
      'SELECT id,name,stages FROM live_script_templates WHERE company_id=? ORDER BY name,id',
      [u.companyId],
    );
    return rows.map((r: { id: number; name: string; stages: string | string[] }) => ({
      ...r,
      stages: typeof r.stages === 'string' ? JSON.parse(r.stages) : r.stages,
    }));
  }
  @RequirePermission('live.manage')
  @Post('templates')
  async template(@CurrentUser() u: AuthUser, @Body() dto: Template) {
    const name = nameOf(dto.name),
      stages = dto.stages.map(nameOf);
    try {
      const result = await this.db.query(
        'INSERT INTO live_script_templates(company_id,name,stages) VALUES(?,?,?)',
        [u.companyId, name, JSON.stringify(stages)],
      );
      return { id: result.insertId, name, stages };
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY')
        throw new ConflictException('模板名已使用，请换一个名称');
      throw e;
    }
  }
  @RequirePermission('live.manage')
  @Put('templates/:id')
  async updateTemplate(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TemplateUpdate,
  ) {
    const stages = dto.stages.map(nameOf),
      name = nameOf(dto.name);
    const result = await this.db.query(
      'UPDATE live_script_templates SET stages=? WHERE company_id=? AND id=? AND name=? AND stages=CAST(? AS JSON)',
      [JSON.stringify(stages), u.companyId, id, name, JSON.stringify(dto.previous)],
    );
    if (!result.affectedRows) throw new ConflictException('模板已变更，请重新打开后核对');
    return { id, name, stages };
  }
  @RequirePermission('live.manage')
  @Post('folders')
  async folder(@CurrentUser() u: AuthUser, @Body() dto: ProductFolder) {
    try {
      const row = await this.db.query(
        'INSERT INTO live_script_folders(company_id,name,category) VALUES(?,?,?)',
        [u.companyId, nameOf(dto.name), dto.category?.trim() ?? ''],
      );
      return { id: row.insertId };
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') throw new ConflictException('已有同名产品文件夹');
      throw e;
    }
  }
  @RequirePermission('live.manage')
  @Put('folders/:id/category')
  async classify(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FolderCategory,
  ) {
    const result = await this.db.query(
      'UPDATE live_script_folders SET category=? WHERE company_id=? AND id=?',
      [dto.category.trim(), u.companyId, id],
    );
    if (!result.affectedRows) throw new NotFoundException('产品文件夹不存在');
    return { category: dto.category.trim() };
  }
  @RequirePermission('live.manage')
  @Post('folders/:id/versions')
  async create(@CurrentUser() u: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: Named) {
    const [preset] = await this.db.query(
      'SELECT stages FROM live_script_templates WHERE company_id=? AND name=?',
      [u.companyId, '默认目录'],
    );
    const names: string[] = preset
      ? typeof preset.stages === 'string'
        ? JSON.parse(preset.stages)
        : preset.stages
      : ['留人', '互动', '塑品', '逼单', '追单'];
    const result = await this.db.query(
      "INSERT INTO live_script_versions(company_id,folder_id,name,notes,body,cues,outline) SELECT company_id,id,?,'','',JSON_ARRAY(),? FROM live_script_folders WHERE company_id=? AND id=?",
      [nameOf(dto.name), JSON.stringify(names.map((name) => ({ name, length: 0 }))), u.companyId, id],
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
    if (
      dto.outline &&
      (dto.outline.some((s) => !s.name.trim()) ||
        dto.outline.reduce((n, s) => n + s.length, 0) !== dto.body.length)
    )
      throw new BadRequestException('目录环节与正文长度不符');
    if (dto.faq && (dto.faqRevision == null || dto.faq.some((q) => !q.question.trim() || !q.answer.trim())))
      throw new BadRequestException('请填全问题和回答');
    return this.db.transaction(async (em) => {
      const result = await em.query(
        'UPDATE live_script_versions SET name=?,notes=?,outline=COALESCE(?,outline),body=?,cues=?,revision=revision+1 WHERE company_id=? AND id=? AND revision=? AND (? OR outline IS NULL OR BINARY body=BINARY ?)',
        [
          nameOf(dto.name),
          dto.notes,
          dto.outline ? JSON.stringify(dto.outline) : null,
          dto.body,
          JSON.stringify(dto.cues),
          u.companyId,
          id,
          dto.revision,
          !!dto.outline,
          dto.body,
        ],
      );
      if (!result.affectedRows) throw new ConflictException('版本已变更，请保留草稿并重新打开版本核对');
      if (dto.faq) {
        const updated = await em.query(
          'UPDATE live_script_folders f JOIN live_script_versions v ON v.folder_id=f.id AND v.company_id=f.company_id SET f.faq=?,f.faq_revision=f.faq_revision+1 WHERE v.company_id=? AND v.id=? AND f.faq_revision=?',
          [JSON.stringify(dto.faq), u.companyId, id, dto.faqRevision],
        );
        if (!updated.affectedRows)
          throw new ConflictException('其他版本已修改产品问题库，请保留草稿并重新核对');
      }
      return { revision: dto.revision + 1, ...(dto.faq ? { faqRevision: dto.faqRevision! + 1 } : {}) };
    });
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
