import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import { createChecker, getResourceDef, permissionOwner, resourcePermission, ResourceAction } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceFile } from '../entities';
import { IntegrationSettingsService } from './integration-settings.service';
import { ObjectStorage, QiniuClient, QiniuConfig } from './qiniu.client';

export const STORAGE_FACTORY = 'STORAGE_FACTORY';
export type StorageFactory = (cfg: QiniuConfig) => ObjectStorage;
export const defaultStorageFactory: StorageFactory = (cfg) => new QiniuClient(cfg);

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface FileInfo {
  id: number;
  name: string;
  mime: string;
  size: number;
}

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** 按文件头识别类型，不信任浏览器给的 Content-Type 和文件扩展名。 */
export function sniffFile(buf: Buffer): { mime: string; ext: string; image: boolean } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png', image: true };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', image: true };
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('latin1'))) return { mime: 'image/gif', ext: 'gif', image: true };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp', image: true };
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', image: false };
  return null;
}

/** multer 把 UTF-8 文件名按 latin1 解码，这里还原并去掉路径、控制字符。 */
export function cleanFileName(original: string): string {
  let name = original;
  // 只有“每个字符都在 latin1 范围内”才可能是被误解码的 UTF-8；已经是正常中文的名字不能再转，否则会变乱码
  if ([...original].every((c) => c.charCodeAt(0) <= 0xff)) {
    const fixed = Buffer.from(original, 'latin1').toString('utf8');
    if (!fixed.includes(String.fromCharCode(0xfffd))) name = fixed;
  }
  // eslint-disable-next-line no-control-regex
  name = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f]/g, '').trim();
  return (name || '未命名').slice(0, 200);
}

@Injectable()
export class FilesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: IntegrationSettingsService,
    @Inject(STORAGE_FACTORY) private readonly factory: StorageFactory,
  ) {}

  private async storage(companyId: number): Promise<ObjectStorage> {
    const cfg = await this.settings.getQiniu(companyId);
    if (!cfg) throw new BadRequestException('还没有配置七牛云存储，请先到“系统 → 接口设置”填写');
    return this.factory(cfg);
  }

  private assertCan(user: AuthUser, type: string, ...actions: ResourceAction[]) {
    const can = createChecker(user.permissions);
    const owner = permissionOwner(type);
    if (!actions.some((a) => can(resourcePermission(owner, a)))) throw new ForbiddenException('没有权限执行此操作');
  }

  /** 上传到七牛并登记。文件先是“未绑定”状态，保存资料记录时才绑定到记录上。 */
  async upload(user: AuthUser, type: string, fieldKey: string, file: UploadedFile | undefined): Promise<FileInfo> {
    const def = getResourceDef(type);
    const field = def?.fields.find((f) => f.key === fieldKey && f.type === 'files');
    if (!def || !field) throw new BadRequestException('这个字段不支持上传文件');
    this.assertCan(user, type, 'create', 'edit');
    if (!file || file.size === 0) throw new BadRequestException('没有收到文件');
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('文件不能超过 10MB');
    const kind = sniffFile(file.buffer);
    if (!kind || (field.accept === 'image' && !kind.image)) {
      throw new BadRequestException(field.accept === 'image' ? '只能上传图片（png、jpg、gif、webp）' : '只能上传图片或 PDF');
    }
    const storage = await this.storage(user.companyId);
    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    const key = `oa/${user.companyId}/${type}/${month}/${crypto.randomUUID()}.${kind.ext}`;
    const name = cleanFileName(file.originalname);
    try {
      await storage.upload(key, file.buffer, kind.mime, name);
    } catch (e) {
      throw new BadRequestException(`上传到七牛失败：${(e as Error).message}`);
    }
    const row = await this.dataSource.manager.save(
      ResourceFile,
      this.dataSource.manager.create(ResourceFile, {
        companyId: user.companyId, resourceType: type, resourceId: null, fieldKey,
        storageKey: key, name, mime: kind.mime, size: file.size, uploadedBy: user.id,
      }),
    );
    return { id: row.id, name: row.name, mime: row.mime, size: row.size };
  }


  /** 服务端直接存一个文件（提现凭证、助手截图用）：不检查资料权限，调用方负责权限。只收图片和 PDF。 */
  async putBlob(companyId: number, uploadedBy: number | null, type: string, fieldKey: string, file: UploadedFile | undefined): Promise<FileInfo> {
    if (!file || file.size === 0) throw new BadRequestException('没有收到文件');
    if (file.size > MAX_UPLOAD_BYTES) throw new BadRequestException('文件不能超过 10MB');
    const kind = sniffFile(file.buffer);
    if (!kind) throw new BadRequestException('只能上传图片（png、jpg、gif、webp）或 PDF');
    const storage = await this.storage(companyId);
    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    const key = `oa/${companyId}/${type}/${month}/${crypto.randomUUID()}.${kind.ext}`;
    const name = cleanFileName(file.originalname);
    try {
      await storage.upload(key, file.buffer, kind.mime, name);
    } catch (e) {
      throw new BadRequestException(`上传到七牛失败：${(e as Error).message}`);
    }
    const row = await this.dataSource.manager.save(
      ResourceFile,
      this.dataSource.manager.create(ResourceFile, { companyId, resourceType: type, resourceId: null, fieldKey, storageKey: key, name, mime: kind.mime, size: file.size, uploadedBy }),
    );
    return { id: row.id, name: row.name, mime: row.mime, size: row.size };
  }

  /** 同 url()，但权限由调用方负责，并限定文件类型。 */
  async urlOf(companyId: number, id: number, type: string) {
    const row = await this.dataSource.manager.findOne(ResourceFile, { where: { id, companyId, resourceType: type } });
    if (!row) throw new NotFoundException('文件不存在');
    const storage = await this.storage(companyId);
    return { url: storage.downloadUrl(row.storageKey, 300), expiresIn: 300, name: row.name, mime: row.mime };
  }

  /** 把一批文件绑定到某条记录，并删掉该记录上不在名单里的旧文件（返回要删的 key，事务提交后再删）。 */
  async replaceFor(em: EntityManager, companyId: number, type: string, fieldKey: string, recordId: number, ids: number[]): Promise<string[]> {
    await this.verify(em, companyId, type, fieldKey, ids, recordId);
    const gone = await this.dropRemoved(em, companyId, type, recordId, fieldKey, ids);
    await this.bind(em, companyId, recordId, ids);
    return gone;
  }

  /** 接口设置页的“测试”：传一个小文件再删掉。 */
  async selfTest(user: AuthUser) {
    let storage: ObjectStorage;
    try {
      storage = await this.storage(user.companyId);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    const key = `oa/${user.companyId}/_selftest/${crypto.randomUUID()}.pdf`;
    try {
      await storage.upload(key, Buffer.from('%PDF-1.4\n%selftest\n'), 'application/pdf', 'selftest.pdf');
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    await storage.remove(key).catch(() => undefined);
    return { ok: true, message: '七牛可以正常上传' };
  }

  /** 临时下载链接：必须有该资料的查看权限。 */
  async url(user: AuthUser, id: number) {
    const row = await this.dataSource.manager.findOne(ResourceFile, { where: { id, companyId: user.companyId } });
    if (!row) throw new NotFoundException('文件不存在');
    this.assertCan(user, row.resourceType, 'view');
    const storage = await this.storage(user.companyId);
    return { url: storage.downloadUrl(row.storageKey, 300), expiresIn: 300, name: row.name, mime: row.mime };
  }

  async info(companyId: number, ids: number[]): Promise<Map<number, FileInfo>> {
    const out = new Map<number, FileInfo>();
    if (ids.length === 0) return out;
    const rows = await this.dataSource.manager.find(ResourceFile, { where: { companyId, id: In(ids) } });
    rows.forEach((r) => out.set(r.id, { id: r.id, name: r.name, mime: r.mime, size: r.size }));
    return out;
  }

  /** 保存记录前：这些文件必须是本公司、同类型、同字段上传的，且没被别的记录占用。 */
  async verify(em: EntityManager, companyId: number, type: string, fieldKey: string, ids: number[], recordId: number | null) {
    if (ids.length === 0) return;
    const rows = await em.find(ResourceFile, { where: { companyId, id: In(ids) } });
    for (const id of ids) {
      const r = rows.find((x) => x.id === id);
      if (!r || r.resourceType !== type || r.fieldKey !== fieldKey || (r.resourceId !== null && r.resourceId !== recordId)) {
        throw new BadRequestException('包含无效的文件，请重新上传');
      }
    }
  }

  async bind(em: EntityManager, companyId: number, recordId: number, ids: number[]) {
    if (ids.length > 0) await em.update(ResourceFile, { companyId, id: In(ids) }, { resourceId: recordId });
  }

  /** 字段里去掉的文件：删除登记，返回需要从七牛删除的 key（提交事务后再删）。 */
  async dropRemoved(em: EntityManager, companyId: number, type: string, recordId: number, fieldKey: string, keep: number[]): Promise<string[]> {
    const rows = await em.find(ResourceFile, { where: { companyId, resourceType: type, resourceId: recordId, fieldKey } });
    const gone = rows.filter((r) => !keep.includes(r.id));
    if (gone.length > 0) await em.delete(ResourceFile, { companyId, id: In(gone.map((g) => g.id)) });
    return gone.map((g) => g.storageKey);
  }

  async deleteAllFor(em: EntityManager, companyId: number, type: string, recordId: number): Promise<string[]> {
    const rows = await em.find(ResourceFile, { where: { companyId, resourceType: type, resourceId: recordId } });
    if (rows.length > 0) await em.delete(ResourceFile, { companyId, id: In(rows.map((r) => r.id)) });
    return rows.map((r) => r.storageKey);
  }

  /** 尽力删除七牛上的对象；失败只记录，不影响业务（对象残留不会被任何记录引用）。 */
  async deleteObjects(companyId: number, keys: string[]) {
    if (keys.length === 0) return;
    try {
      const storage = await this.storage(companyId);
      await Promise.all(keys.map((k) => storage.remove(k).catch((e) => console.warn(`删除七牛文件失败 ${k}：${(e as Error).message}`))));
    } catch (e) {
      console.warn(`删除七牛文件失败：${(e as Error).message}`);
    }
  }
}
