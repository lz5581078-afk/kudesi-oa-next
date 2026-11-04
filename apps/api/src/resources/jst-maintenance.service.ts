import { assertJstNormalPricePrecision } from '../outbox/jst-price-precision';
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, Like } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { Company, OutboxJob, ResourceRecord } from '../entities';
import { OutboxService, type OutboxSender } from '../outbox/outbox.service';
import { createChecker, querySearchTerms } from '@kudesi/shared';
import { timingSafeEqual } from 'crypto';
import { CryptoService } from '../common/crypto.service';
import { projectUploadCategories, uploadCategoryProblem } from './jst-upload-categories';
import { ResourcesService } from './resources.service';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** 普通商品资料上传表单：字段、必填项都在服务端校验，不信前端。数字字段按数字上传。 */
export const JST_UPLOAD_TEXT = ['skuId', 'styleId', 'name', 'shortName', 'enabled', 'itemType', 'stockDisabled', 'remark', 'propertiesValue', 'categoryName', 'virtualCategory', 'brand', 'labels', 'skuCode', 'otherCode',
  'unit', 'supplierName', 'supplierSkuId', 'supplierStyleId', 'pic', 'picBig', 'productionLicence', 'productionBatchFormat', 'other1', 'other2', 'other3', 'other4', 'other5'] as const;
export const JST_UPLOAD_NUMBER = ['marketPrice', 'salePrice', 'costPrice', 'purchasePrice', 'weight', 'length', 'width', 'height', 'volume', 'shelfLife', 'otherPrice1', 'otherPrice2', 'otherPrice3', 'otherPrice4', 'otherPrice5'] as const;
export const JST_REQUIRED: Array<[string, string]> = [
  ['skuId', '商品编码'], ['styleId', '款式编码'], ['name', '商品名称'], ['shortName', '商品简称'], ['propertiesValue', '颜色及规格'], ['categoryName', '分类'],
  ['brand', '品牌'], ['costPrice', '成本价'], ['purchasePrice', '采购价'], ['weight', '重量'], ['unit', '单位'],
];

export type UploadForm = Record<string, string | number | null | undefined>;

@Injectable()
export class JstMaintenanceService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly resources: ResourcesService, private readonly outbox: OutboxService, private readonly crypto: CryptoService) {}

  private identity(q: { skuId?: unknown; styleId?: unknown; name?: unknown }) {
    return { skuId: str(q.skuId).trim(), styleId: str(q.styleId).trim(), name: str(q.name).trim() };
  }

  private async collect(user: AuthUser, identity: ReturnType<JstMaintenanceService['identity']>, em: EntityManager, sender: OutboxSender) {
    const rows = await em.find(ResourceRecord, { where: [
      { companyId: user.companyId, type: 'finance-base-codes' }, { companyId: user.companyId, type: 'finance-bundles' }, { companyId: user.companyId, type: 'finance-jst-skus' },
    ], order: { id: 'ASC' }, ...(em.queryRunner?.isTransactionActive ? { lock: { mode: 'pessimistic_read' as const } } : {}) });
    const matches: Array<{ source: string; field: 'skuId' | 'styleId' | 'name'; level: 'high' | 'warning'; hit: string; skuId: string; styleId: string; name: string; spec: string; category: string }> = [];
    const add = (row: { skuId: string; styleId: string; name: string; spec: string; category: string }, source: string) => {
      for (const field of ['skuId', 'styleId', 'name'] as const) if (identity[field] && row[field].trim().toLowerCase() === identity[field].toLowerCase()) matches.push({ ...row, source, field, level: field === 'skuId' ? 'high' : 'warning', hit: row.name || row.skuId });
    };
    for (const row of rows) add({ skuId: str(row.type === 'finance-jst-skus' ? row.data.skuId : row.data.code), styleId: str(row.data.styleCode ?? row.data.styleId), name: str(row.data.name) || row.title, spec: str(row.data.propertiesValue ?? row.data.spec), category: str(row.data.categoryName) }, row.type === 'finance-base-codes' ? '本地基础编码' : row.type === 'finance-bundles' ? '本地组合编码' : '本地缓存');
    const errors: string[] = [];
    if (!sender.configured || !sender.searchNormal) errors.push('聚水潭实时查重未完成，请核对聚水潭资料后再继续。');
    else {
      try { for (const row of await sender.searchNormal(identity)) add(row, '聚水潭实时'); }
      catch { errors.push('聚水潭实时查重失败，请核对聚水潭资料后再继续。'); }
    }
    matches.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { hasHighRisk: matches.some(match => match.level === 'high'), hasWarning: errors.length > 0 || matches.some(match => match.level === 'warning'), matches, errors };
  }

  private signedValue(user: AuthUser, identity: ReturnType<JstMaintenanceService['identity']>, target: string, result: Awaited<ReturnType<JstMaintenanceService['collect']>>, issued: number) {
    return JSON.stringify(['jst-normal-upload-precheck:1', user.companyId, user.id, user.permissions.isCompanyAdmin, [...user.permissions.allow].sort(), [...user.permissions.deny].sort(), identity, target, result, issued]);
  }

  /** 只返回核对必要字段；签名由服务器HMAC生成，绑定公司/人员/权限、三身份、真实目标账号及当前命中。 */
  async checkDuplicate(user: AuthUser, q: { skuId?: string; styleId?: string; name?: string; categoryName?: string }) {
    const identity = this.identity(q);
    if (!identity.skuId || !identity.styleId || !identity.name) throw new BadRequestException('请填写商品编码、款式编码和商品名称后再查重');
    const sender = await this.outbox.senderFor(user.companyId);
    if (q.categoryName !== undefined) await this.validateCategory(sender, str(q.categoryName).trim());
    const result = await this.collect(user, identity, this.ds.manager, sender);
    const issued = Date.now();
    return { ...result, signature: sender.targetKey ? `${issued}.${this.crypto.indexTokens(this.signedValue(user, identity, sender.targetKey, result, issued))[0]}` : null };
  }

  private async readCategories(sender: OutboxSender) {
    if (!sender.configured || !sender.readCategories) throw new BadRequestException('聚水潭分类拉取失败，请刷新后重试。');
    try { return projectUploadCategories(await sender.readCategories()); }
    catch { throw new BadRequestException('聚水潭分类拉取失败，请刷新后重试。'); }
  }

  private async validateCategory(sender: OutboxSender, selected: string) {
    const problem = uploadCategoryProblem(await this.readCategories(sender), selected);
    if (problem) throw new BadRequestException(problem);
  }

  /** 商品分类来自当前公司的聚水潭只读接口；不可安全上传的节点保留并明确说明。 */
  async options(user: AuthUser) {
    try {
      const categoryOptions = await this.readCategories(await this.outbox.senderFor(user.companyId));
      return { categories: categoryOptions.filter(option => !option.disabled).map(option => option.value), categoryOptions, brands: [] as string[], errors: {} as Record<string, string> };
    } catch { return { categories: [] as string[], categoryOptions: [] as ReturnType<typeof projectUploadCategories>, brands: [] as string[], errors: { category: '聚水潭分类拉取失败，请刷新后重试。' } }; }
  }

  private clean(form: UploadForm): UploadForm {
    const allowed = new Set<string>([...JST_UPLOAD_TEXT, ...JST_UPLOAD_NUMBER]);
    if (Object.keys(form).some(key => !allowed.has(key) || !['string', 'number', 'undefined'].includes(typeof form[key]) && form[key] !== null)) throw new BadRequestException('上传内容包含不支持的字段');
    const out: UploadForm = {};
    for (const k of JST_UPLOAD_TEXT) { const v = str(form[k]).trim(), limit = k === 'remark' ? 500 : 200; if (v.length > limit) throw new BadRequestException(`「${k}」最多${limit}字`); if (v) out[k] = v; }
    for (const k of JST_UPLOAD_NUMBER) {
      const raw = form[k];
      if (raw === undefined || raw === null || raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`「${k}」要填不小于 0 的数字`);
      out[k] = n;
    }
    return out;
  }

  /** 预检复核、上传登记、唯一出站任务在同一公司锁和事务内完成。不会直接发送外部请求。 */
  async upload(user: AuthUser, form: UploadForm, options: { signature?: string; confirmed?: boolean } = {}) {
    if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能把商品资料上传到聚水潭');
    if (!createChecker(user.permissions)('product.cost.edit')) throw new ForbiddenException('没有修改成本的权限');
    const f = this.clean(form);
    try { assertJstNormalPricePrecision(f); } catch (e) { throw new BadRequestException((e as Error).message); }
    const missing = JST_REQUIRED.filter(([key]) => f[key] === undefined).map(([, label]) => label);
    if (missing.length) throw new BadRequestException(`请填写：${missing.join('、')}`);
    return this.ds.transaction(async em => {
      const company = await em.findOne(Company, { where: { id: user.companyId }, lock: { mode: 'pessimistic_write' } });
      if (!company) throw new ForbiddenException('公司不存在');
      const sender = await this.outbox.senderFor(user.companyId);
      const target = sender.targetKey;
      if (!target) throw new ConflictException('聚水潭目标账号尚未确认，请配置连接后重新查重');
      await this.validateCategory(sender, str(f.categoryName));
      const identity = this.identity(f), result = await this.collect(user, identity, em, sender);
      if (result.hasHighRisk && !options.confirmed) throw new ConflictException(`商品编码「${str(f.skuId)}」已经存在，继续上传会覆盖原资料，请核对查重结果后明确确认`);
      if (result.hasWarning && !options.confirmed) throw new ConflictException('发现重复或查重提示，请核对结果后明确确认');
      const split = options.signature?.indexOf('.') ?? -1;
      const issued = Number(options.signature?.slice(0, split));
      const actual = options.signature?.slice(split + 1) ?? '';
      const actualBytes = Buffer.from(actual);
      const expected = this.crypto.indexTokens(this.signedValue(user, identity, target, result, issued));
      if (split < 1 || !Number.isSafeInteger(issued) || Date.now() - issued > 300000 || issued > Date.now() + 1000 || !expected.some(value => { const bytes = Buffer.from(value); return bytes.length === actualBytes.length && timingSafeEqual(bytes, actualBytes); })) throw new ConflictException('查重结果已失效或资料/账号发生变化，请重新查重并核对');
      const baseKey = 'normal-upload:' + this.crypto.indexTokens(JSON.stringify([user.companyId, target, Object.entries(f).sort(([a], [b]) => a.localeCompare(b)), result]))[0];
      const previous = await em.find(OutboxJob, { where: { companyId: user.companyId, idempotencyKey: Like(`${baseKey}%`) }, order: { id: 'DESC' } });
      const prior = previous.find(job => ['pending', 'sending'].includes(job.status));
      if (prior) return { id: prior.resourceId, queued: false, warnings: result.matches, status: 'queued' as const };
      const key = previous.length ? `${baseKey}:${previous.length}` : baseKey;
      const note = ['商品资料上传', ...(result.hasHighRisk ? ['已核对并确认覆盖重复商品编码'] : []), ...(result.hasWarning ? ['已核对重复或查重提示后继续'] : [])].join('；');
      const rec = await this.resources.createRecord(em, user, 'finance-jst-uploads', { skuId: f.skuId, styleId: f.styleId, name: f.name, payload: JSON.stringify(f), message: '已加入同步队列，等待发送', createdAtKey: new Date().toISOString() }, note);
      const queued = await this.outbox.enqueueUpload(user, rec.id, { ...f, sku_id: f.skuId, i_id: f.styleId }, { em, expectedTargetKey: target, idempotencyKey: key });
      return { id: rec.id, queued: queued.queued, warnings: result.matches, status: 'queued' as const };
    });
  }

  async logs(user: AuthUser, q: { keyword?: string; page: number; pageSize: number }) {
    const where = ['company_id = ?', "type = 'finance-jst-uploads'"];
    const args: unknown[] = [user.companyId];
    const terms = querySearchTerms(q.keyword ?? '');
    if (terms.length > 100) throw new BadRequestException('一次最多搜索100条内容');
    if (terms.length) { where.push(`(${terms.map(() => "(title LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.message')) LIKE ?)").join(' OR ')})`); for (const term of terms) args.push(`%${term}%`, `%${term}%`); }
    const [{ n }] = await this.ds.query(`SELECT COUNT(*) AS n FROM resource_records WHERE ${where.join(' AND ')}`, args);
    const rows: Array<{ id: number; title: string; status: string; data: string | Record<string, unknown>; createdAt: string }> = await this.ds.query(`SELECT id, title, status, data, created_at AS createdAt FROM resource_records WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
    return {
      total: Number(n), page: q.page, pageSize: q.pageSize,
      rows: rows.map((r: { id: number; title: string; status: string; data: string | Record<string, unknown>; createdAt: string }) => {
        const d = typeof r.data === 'string' ? (JSON.parse(r.data) as Record<string, unknown>) : r.data;
        // 上传内容里有成本价、采购价，列表里不返回
        return { id: r.id, skuId: r.title, styleId: str(d.styleId), name: str(d.name), status: r.status, message: str(d.message), createdAt: r.createdAt };
      }),
    };
  }
}
