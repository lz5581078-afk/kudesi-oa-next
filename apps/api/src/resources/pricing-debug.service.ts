import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createChecker, customProfitQuote, roiQuote, roundUpYuanCents, sliderQuote, stepToMarkupPercent, type RoiMode, type SliderQuote } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { CostRow, CostService } from './cost.service';
import { buildXlsx } from './xlsx-lite';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface ProfitInput { id: number; amountCents: number }
export interface TrialInput { id: number; step: number; profit?: ProfitInput }
export interface ExportInput extends TrialInput {
  mode: RoiMode | 'sliderPrice'; value?: number; sellingPriceCents?: number; roi?: number; sliderPriceCents?: number;
}

/** 参与调试的组合：已验证（含“需重新验证”，旧系统里它们的成本登记还在）的组合 */
const PRICEABLE = new Set(['verified', 'reverify']);

/**
 * 定价调试表：从成本表选组合，按公司低价调预留利润、联动投产和售价，导出 Excel。
 * 全程只试算，不保存任何东西。看得到成本的人（product.cost.view）精确到分、能看到成本和比例；
 * 其他人（运营）看到的是整元，看不到发货前成本和比例。
 */
@Injectable()
export class PricingDebugService {
  constructor(private readonly cost: CostService) {}

  private viewer(user: AuthUser) { return createChecker(user.permissions)('product.cost.view'); }

  private async rows(user: AuthUser) {
    const { d, rows } = await this.cost.allRows(user);
    return { d, rows: rows.filter((r) => PRICEABLE.has(r.status)) };
  }

  /** 某分类及其所有下级分类的编号 */
  private descendants(d: Awaited<ReturnType<CostService['load']>>, categoryId: number): Set<number> {
    const out = new Set<number>([categoryId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const c of d.categories.values()) {
        const pid = num(c.data.parentId);
        if (pid && out.has(pid) && !out.has(c.id)) { out.add(c.id); grew = true; }
      }
    }
    return out;
  }

  private publicRow(r: CostRow, costViewer: boolean) {
    return {
      id: r.bundleId, skuCode: r.code, skuName: r.name, categoryId: r.categoryId, categoryName: r.categoryName || '未分类',
      ready: r.minPriceCents !== null, weightG: r.weightG, minPriceCents: r.minPriceCents,
      ...(costViewer ? { preShipCostCents: r.preShipCostCents } : {}),
    };
  }

  /** 挑选商品用的目录：分类树 + 基础编码（可按分类、关键字找） */
  async components(user: AuthUser, q: { categoryId?: number; keyword?: string; page: number }) {
    const d = await this.cost.load(user.companyId);
    const pageSize = 30;
    const ids = q.categoryId ? this.descendants(d, q.categoryId) : null;
    const kw = (q.keyword ?? '').trim().toLowerCase();
    const list = [...d.baseCodes.values()]
      .filter((b) => b.status !== 'disabled')
      .filter((b) => !ids || ids.has(num(b.data.categoryId) ?? -1))
      .filter((b) => !kw || `${str(b.data.code)} ${str(b.data.name)} ${b.title}`.toLowerCase().includes(kw))
      .sort((a, b) => (str(a.data.name) || a.title).localeCompare(str(b.data.name) || b.title, 'zh-CN') || a.id - b.id);
    return {
      categories: [...d.categories.values()].filter((c) => c.status === 'active').map((c) => ({ id: c.id, name: c.title, parentId: num(c.data.parentId) })),
      rows: list.slice((q.page - 1) * pageSize, q.page * pageSize).map((b) => ({ id: b.id, code: str(b.data.code), name: str(b.data.name) || b.title, categoryId: num(b.data.categoryId) })),
      total: list.length, page: q.page, pageSize,
    };
  }

  async list(user: AuthUser, q: { keyword?: string; categoryId?: number; baseCodeId?: number; page: number; pageSize: number }) {
    const costViewer = this.viewer(user);
    const { d, rows } = await this.rows(user);
    const kw = (q.keyword ?? '').trim().toLowerCase();
    const cats = q.categoryId ? this.descendants(d, q.categoryId) : null;
    // 组合里用到了所选基础编码（或所选分类下的基础编码）
    const used = (bundleId: number) => d.lines.some((l) => {
      if (num(l.data.bundleId) !== bundleId) return false;
      const bcId = num(l.data.baseCodeId);
      if (bcId === null || str(l.data.role) === 'labor') return false;
      if (q.baseCodeId && bcId !== q.baseCodeId) return false;
      if (cats && !cats.has(num(d.baseCodes.get(bcId)?.data.categoryId) ?? -1)) return false;
      return true;
    });
    const w = (r: CostRow) => (r.weightG !== null && r.weightG > 0 ? r.weightG : Infinity);
    const found = rows
      .filter((r) => !kw || `${r.code} ${r.name}`.toLowerCase().includes(kw))
      .filter((r) => (!q.categoryId && !q.baseCodeId) || used(r.bundleId))
      // 按计费重量由轻到重；没有重量的排最后
      .sort((a, b) => (w(a) === w(b) ? 0 : w(a) < w(b) ? -1 : 1) || a.name.localeCompare(b.name, 'zh-CN') || a.bundleId - b.bundleId);
    return {
      rows: found.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((r) => this.publicRow(r, costViewer)),
      total: found.length, page: q.page, pageSize: q.pageSize, canViewInternals: costViewer,
    };
  }

  // ---------- 单个商品的试算 ----------

  private fail(e: unknown): never {
    if (e instanceof RangeError) throw new BadRequestException(e.message);
    throw e;
  }

  /** 预留利润：手填金额（按来源商品的比例换算）优先，否则按档位 */
  private slider(byId: Map<number, CostRow>, costViewer: boolean, input: TrialInput): SliderQuote {
    const row = byId.get(input.id);
    if (!row) throw new ConflictException('所选项目已变化，请刷新后重选');
    const floor = row.minPriceCents;
    if (!input.profit) {
      if (stepToMarkupPercent(input.step) === null) throw new BadRequestException('预留利润档位无效');
      return sliderQuote(floor, input.step, costViewer);
    }
    const src = byId.get(input.profit.id);
    if (!src) throw new ConflictException('利润来源商品已变化，请重新选择');
    if (src.minPriceCents === null || src.minPriceCents <= 0) throw new ConflictException('利润来源商品暂无可用价格');
    const sourceBaseCents = costViewer ? src.minPriceCents : roundUpYuanCents(src.minPriceCents);
    try { return customProfitQuote(floor, costViewer, { sourceBaseCents, amountCents: input.profit.amountCents }); } catch (e) { return this.fail(e); }
  }

  async sliderPrice(user: AuthUser, input: TrialInput) {
    const costViewer = this.viewer(user);
    const { rows } = await this.rows(user);
    return this.slider(new Map(rows.map((r) => [r.bundleId, r])), costViewer, input);
  }

  async quote(user: AuthUser, mode: RoiMode, inputs: Array<TrialInput & { value: number }>) {
    const costViewer = this.viewer(user);
    const ids = inputs.map((i) => i.id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('试算商品重复');
    const { rows } = await this.rows(user);
    const byId = new Map(rows.map((r) => [r.bundleId, r]));
    if (ids.some((id) => !byId.has(id))) throw new ConflictException('所选项目已变化，请刷新后重选');
    return {
      rows: inputs.map((input) => {
        const row = byId.get(input.id)!;
        if (row.minPriceCents === null) return { id: input.id, available: false, message: '缺少有效运费或利润率，暂不能试算' };
        const target = this.slider(byId, costViewer, input).priceCents!;
        let q;
        try { q = roiQuote(mode, input.value, target); } catch (e) { return this.fail(e); }
        return { id: input.id, ...q, ...(costViewer ? { minPriceCents: row.minPriceCents } : {}) };
      }),
    };
  }

  /**
   * 导出 Excel。页面上看到的试算结果（预留利润后售价、试算售价、投产）要和服务端此刻重算的一致，
   * 不一致（成本、运费、利润率在页面打开后变过）就拒绝，请重新试算。
   */
  async exportXlsx(user: AuthUser, inputs: ExportInput[]) {
    const costViewer = this.viewer(user);
    const ids = inputs.map((i) => i.id);
    if (!inputs.length || inputs.length > 10000 || new Set(ids).size !== ids.length) throw new BadRequestException('请选择已完成试算的商品，单次导出最多 10000 项');
    const { rows } = await this.rows(user);
    const byId = new Map(rows.map((r) => [r.bundleId, r]));
    if (ids.some((id) => !byId.has(id))) throw new ConflictException('所选项目已变化，请刷新后重新试算');
    const out: Array<Array<string | number | null>> = [];
    for (const input of inputs) {
      const row = byId.get(input.id)!;
      if (row.minPriceCents === null) throw new ConflictException('商品资料已变化，请重新试算后导出');
      const slider = this.slider(byId, costViewer, input);
      if ((input.mode === 'sliderPrice' || input.sliderPriceCents !== undefined) && (!slider.available || input.sliderPriceCents !== slider.priceCents)) {
        throw new ConflictException('预留利润后售价已变化，请重新调试后导出');
      }
      let quote: { priceCents?: number; roi?: number } = {};
      if (input.mode !== 'sliderPrice') {
        let q;
        try { q = roiQuote(input.mode, input.value ?? NaN, slider.priceCents!); } catch (e) { return this.fail(e); }
        if (q.available === false || input.sellingPriceCents !== q.priceCents || input.roi !== q.roi) throw new ConflictException('试算结果已变化，请重新试算后导出');
        quote = q;
      }
      const yuan = (c: number | null | undefined) => (c === null || c === undefined ? null : c / 100);
      const markupPct = input.profit ? null : stepToMarkupPercent(input.step);
      out.push([
        row.name, row.code, row.categoryName || '未分类',
        slider.available ? yuan(slider.reservedProfitCents) : null, slider.available ? yuan(slider.priceCents) : null,
        yuan(quote.priceCents), quote.roi ?? null,
        ...(costViewer ? [input.profit ? (input.profit.amountCents / Math.max(1, byId.get(input.profit.id)!.minPriceCents ?? 1)) : markupPct === null ? null : markupPct / 100] : []),
        yuan(row.minPriceCents),
      ]);
    }
    const buffer = buildXlsx('定价调试结果', [
      { header: '商品名称', width: 42 }, { header: 'SKU编码', width: 32 }, { header: '组合分类', width: 26 },
      { header: '预留利润', width: 18, format: 'money' }, { header: '预留利润后售价', width: 22, format: 'money' }, { header: '最终试算售价', width: 20, format: 'money' }, { header: '目标投产', width: 16, format: 'money' },
      ...(costViewer ? [{ header: '预留利润比例', width: 20, format: 'percent' as const }] : []),
      { header: '公司低价', width: 18, format: 'money' },
    ], out);
    return { fileName: `定价调试结果-${new Date().toISOString().slice(0, 10)}.xlsx`, fileBase64: buffer.toString('base64'), rowCount: out.length };
  }
}
