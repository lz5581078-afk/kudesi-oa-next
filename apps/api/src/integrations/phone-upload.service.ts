import { BadRequestException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { canWarehouseUploadPhotos } from '../resources/warehouse-mode';
import { createChecker, getResourceDef, permissionOwner, resourcePermission } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { AuditLog, PhoneUploadSession, User } from '../entities';
import { FilesService, sniffFile, UploadedFile } from './files.service';

/** 二维码有效分钟数、一次最多传几张。图片大小沿用文件服务的上限（10MB）。 */
export const PHONE_UPLOAD_TTL_MINUTES = 10;
export const PHONE_UPLOAD_MAX = 10;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,100}$/;

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * 手机扫码上传（收款码、商品图片）：
 * 电脑端登录后为“某类资料的某个文件字段”申请一个短期令牌，手机扫码打开免登录页，只能用它往那个字段传图片。
 * 令牌：32 字节随机数，库里只存哈希；绑定公司、发起人、资料类型、字段；10 分钟过期、最多 10 张；
 * 令牌不能读取任何资料（手机页只知道字段名称和剩余张数）；文件走文件服务，登记为“未绑定”，电脑端保存记录时才绑定。
 */
@Injectable()
export class PhoneUploadService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly files: FilesService) {}

  private fieldOf(type: string, fieldKey: string) {
    const def = getResourceDef(type);
    const field = def?.fields.find((f) => f.key === fieldKey && f.type === 'files');
    if (!def || !field || !field.phoneUpload) throw new BadRequestException('这个字段不支持手机上传');
    return { def, field };
  }

  /** 电脑端：申请二维码。需要有该资料的新增或编辑权限。 */
  async create(user: AuthUser, type: string, fieldKey: string) {
    const { field } = this.fieldOf(type, fieldKey);
    const can = createChecker(user.permissions);
    const owner = permissionOwner(type);
    if (!(['create', 'edit'] as const).some((a) => can(resourcePermission(owner, a))) && !(await canWarehouseUploadPhotos(this.ds.manager, user, type, fieldKey))) throw new ForbiddenException('没有权限执行此操作');
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + PHONE_UPLOAD_TTL_MINUTES * 60_000);
    const row = await this.ds.manager.save(PhoneUploadSession, this.ds.manager.create(PhoneUploadSession, {
      tokenHash: hashOf(token), companyId: user.companyId, userId: user.id, resourceType: type, fieldKey,
      maxUploads: Math.min(PHONE_UPLOAD_MAX, field.maxFiles ?? 9), uploadCount: 0, fileIds: [], expiresAt, scannedAt: null,
    }));
    await this.ds.manager.save(AuditLog, this.ds.manager.create(AuditLog, { companyId: user.companyId, actorId: user.id, action: 'phone-upload.session', resourceType: type, resourceId: null, detail: { field: fieldKey, sessionId: row.id } }));
    return { id: row.id, token, expiresAt: expiresAt.toISOString(), minutes: PHONE_UPLOAD_TTL_MINUTES, maxUploads: row.maxUploads };
  }

  /** 电脑端轮询：只能看自己发起的会话，返回扫码状态和已经传上来的文件。 */
  async status(user: AuthUser, id: number) {
    const s = await this.ds.manager.findOne(PhoneUploadSession, { where: { id, companyId: user.companyId, userId: user.id } });
    if (!s) throw new NotFoundException('上传会话不存在');
    const info = await this.files.info(user.companyId, s.fileIds);
    return {
      scanned: !!s.scannedAt, uploaded: s.uploadCount, expired: s.expiresAt.getTime() <= Date.now() || s.uploadCount >= s.maxUploads, expiresAt: s.expiresAt.toISOString(),
      files: s.fileIds.map((fid) => info.get(fid)).filter((f): f is NonNullable<typeof f> => !!f),
    };
  }

  private async live(token: string, lock = false) {
    if (!TOKEN_RE.test(String(token ?? ''))) throw new ForbiddenException('上传二维码无效');
    const s = await this.ds.manager.findOne(PhoneUploadSession, { where: { tokenHash: hashOf(token) }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    if (!s || s.expiresAt.getTime() <= Date.now()) throw new GoneException('二维码已失效，请在电脑上重新生成');
    if (s.uploadCount >= s.maxUploads) throw new GoneException('本次扫码上传次数已用完，请重新生成二维码');
    return s;
  }

  /** 手机端打开页面：只告诉它要传什么、还能传几张。 */
  async inspect(token: string) {
    const s = await this.live(token);
    const { def, field } = this.fieldOf(s.resourceType, s.fieldKey);
    if (!s.scannedAt) await this.ds.manager.update(PhoneUploadSession, { id: s.id }, { scannedAt: new Date() });
    return { label: field.label, resource: def.label, remaining: s.maxUploads - s.uploadCount, expiresAt: s.expiresAt.toISOString() };
  }

  /** 手机端传一张图片（只收图片，按文件头判断，不信扩展名）。 */
  async upload(token: string, file: UploadedFile | undefined) {
    if (!file || file.size === 0) throw new BadRequestException('没有收到图片');
    const kind = sniffFile(file.buffer);
    if (!kind?.image) throw new BadRequestException('只能上传图片（png、jpg、gif、webp）');
    return this.ds.transaction(async (em) => {
      const s = await em.findOne(PhoneUploadSession, { where: { tokenHash: TOKEN_RE.test(String(token ?? '')) ? hashOf(token) : '-' }, lock: { mode: 'pessimistic_write' } });
      if (!s || s.expiresAt.getTime() <= Date.now()) throw new GoneException('二维码已失效，请在电脑上重新生成');
      if (s.uploadCount >= s.maxUploads) throw new GoneException('本次扫码上传次数已用完，请重新生成二维码');
      this.fieldOf(s.resourceType, s.fieldKey);
      const owner = await em.findOne(User, { where: { id: s.userId, companyId: s.companyId }, select: ['id', 'status'] });
      if (!owner || owner.status !== 'active') throw new ForbiddenException('发起上传的账号已停用');
      const info = await this.files.putBlob(s.companyId, s.userId, s.resourceType, s.fieldKey, file, em);
      s.uploadCount += 1;
      s.fileIds = [...s.fileIds, info.id];
      await em.save(PhoneUploadSession, s);
      await em.save(AuditLog, em.create(AuditLog, { companyId: s.companyId, actorId: s.userId, action: 'phone-upload.file', resourceType: s.resourceType, resourceId: null, detail: { field: s.fieldKey, sessionId: s.id, fileId: info.id } }));
      return { ok: true, remaining: s.maxUploads - s.uploadCount };
    });
  }
}
