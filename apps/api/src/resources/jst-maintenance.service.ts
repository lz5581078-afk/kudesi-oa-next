import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
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
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly resources: ResourcesService, private readonly outbox: OutboxService) {}

  /** 编码、款式编码、名称分别和本地基础编码、本地组合、聚水潭镜像比对。编码已存在是高风险（不让传），款式编码/名称重复只是提醒。 */
  async checkDuplicate(user: AuthUser, q: { skuId?: string; styleId?: string; name?: string }) {
    const em = this.ds.manager;
    const sku = str(q.skuId).trim().toLowerCase(), style = str(q.styleId).trim().toLowerCase(), name = str(q.name).trim().toLowerCase();
    const rows = await em.find(ResourceRecord, { where: [
      { companyId: user.companyId, type: 'finance-base-codes' }, { companyId: user.companyId, type: 'finance-bundles' }, { companyId: user.companyId, type: 'finance-jst-skus' },
    ] });
    const matches: { source: string; field: 'skuId' | 'styleId' | 'name'; level: 'high' | 'warning'; hit: string }[] = [];
    for (const r of rows) {
      const src = r.type === 'finance-base-codes' ? '本地基础编码' : r.type === 'finance-bundles' ? '本地组合编码' : r.data.goodsType === 'combine' ? '聚水潭组合装' : '聚水潭普通商品';
      const code = str(r.type === 'finance-jst-skus' ? r.data.skuId : r.data.code).toLowerCase();
      const rs = str(r.data.styleCode ?? r.data.styleId).toLowerCase();
      const rn = str(r.data.name).toLowerCase() || r.title.toLowerCase();
      if (sku && code === sku) matches.push({ source: src, field: 'skuId', level: 'high', hit: r.title });
      if (style && rs === style) matches.push({ source: src, field: 'styleId', level: 'warning', hit: r.title });
      if (name && rn === name) matches.push({ source: src, field: 'name', level: 'warning', hit: r.title });
    }
    return { hasHighRisk: matches.some((m) => m.level === 'high'), hasWarning: matches.some((m) => m.level === 'warning'), matches };
  }

  /** 分类、品牌的可选项：来自本地商品分类（最末级）和品牌资料；不会去调聚水潭。 */
  async options(user: AuthUser) {
    const em = this.ds.manager;
    const cats = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-categories', status: 'active' } });
    const byId = new Map(cats.map((c) => [c.id, c]));
    const parents = new Set(cats.map((c) => Number(c.data.parentId)).filter(Boolean));
    const path = (c: ResourceRecord) => { const out: string[] = []; for (let cur: ResourceRecord | undefined = c, i = 0; cur && i < 6; i++, cur = byId.get(Number(cur.data.parentId))) out.unshift(cur.title); return out.join('/'); };
    const brands = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-brands', status: 'active' } });
    return { categories: cats.filter((c) => !parents.has(c.id)).map(path).sort(), brands: brands.map((b) => b.title).sort() };
  }

  private clean(form: UploadForm): UploadForm {
    const out: UploadForm = {};
    for (const k of JST_UPLOAD_TEXT) { const v = str(form[k]).trim(); if (v) out[k] = v.slice(0, k === 'remark' ? 500 : 200); }
    for (const k of JST_UPLOAD_NUMBER) {
      const raw = form[k];
      if (raw === undefined || raw === null || raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`「${k}」要填不小于 0 的数字`);
      out[k] = n;
    }
    return out;
  }

  /** 上传：服务端再校验必填项、再查一次重复，通过后只“加入出站队列”（需要管理员，且总开关开着、接入真实接口后才会真正发送）。 */
  async upload(user: AuthUser, form: UploadForm) {
    if (!user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能把商品资料上传到聚水潭');
    const f = this.clean(form);
    const missing = JST_REQUIRED.filter(([k]) => f[k] === undefined).map(([, label]) => label);
    if (missing.length) throw new BadRequestException(`请填写：${missing.join('、')}`);
    const dup = await this.checkDuplicate(user, { skuId: str(f.skuId), styleId: str(f.styleId), name: str(f.name) });
    if (dup.hasHighRisk) throw new ConflictException(`商品编码「${str(f.skuId)}」已经存在（${dup.matches.find((m) => m.level === 'high')?.source}），不能重复上传`);
    const rec = await this.resources.createRecord(this.ds.manager, user, 'finance-jst-uploads', {
      skuId: f.skuId, styleId: f.styleId, name: f.name, payload: JSON.stringify(f), message: '已加入同步队列，等待发送', createdAtKey: new Date().toISOString(),
    }, '商品资料上传');
    const q = await this.outbox.enqueueUpload(user, rec.id, { ...f, sku_id: f.skuId, i_id: f.styleId });
    return { id: rec.id, queued: q.queued, warnings: dup.matches.filter((m) => m.level === 'warning') };
  }

  async logs(user: AuthUser, q: { keyword?: string; page: number; pageSize: number }) {
    const where = ['company_id = ?', "type = 'finance-jst-uploads'"];
    const args: unknown[] = [user.companyId];
    if (q.keyword?.trim()) { where.push('(title LIKE ? OR search_text LIKE ?)'); args.push(`%${q.keyword.trim()}%`, `%${q.keyword.trim()}%`); }
    const [{ n }] = await this.ds.query(`SELECT COUNT(*) AS n FROM resource_records WHERE ${where.join(' AND ')}`, args);
    const rows = await this.ds.query(`SELECT id, title, status, data, created_at AS createdAt FROM resource_records WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, [...args, q.pageSize, (q.page - 1) * q.pageSize]);
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
