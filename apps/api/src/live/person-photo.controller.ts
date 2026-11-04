import {
  Controller,
  Get,
  Injectable,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createChecker, resourcePermission } from '@kudesi/shared';
import {
  AuthenticatedOnly,
  AuthUser,
  CurrentUser,
} from '../common/auth.decorators';
import { ResourceFile, User } from '../entities';
import { FilesService } from '../integrations/files.service';
import { loadLiveAccess, requireView } from './live-access';
import { can, liveFail, positionTypesOf } from './live-core';

@Injectable()
export class LivePersonPhotoService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly files: FilesService,
  ) {}
  /** 直播查看权限仅能读该员工绑定的人员照，不授予人事档案、证件或其他附件权限。 */
  async photo(user: AuthUser, userId: number) {
    const hr=can(user,resourcePermission('workforce','view'));
    const access=await loadLiveAccess(this.ds.manager,user);
    if(!hr) requireView(access);
    const person = await this.ds.manager.findOne(User, {
      where: { companyId: user.companyId, id: userId },
      select: ['id', 'name'],
    });
    if (!person) liveFail('人员不存在', 404);
    const roles = await positionTypesOf(
      this.ds.manager,
      user.companyId,
      userId,
    );
    if (!hr && !roles.has('live_anchor')) {
      const [known] = await this.ds.query(
        'SELECT (EXISTS(SELECT 1 FROM live_sessions WHERE company_id=? AND anchor_user_id=?) OR EXISTS(SELECT 1 FROM live_schedules WHERE company_id=? AND anchor_user_id=?)) allowed',
        [user.companyId, userId, user.companyId, userId],
      );
      if (!Number(known?.allowed)) liveFail('主播不存在', 404);
    }
    const [record] = await this.ds.query(
      "SELECT id,data FROM resource_records WHERE company_id=? AND type='workforce' AND archived_at IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.userId'))=? ORDER BY id DESC LIMIT 1",
      [user.companyId, String(userId)],
    );
    if(hr&&!access.canView&&!record)liveFail('兼职档案不存在',404);
    const data =
      typeof record?.data === 'string' ? JSON.parse(record.data) : record?.data;
    const id =
      Array.isArray(data?.photo) && data.photo.length === 1
        ? Number(data.photo[0])
        : null;
    const upload = record && createChecker(user.permissions)(resourcePermission('workforce', 'edit'))
      ? { recordId: Number(record.id) } : undefined;
    const empty = { userId, name: person.name, photo: null, ...(upload ? { upload } : {}) };
    if (!id || !Number.isSafeInteger(id)) return empty;
    const file = await this.ds.manager.findOneBy(ResourceFile, {
      companyId: user.companyId,
      id,
      resourceType: 'workforce',
      fieldKey: 'photo',
      resourceId: Number(record.id),
    });
    if (!file || !file.mime.startsWith('image/')) return empty;
    const photo = await this.files.urlOf(user.companyId, id, 'workforce');
    await this.ds.query(
      'INSERT INTO audit_logs(company_id,actor_id,action,resource_type,resource_id,detail) VALUES(?,?,?,?,?,?)',
      [
        user.companyId,
        user.id,
        'live.person.photo.view',
        'user',
        String(userId),
        JSON.stringify({ fileId: id, via: 'live-overview' }),
      ],
    );
    return { userId, name: person.name, photo };
  }
}
@Controller('live/people')
export class LivePersonPhotoController {
  constructor(private readonly photos: LivePersonPhotoService) {}
  @AuthenticatedOnly()
  @Get(':userId/photo')
  photo(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.photos.photo(user, userId);
  }
}
