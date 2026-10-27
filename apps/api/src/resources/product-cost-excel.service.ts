import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { ARCHIVE_TYPES, COST_BUCKETS, COST_SOURCE_TYPES, unitYuanText, yuanToPreciseCents } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { ResourcesService } from './resources.service';

/**
 * 商品档案成本 Excel 批量导入导出（旧 product-archive-cost-excel-utils / product-archive-costs.js）：
 * 一张“商品档案成本”表，按 档案编号 + 成本类型 + 生效开始 匹配已有记录（有则更新、无则新增，不删除文件里没有的）；
 * 先预检（整批在事务里真跑一遍再回滚，任一错误整份不导入），确认码一致才真正导入。
 */
export const COST_SHEET = '商品档案成本';
export const COST_HEADERS = ['档案编号', '档案名称', '档案类型', '成本类型', '单位成本', '计价单位', '生效开始', '生效结束', '来源类型', '来源说明', '计算方式', '手工锁定', '锁定原因', '状态', '备注'] as const;
export type CostRow = Record<string, string>;
export interface CostIssue { sheet: string; row: number; field: string; message: string }
const MAX_ROWS = 5000;

const t = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
const BUCKET: Record<string, string> = Object.fromEntries(COST_BUCKETS.flatMap((o) => [[o.label, o.value], [o.value, o.value]]));
// 旧系统导入的“来源类型”只允许固定中文选项；Excel 导入由系统写入，不能冒充“档案采购价同步”
const SOURCE: Record<string, string> = Object.fromEntries(COST_SOURCE_TYPES.filter((o) => o.value !== 'archive_purchase_price').flatMap((o) => [[o.label, o.value], [o.value, o.value]]));
const TYPE_LABEL = Object.fromEntries(ARCHIVE_TYPES.map((o) => [o.value, o.label.replace(/档案$/, '')]));
const SOURCE_LABEL = Object.fromEntries(COST_SOURCE_TYPES.map((o) => [o.value, o.label]));
const BUCKET_LABEL = Object.fromEntries(COST_BUCKETS.map((o) => [o.value, o.label]));
const validDate = (s: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
class Rollback extends Error {}

@Injectable()
export class ProductCostExcelService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly resources: ResourcesService) {}

  confirmCode(companyId: number, rows: CostRow[]): string {
    return `IMPORT-ARCHIVE-COST-${companyId}-${crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 8).toUpperCase()}`;
  }

  /** 模板：每个启用档案一行，成本类型默认采购成本、单位成本 0（示例，请改后再导入） */
  async template(user: AuthUser) {
    const em = this.dataSource.manager;
    const products = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-products', status: 'active' }, order: { id: 'ASC' } });
    const today = new Date().toISOString().slice(0, 10);
    return { headers: [...COST_HEADERS], rows: products.map((p) => [t(p.data.code), p.title, TYPE_LABEL[t(p.data.archiveType)] ?? '', '采购成本', '0', t(p.data.purchaseSpec) || '', today, '', '人工录入', '', '', '否', '', '启用', '']) };
  }

  async export(user: AuthUser) {
    const em = this.dataSource.manager;
    const [costs, products] = await Promise.all([
      em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-product-costs' }, order: { id: 'ASC' } }),
      em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-products' }, select: ['id', 'title', 'data'] }),
    ]);
    const byId = new Map(products.map((p) => [p.id, p]));
    const rows = costs.map((c) => {
      const p = byId.get(Number(c.data.productId));
      return [t(p?.data.code), p?.title ?? '', TYPE_LABEL[t(p?.data.archiveType)] ?? '', BUCKET_LABEL[t(c.data.costType)] ?? t(c.data.costType), typeof c.data.unitCost === 'number' ? unitYuanText(c.data.unitCost) : '', t(c.data.unitName), t(c.data.effectiveFrom), t(c.data.effectiveTo), SOURCE_LABEL[t(c.data.sourceType)] ?? t(c.data.sourceType), t(c.data.sourceRef), t(c.data.calculationMethod), c.data.manualOverride === true ? '是' : '否', t(c.data.manualLockReason), c.status === 'active' ? '启用' : '停用', t(c.data.note)];
    }).sort((a, b) => a[0].localeCompare(b[0]) || a[6].localeCompare(b[6]));
    return { headers: [...COST_HEADERS], rows };
  }

  async preflight(user: AuthUser, rows: CostRow[]) {
    const r = await this.run(user, rows, true);
    return { ...r, confirm: r.errors.length || r.created + r.updated === 0 ? null : this.confirmCode(user.companyId, rows) };
  }

  async execute(user: AuthUser, rows: CostRow[], confirm: string) {
    if (confirm !== this.confirmCode(user.companyId, rows)) throw new BadRequestException('确认码不对：请先预检，并用预检后给出的确认码导入（预检后表格有改动要重新预检）');
    const r = await this.run(user, rows, false);
    if (r.errors.length) throw new BadRequestException(`有 ${r.errors.length} 个问题，没有导入：${r.errors.slice(0, 3).map((e) => `第${e.row}行${e.field ? `「${e.field}」` : ''}${e.message}`).join('；')}`);
    return r;
  }

  private async run(user: AuthUser, rows: CostRow[], dry: boolean) {
    if (!rows.length) throw new BadRequestException('没有可导入的商品档案成本');
    if (rows.length > MAX_ROWS) throw new BadRequestException(`单次最多导入 ${MAX_ROWS} 条档案成本`);
    const errors: CostIssue[] = [];
    const warnings: CostIssue[] = [];
    let created = 0;
    let updated = 0;
    const err = (row: number, field: string, message: string) => errors.push({ sheet: COST_SHEET, row, field, message });
    try {
      await this.dataSource.transaction(async (em) => {
        const products = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-products' } });
        const byCode = new Map<string, ResourceRecord[]>();
        for (const p of products) { const k = t(p.data.code).toUpperCase(); if (k) byCode.set(k, [...(byCode.get(k) ?? []), p]); }
        const allCosts = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-product-costs' } });
        const seen = new Map<string, number>();
        for (const [i, r] of rows.entries()) {
          const row = i + 2;
          const code = t(r['档案编号']).toUpperCase();
          const before = errors.length;
          if (!code) err(row, '档案编号', '档案编号必填');
          const costType = t(r['成本类型']) ? BUCKET[t(r['成本类型'])] : 'purchase';
          if (!costType) err(row, '成本类型', `成本类型只能是${COST_BUCKETS.map((o) => o.label).join('、')}`);
          const yuan = t(r['单位成本']);
          let cents: number | null = null;
          try { cents = yuan === '' ? null : yuanToPreciseCents(yuan); } catch { cents = null; }
          if (cents === null || !Number.isFinite(cents) || cents < 0) err(row, '单位成本', '单位成本必须是非负数（元，最多 6 位小数）');
          if (!t(r['计价单位'])) err(row, '计价单位', '计价单位必填');
          const from = t(r['生效开始']);
          const to = t(r['生效结束']);
          if (!validDate(from)) err(row, '生效开始', '生效开始必须是有效日期（年-月-日）');
          if (to && !validDate(to)) err(row, '生效结束', '生效结束必须是有效日期（年-月-日）');
          if (validDate(from) && to && validDate(to) && from > to) err(row, '生效结束', '生效结束不能早于生效开始');
          const sourceType = t(r['来源类型']) ? SOURCE[t(r['来源类型'])] : 'excel_import';
          if (!sourceType) err(row, '来源类型', '来源类型不在系统允许的选项中');
          const lock = ['是', 'Y', 'YES', '1', 'TRUE'].includes(t(r['手工锁定']).toUpperCase());
          if (lock && !t(r['锁定原因'])) err(row, '锁定原因', '手工锁定时锁定原因必填');
          const key = `${code}:${costType}:${from}`;
          if (seen.has(key)) err(row, '档案编号', `与第 ${seen.get(key)} 行的档案、成本类型和生效日期重复`); else seen.set(key, row);
          const matches = byCode.get(code) ?? [];
          if (code && matches.length !== 1) err(row, '档案编号', matches.length ? `档案编号 ${code} 匹配到多条档案` : `当前公司没有档案 ${code}`);
          if (errors.length > before) continue;
          const product = matches[0];
          const existing = allCosts.find((c) => c.data.productId === product.id && c.data.costType === costType && t(c.data.effectiveFrom) === from);
          if (existing?.data.manualOverride === true) { err(row, '手工锁定', `已有成本记录 #${existing.id} 已手工锁定，请先在商品档案成本明细中解除锁定后再导入`); continue; }
          if (t(r['计价单位']) !== t(product.data.purchaseSpec) && t(product.data.purchaseSpec)) warnings.push({ sheet: COST_SHEET, row, field: '计价单位', message: `计价单位 ${t(r['计价单位'])} 与档案系统规格 ${t(product.data.purchaseSpec)} 不同，计算时将提示单位不一致` });
          const values: Record<string, unknown> = {
            productId: product.id, costType, unitCost: cents, unitName: t(r['计价单位']), effectiveFrom: from, effectiveTo: to || null, sourceType,
            sourceRef: t(r['来源说明']) || null, calculationMethod: t(r['计算方式']) || null, manualOverride: lock || null, manualLockReason: lock ? t(r['锁定原因']) : null, note: t(r['备注']) || null,
          };
          const status = t(r['状态']) === '停用' ? 'inactive' : 'active';
          try {
            let id: number;
            if (existing) { await this.resources.updateRecord(em, user, 'finance-product-costs', existing.id, values, 'Excel 导入更新'); id = existing.id; updated++; }
            else { id = (await this.resources.createRecord(em, user, 'finance-product-costs', values, 'Excel 导入')).id; created++; }
            if (status === 'inactive') await this.resources.setStatusChecked(em, user, 'finance-product-costs', id, 'inactive', 'Excel 导入：停用');
            else if (existing && existing.status !== 'active') await this.resources.setStatusChecked(em, user, 'finance-product-costs', id, 'active', 'Excel 导入：启用');
          } catch (e) { err(row, '', e instanceof Error ? e.message : '保存失败'); }
        }
        if (dry || errors.length) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    return { errors, warnings, created, updated, rowCount: rows.length };
  }
}
