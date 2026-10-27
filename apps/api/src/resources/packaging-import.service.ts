import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { createChecker, PACKAGING_SCENES } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceLink, ResourceRecord } from '../entities';
import { ResourcesService } from './resources.service';

/** 包装方案 Excel（旧系统三张表）：方案 + 明细 + 匹配规则一起导入导出，先预检，确认码一致才真正导入，整批同成同败。 */
export const PACKAGING_SHEETS = { schemes: '包装方案', lines: '包装方案明细', rules: '匹配规则' } as const;
export const PACKAGING_HEADERS = {
  schemes: ['方案编码', '方案名称', '使用场景', '商品分类', '品牌', '生效日期', '失效日期', '状态', '来源类型', '来源说明', '备注'],
  lines: ['方案编码', '包装档案编号', '角色', '数量', '单位', '损耗率', '成本归类', '计价处理', '来源行', '排序', '备注'],
  rules: ['方案编码', '目标类型', '目标编码', '商品分类', '品牌', '销售场景', '最小重量kg', '最大重量kg', '离散重量kg', '优先级', '状态', '备注'],
} as const;
export type PackagingSheetRows = { schemes: Array<Record<string, string>>; lines: Array<Record<string, string>>; rules: Array<Record<string, string>> };
export interface PackagingIssue { sheet: string; row: number; field: string; message: string }

const t = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
const SCENE: Record<string, string> = { 自产包装: 'production', 生产包装: 'production', production: 'production', 供应商OEM: 'supplier_oem', '供应商 OEM': 'supplier_oem', 供应商OEM包装: 'supplier_oem', '供应商 OEM 包装': 'supplier_oem', supplier_oem: 'supplier_oem', 发货包装: 'dispatch', dispatch: 'dispatch' };
const ROLE: Record<string, string> = { 包装: 'package', package: 'package', 标签: 'label', label: 'label', 说明书: 'instruction', instruction: 'instruction', 其他: 'other', other: 'other' };
const BUCKET: Record<string, string> = { 发货前包装成本: 'pre_ship_package', pre_ship_package: 'pre_ship_package', 发货包装成本: 'shipping_package', shipping_package: 'shipping_package' };
const TREAT: Record<string, string> = { 计入: 'include', 计入成本: 'include', include: 'include', 已含上级: 'included_in_parent', 含在上级内: 'included_in_parent', included_in_parent: 'included_in_parent', 仅参考: 'reference_only', reference_only: 'reference_only' };
const TARGET: Record<string, string> = { 通用: 'general', general: 'general', 商品基础编码: 'base_code', 基础编码: 'base_code', base_code: 'base_code', 商品组合编码: 'bundle', 商品组合: 'bundle', bundle: 'bundle', bundle_code: 'bundle', 商品档案: 'product_archive', product_archive: 'product_archive' };
const SCENE_LABEL = Object.fromEntries(PACKAGING_SCENES.map((o) => [o.value, o.label]));
class Rollback extends Error {}

@Injectable()
export class PackagingImportService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource, private readonly resources: ResourcesService) {}

  private need(user: AuthUser, action: 'view' | 'create' | 'edit') {
    const can = createChecker(user.permissions);
    for (const k of ['finance-packaging-schemes', 'finance-packaging-lines', 'finance-packaging-rules']) {
      if (!can(`resource.finance-packaging-schemes.${action}`) && !can(`resource.${k}.${action}`)) throw new ForbiddenException('没有包装方案的导入/导出权限');
    }
  }

  confirmCode(rows: PackagingSheetRows): string {
    return `IMPORT-PACKAGING-${crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 8).toUpperCase()}`;
  }

  /** 预检：整批在事务里真跑一遍然后回滚，所有问题一次列全 */
  async preflight(user: AuthUser, rows: PackagingSheetRows) {
    this.need(user, 'create');
    const r = await this.run(user, rows, true);
    return { ...r, confirm: r.errors.length ? null : this.confirmCode(rows) };
  }

  async execute(user: AuthUser, rows: PackagingSheetRows, confirm: string) {
    this.need(user, 'create');
    if (confirm !== this.confirmCode(rows)) throw new BadRequestException('确认码不对：请先预检，并用预检后给出的确认码导入（预检后表格有改动要重新预检）');
    const r = await this.run(user, rows, false);
    if (r.errors.length) throw new BadRequestException(`有 ${r.errors.length} 个问题，没有导入：${r.errors.slice(0, 3).map((e) => `${e.sheet}第${e.row}行${e.field ? `「${e.field}」` : ''}${e.message}`).join('；')}`);
    return r;
  }

  private async run(user: AuthUser, rows: PackagingSheetRows, dry: boolean) {
    const errors: PackagingIssue[] = [];
    const warnings: PackagingIssue[] = [];
    const summary = { schemesCreated: 0, schemesUpdated: 0, lines: 0, rules: 0 };
    const err = (sheet: string, row: number, field: string, message: string) => errors.push({ sheet, row, field, message });
    try {
      await this.dataSource.transaction(async (em) => {
        const find = (type: string) => em.find(ResourceRecord, { where: { companyId: user.companyId, type } });
        const cats = await find('finance-categories');
        const catById = new Map(cats.map((c) => [c.id, c]));
        const catPath = (c: ResourceRecord) => { const out: string[] = []; for (let x: ResourceRecord | undefined = c, i = 0; x && i < 6; i++) { out.unshift(x.title); x = catById.get(Number(x.data.parentId)); } return out.join(' / '); };
        const pick = (list: ResourceRecord[], name: string, label: string, sheet: string, row: number, field: string, path?: (r: ResourceRecord) => string): number | undefined => {
          if (!name) return undefined;
          const key = name.replace(/\s*\/\s*/g, ' / ');
          const hit = list.filter((r) => (path ? path(r) === key : false) || r.title === name || t(r.data.code).toUpperCase() === name.toUpperCase());
          const uniq = path ? (hit.filter((r) => path(r) === key).length ? hit.filter((r) => path(r) === key) : hit) : hit;
          if (uniq.length === 1) return uniq[0].id;
          err(sheet, row, field, uniq.length ? `有 ${uniq.length} 个同名的${label}，请写全路径（上级 / 下级）` : `${label}「${name}」不存在`);
          return undefined;
        };
        const brands = await find('finance-brands');
        const scenarios = await find('finance-scenarios');
        const products = await find('finance-products');
        const prodByCode = new Map(products.filter((p) => t(p.data.code)).map((p) => [t(p.data.code).toUpperCase(), p]));
        const existing = await find('finance-packaging-schemes');
        const existByCode = new Map(existing.map((s) => [t(s.data.schemeCode).toUpperCase(), s]));
        const S = PACKAGING_SHEETS;

        const seen = new Map<string, number>();
        const saved = new Map<string, number>(); // 方案编码 → 方案 id
        for (const [i, r] of rows.schemes.entries()) {
          const row = i + 2;
          const code = t(r['方案编码']).toUpperCase();
          if (!code) { err(S.schemes, row, '方案编码', '必填'); continue; }
          if (seen.has(code)) { err(S.schemes, row, '方案编码', `与第 ${seen.get(code)} 行重复`); continue; }
          seen.set(code, row);
          if (!t(r['方案名称'])) { err(S.schemes, row, '方案名称', '必填'); continue; }
          const scene = SCENE[t(r['使用场景'])];
          if (!scene) { err(S.schemes, row, '使用场景', `必须是${PACKAGING_SCENES.map((o) => o.label).join('、')}（或自产包装、供应商OEM）`); continue; }
          const before = errors.length;
          const values: Record<string, unknown> = {
            schemeCode: code, schemeName: t(r['方案名称']), usageScene: scene,
            categoryId: pick(cats, t(r['商品分类']), '商品分类', S.schemes, row, '商品分类', catPath), brandId: pick(brands, t(r['品牌']), '品牌', S.schemes, row, '品牌'),
            effectiveFrom: t(r['生效日期']) || undefined, effectiveTo: t(r['失效日期']) || undefined, sourceType: t(r['来源类型']) || 'Excel 导入', sourceRef: t(r['来源说明']) || undefined, remark: t(r['备注']) || undefined,
          };
          if (errors.length > before) continue;
          try {
            const ex = existByCode.get(code);
            let id: number;
            if (ex) {
              this.need(user, 'edit');
              // 同编码的方案：整套替换（原来的明细和规则先清掉）
              for (const type of ['finance-packaging-lines', 'finance-packaging-rules']) {
                const kids = (await find(type)).filter((k) => Number(k.data.schemeId) === ex.id);
                for (const k of kids) { await em.delete(ResourceLink, { companyId: user.companyId, sourceId: k.id }); await em.delete(ResourceRecord, { id: k.id, companyId: user.companyId }); }
              }
              await this.resources.updateRecord(em, user, 'finance-packaging-schemes', ex.id, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === undefined ? null : v])), 'Excel 导入更新');
              id = ex.id;
              summary.schemesUpdated++;
            } else {
              id = (await this.resources.createRecord(em, user, 'finance-packaging-schemes', values, 'Excel 导入')).id;
              summary.schemesCreated++;
            }
            if (['停用', 'inactive'].includes(t(r['状态']).toLowerCase())) await this.resources.setStatusChecked(em, user, 'finance-packaging-schemes', id, 'inactive', 'Excel 导入：停用');
            else if (ex && ex.status !== 'active') await this.resources.setStatusChecked(em, user, 'finance-packaging-schemes', id, 'active', 'Excel 导入：启用');
            saved.set(code, id);
          } catch (e) { err(S.schemes, row, '', e instanceof Error ? e.message : '保存失败'); }
        }

        const linesBy = new Map<string, number>();
        for (const [i, r] of rows.lines.entries()) {
          const row = i + 2;
          const code = t(r['方案编码']).toUpperCase();
          if (!code) { err(S.lines, row, '方案编码', '必填'); continue; }
          const sid = saved.get(code);
          if (!sid) { if (!seen.has(code)) err(S.lines, row, '方案编码', `「${code}」不在“${S.schemes}”表里`); continue; }
          const comp = prodByCode.get(t(r['包装档案编号']).toUpperCase());
          if (!t(r['包装档案编号'])) { err(S.lines, row, '包装档案编号', '必填'); continue; }
          if (!comp || !['package', 'oem_package'].includes(t(comp.data.archiveType))) { err(S.lines, row, '包装档案编号', `「${t(r['包装档案编号'])}」不存在或不是产品包装/OEM 包装档案`); continue; }
          const treat = t(r['计价处理']) ? TREAT[t(r['计价处理'])] : 'include';
          if (!treat) { err(S.lines, row, '计价处理', '只能是计入、已含上级、仅参考'); continue; }
          const bucket = t(r['成本归类']) ? BUCKET[t(r['成本归类'])] : undefined;
          if (t(r['成本归类']) && !bucket) { err(S.lines, row, '成本归类', '只能是发货前包装成本、发货包装成本'); continue; }
          const role = t(r['角色']) ? ROLE[t(r['角色'])] : 'package';
          if (!role) { err(S.lines, row, '角色', '只能是包装、标签、说明书、其他'); continue; }
          try {
            await this.resources.createRecord(em, user, 'finance-packaging-lines', {
              schemeId: sid, componentId: comp.id, role, qty: Number(t(r['数量'])), unitName: t(r['单位']) || undefined, lossRate: t(r['损耗率']) ? Number(t(r['损耗率'])) : undefined,
              costBucket: bucket, costTreatment: treat, sourceRowRef: t(r['来源行']) || undefined, sortOrder: t(r['排序']) ? Number(t(r['排序'])) : undefined, remark: t(r['备注']) || undefined,
            }, 'Excel 导入');
            summary.lines++;
            linesBy.set(code, (linesBy.get(code) ?? 0) + 1);
          } catch (e) { err(S.lines, row, '', e instanceof Error ? e.message : '保存失败'); }
        }

        for (const [i, r] of rows.rules.entries()) {
          const row = i + 2;
          const code = t(r['方案编码']).toUpperCase();
          if (!code) { err(S.rules, row, '方案编码', '必填'); continue; }
          const sid = saved.get(code);
          if (!sid) { if (!seen.has(code)) err(S.rules, row, '方案编码', `「${code}」不在“${S.schemes}”表里`); continue; }
          const type = t(r['目标类型']) ? TARGET[t(r['目标类型'])] : 'general';
          if (!type) { err(S.rules, row, '目标类型', '只能是通用、商品基础编码、商品组合编码、商品档案'); continue; }
          const before = errors.length;
          const values = {
            schemeId: sid, targetType: type, targetCode: t(r['目标编码']) || undefined,
            categoryId: pick(cats, t(r['商品分类']), '商品分类', S.rules, row, '商品分类', catPath), brandId: pick(brands, t(r['品牌']), '品牌', S.rules, row, '品牌'), scenarioId: pick(scenarios, t(r['销售场景']), '销售场景', S.rules, row, '销售场景'),
            minWeightKg: t(r['最小重量kg']) ? Number(t(r['最小重量kg'])) : undefined, maxWeightKg: t(r['最大重量kg']) ? Number(t(r['最大重量kg'])) : undefined, discreteWeights: t(r['离散重量kg']).replace(/[;；]/g, ',') || undefined,
            priority: t(r['优先级']) ? Number(t(r['优先级'])) : 100, remark: t(r['备注']) || undefined,
          };
          if (errors.length > before) continue;
          try {
            const rec = await this.resources.createRecord(em, user, 'finance-packaging-rules', values, 'Excel 导入');
            if (['停用', 'inactive'].includes(t(r['状态']).toLowerCase())) await this.resources.setStatusChecked(em, user, 'finance-packaging-rules', rec.id, 'inactive', 'Excel 导入：停用');
            summary.rules++;
          } catch (e) { err(S.rules, row, '', e instanceof Error ? e.message : '保存失败'); }
        }
        for (const [code, row] of seen) if (saved.has(code) && !linesBy.get(code)) warnings.push({ sheet: S.schemes, row, field: '方案编码', message: '这个方案没有物理包装明细，只有匹配规则或什么都没有' });
        if (dry || errors.length) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    return { errors, warnings, summary };
  }

  /** 导出：当前全部方案、明细、规则，列同导入模板（引用都写名称/编码） */
  async exportRows(user: AuthUser): Promise<Record<keyof PackagingSheetRows, string[][]>> {
    this.need(user, 'view');
    const em = this.dataSource.manager;
    const find = (type: string) => em.find(ResourceRecord, { where: { companyId: user.companyId, type }, order: { id: 'ASC' } });
    const [schemes, lines, rules, cats, brands, scenarios, products] = await Promise.all(['finance-packaging-schemes', 'finance-packaging-lines', 'finance-packaging-rules', 'finance-categories', 'finance-brands', 'finance-scenarios', 'finance-products'].map(find));
    const byId = (l: ResourceRecord[]) => new Map(l.map((r) => [r.id, r]));
    const catM = byId(cats);
    const path = (id: unknown) => { const out: string[] = []; for (let c = catM.get(Number(id)), i = 0; c && i < 6; i++) { out.unshift(c.title); c = catM.get(Number(c.data.parentId)); } return out.join(' / '); };
    const brandM = byId(brands), scenM = byId(scenarios), prodM = byId(products), schemeM = byId(schemes);
    const title = (m: Map<number, ResourceRecord>, id: unknown) => m.get(Number(id))?.title ?? '';
    const inv = (m: Record<string, string>, v: string) => Object.entries(m).find(([, x]) => x === v)?.[0] ?? v;
    const n = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    return {
      schemes: [[...PACKAGING_HEADERS.schemes], ...schemes.map((s) => [t(s.data.schemeCode), s.title, SCENE_LABEL[t(s.data.usageScene)] ?? t(s.data.usageScene), path(s.data.categoryId), title(brandM, s.data.brandId), n(s.data.effectiveFrom), n(s.data.effectiveTo), s.status === 'active' ? '启用' : '停用', n(s.data.sourceType), n(s.data.sourceRef), n(s.data.remark)])],
      lines: [[...PACKAGING_HEADERS.lines], ...lines.map((l) => [t(schemeM.get(Number(l.data.schemeId))?.data.schemeCode), t(prodM.get(Number(l.data.componentId))?.data.code), ({ package: '包装', label: '标签', instruction: '说明书', other: '其他' } as Record<string, string>)[t(l.data.role)] ?? t(l.data.role), n(l.data.qty), n(l.data.unitName), n(l.data.lossRate), ({ pre_ship_package: '发货前包装成本', shipping_package: '发货包装成本' } as Record<string, string>)[t(l.data.costBucket)] ?? '', ({ include: '计入', included_in_parent: '已含上级', reference_only: '仅参考' } as Record<string, string>)[t(l.data.costTreatment)] ?? '', n(l.data.sourceRowRef), n(l.data.sortOrder), n(l.data.remark)])],
      rules: [[...PACKAGING_HEADERS.rules], ...rules.map((r) => [t(schemeM.get(Number(r.data.schemeId))?.data.schemeCode), inv({ 通用: 'general', 商品基础编码: 'base_code', 商品组合编码: 'bundle', 商品档案: 'product_archive' }, t(r.data.targetType)), n(r.data.targetCode), path(r.data.categoryId), title(brandM, r.data.brandId), title(scenM, r.data.scenarioId), n(r.data.minWeightKg), n(r.data.maxWeightKg), n(r.data.discreteWeights), n(r.data.priority), r.status === 'active' ? '启用' : '停用', n(r.data.remark)])],
    };
  }
}
