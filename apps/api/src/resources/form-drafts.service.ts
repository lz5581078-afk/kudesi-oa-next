import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createChecker, getResourceDef, restrictedFieldKeys } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { CryptoService } from '../common/crypto.service';
import { FormDraft } from '../entities';

const KEY_RE = /^[A-Za-z0-9%:_\-.]{1,190}$/;
const MODULE_RE = /^resource:[a-z0-9-]{1,60}$/;
const MAX_BYTES = 200 * 1024;

/**
 * 表单草稿（旧系统 form-drafts）：新增资料时“存为草稿”，下次点新增自动恢复。
 * 草稿只属于本人：公司和用户都取自登录令牌；只能存有“新增”权限的资料类型。
 */
@Injectable()
export class FormDraftsService {
  constructor(private readonly ds: DataSource, private readonly crypto: CryptoService) {}

  private check(user: AuthUser, key: string, moduleKey?: string) {
    if (!KEY_RE.test(key)) throw new BadRequestException('草稿标识不合法');
    if (moduleKey !== undefined) {
      if (!MODULE_RE.test(moduleKey)) throw new BadRequestException('草稿模块不合法');
      const type = moduleKey.slice('resource:'.length);
      if (!getResourceDef(type)) throw new BadRequestException('草稿模块不存在');
      if (!createChecker(user.permissions)(`resource.${type}.create`)) throw new ForbiddenException('你没有新增这类资料的权限，不能保存草稿');
    }
  }

  async get(user: AuthUser, key: string) {
    this.check(user, key);
    const d = await this.ds.manager.findOne(FormDraft, { where: { companyId: user.companyId, userId: user.id, draftKey: key } });
    if (!d) return { draft: null };
    this.check(user, key, d.moduleKey);
    // 兼容已存在的明文草稿；新草稿整体加密，避免收款账号等字段绕过主档案的加密规则。
    const payload = typeof d.payload.__encryptedDraft === 'string' ? JSON.parse(this.crypto.decrypt(d.payload.__encryptedDraft)) as Record<string, unknown> : { ...d.payload };
    const def = getResourceDef(d.moduleKey.slice('resource:'.length))!;
    const can = createChecker(user.permissions);
    for (const field of restrictedFieldKeys(def, can)) delete payload[field];
    if (!can('product.cost.view') && payload.__productParts && typeof payload.__productParts === 'object') {
      const parts = payload.__productParts as Record<string, unknown>;
      if (Array.isArray(parts.sources)) parts.sources = parts.sources.map(source => { if (!source || typeof source !== 'object' || Array.isArray(source)) return source; const { purchasePrice: _p, ...rest } = source; return rest; });
    }
    return { draft: { key: d.draftKey, moduleKey: d.moduleKey, title: d.title, sourceRecordId: d.sourceRecordId, payload, updatedAt: d.updatedAt } };
  }

  async put(user: AuthUser, key: string, body: { moduleKey: string; title?: string; sourceRecordId?: string; payload: Record<string, unknown> }) {
    this.check(user, key, body.moduleKey);
    if (!key.startsWith(encodeURIComponent(body.moduleKey))) throw new BadRequestException('草稿标识和模块不一致');
    if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) throw new BadRequestException('草稿内容不合法');
    if (Buffer.byteLength(JSON.stringify(body.payload)) > MAX_BYTES) throw new BadRequestException('草稿内容太大');
    const values = { moduleKey: body.moduleKey, title: (body.title ?? '').slice(0, 200), sourceRecordId: body.sourceRecordId ? body.sourceRecordId.slice(0, 40) : null, payload: { __encryptedDraft: this.crypto.encrypt(JSON.stringify(body.payload)) } };
    const where = { companyId: user.companyId, userId: user.id, draftKey: key };
    const hit = await this.ds.manager.findOne(FormDraft, { where });
    await this.ds.manager.save(FormDraft, hit ? Object.assign(hit, values) : this.ds.manager.create(FormDraft, { ...where, ...values }));
    return this.get(user, key);
  }

  async remove(user: AuthUser, key: string) {
    this.check(user, key);
    await this.ds.manager.delete(FormDraft, { companyId: user.companyId, userId: user.id, draftKey: key });
    return { ok: true };
  }
}
