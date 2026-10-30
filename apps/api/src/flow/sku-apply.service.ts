import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createChecker, normalizeSpecs, sumUnitCents, multiplyUnitCents, WAREHOUSE_ROLE_LABEL, type SkuSpec, type WarehouseSpec } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FlowRun, ResourceRecord } from '../entities';
import { BundleToolsService } from '../resources/bundle-tools.service';
import { FlowService } from './flow.service';
import { CreatedBundle, SKU_TEMPLATE, checkApplication, platformIdsOf } from './sku-apply';
import { randomBytes } from 'crypto';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export type SkuOptionKind = 'main' | 'gift' | 'package' | 'label' | 'other' | 'labor' | 'names';
const ARCHIVE_BY_KIND: Record<string, string[]> = {
  main: ['raw', 'purchased'], gift: ['raw', 'purchased', 'shipping_material'], package: ['package', 'oem_package'], label: ['shipping_material'], other: ['shipping_material'],
};

/** SKU 批量申请的辅助接口：给申请表单提供可选项（不要求有财务资料的查看权限），给详情页提供「会生成什么编码」的预览。 */
@Injectable()
export class SkuApplyService {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly flow: FlowService, private readonly bundles: BundleToolsService) {}

  /** 申请表单的下拉：销售场景、销售平台，以及按用途搜索商品（最多 30 条）。只返回编码、名称、规格，没有成本价格。 */
  async options(user: AuthUser, kind: SkuOptionKind | 'meta', keyword = '', ids = '') {
    const em = this.ds.manager;
    if (kind === 'meta') {
      const rows = async (type: string) => (await em.find(ResourceRecord, { where: { companyId: user.companyId, type }, order: { title: 'ASC' } })).filter((r) => r.status === 'active').map((r) => ({ id: r.id, name: r.title }));
      return { scenarios: await rows('finance-scenarios'), platforms: await rows('finance-platforms'), brands: await rows('finance-brands'), bundleCategories: await this.bundleCategoryLeaves(user.companyId) };
    }
    if (kind === 'names') {
      // 重新提交时按编号回填商品名称（只给编码、名称、规格）
      const list = [...new Set(ids.split(',').map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
      if (!list.length) return { items: [] };
      const rows = await em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.id IN (:...ids)', { c: user.companyId, t: 'finance-base-codes', ids: list }).getMany();
      return { items: rows.map((bc) => ({ id: bc.id, code: bc.title, name: str(bc.data.name), spec: str(bc.data.spec) })) };
    }
    const kw = keyword.trim().slice(0, 50);
    if (kind === 'labor') {
      const q = em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.status = :s', { c: user.companyId, t: 'finance-labor-costs', s: 'active' });
      if (kw) q.andWhere('r.searchText LIKE :kw', { kw: `%${kw}%` });
      return { items: (await q.orderBy('r.title', 'ASC').limit(30).getMany()).map((r) => ({ id: r.id, code: str(r.data.workCode), name: str(r.data.workName) || r.title })) };
    }
    if (!ARCHIVE_BY_KIND[kind]) throw new BadRequestException('不认识的选项类型');
    const q = em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.status = :s', { c: user.companyId, t: 'finance-base-codes', s: 'verified' });
    if (kw) q.andWhere('r.searchText LIKE :kw', { kw: `%${kw}%` });
    const out: { id: number; code: string; name: string; spec: string }[] = [];
    // 档案类型在商品档案上，先多取一些再按用途过滤
    const cands = await q.orderBy('r.title', 'ASC').limit(300).getMany();
    const prods = new Map<number, string>();
    for (const bc of cands) {
      if (out.length >= 30) break;
      const pid = Number(bc.data.productId);
      if (!prods.has(pid)) prods.set(pid, str((await em.findOne(ResourceRecord, { where: { id: pid, companyId: user.companyId, type: 'finance-products' }, select: ['id', 'data'] }))?.data.archiveType));
      if (ARCHIVE_BY_KIND[kind].includes(prods.get(pid)!)) out.push({ id: bc.id, code: bc.title, name: str(bc.data.name), spec: str(bc.data.spec) });
    }
    return { items: out };
  }

  /** 组合分类树里的最末级分类（带路径名），申请表单里必选一个 */
  private async bundleCategoryLeaves(companyId: number) {
    const all = (await this.ds.manager.find(ResourceRecord, { where: { companyId, type: 'finance-categories' } })).filter((r) => r.status === 'active' && r.data.archiveType === 'bundle');
    const byId = new Map(all.map((r) => [r.id, r]));
    const parents = new Set(all.map((r) => Number(r.data.parentId)).filter((n) => n > 0));
    const pathOf = (r: ResourceRecord): string => { const names: string[] = []; let cur: ResourceRecord | undefined = r; for (let i = 0; cur && i < 8; i += 1) { names.unshift(cur.title); cur = byId.get(Number(cur.data.parentId)); } return names.join(' / '); };
    return all.filter((r) => !parents.has(r.id)).map((r) => ({ id: r.id, name: pathOf(r) })).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  /** 这张申请会生成（或已经生成）哪些编码：每个规格 × 平台一行，带重复提示；成本只给有 product.cost.view 的人。 */
  async preview(user: AuthUser, runId: number) {
    await this.flow.detail(user, runId); // 只有能看这条流程的人才能看预览
    const em = this.ds.manager;
    const run = await em.findOne(FlowRun, { where: { id: runId, companyId: user.companyId } });
    if (!run) throw new NotFoundException('流程不存在');
    if (run.templateKey !== SKU_TEMPLATE) throw new BadRequestException('这不是 SKU 批量申请');
    const canCost = createChecker(user.permissions)('product.cost.view');
    const wh = (run.payload._warehouse as WarehouseSpec[] | undefined) ?? undefined;
    const created = (run.payload._created as CreatedBundle[] | undefined) ?? null;
    const specs = normalizeSpecs(run.payload.specs).specs;
    const label = async (type: string, id: number | null | undefined) => (id ? (await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type }, select: ['id', 'title'] }))?.title ?? '' : '');
    const platforms = await Promise.all(platformIdsOf(run.payload).map(async (id) => ({ id, name: await label('finance-platforms', id) })));
    const info = async (baseCodeId: number) => {
      const bc = await em.findOne(ResourceRecord, { where: { id: baseCodeId, companyId: user.companyId, type: 'finance-base-codes' } });
      return { code: bc?.title ?? '已删除', name: str(bc?.data.name), weightG: num(bc?.data.weightG), cost: canCost ? num(bc?.data.cost) : undefined };
    };
    let plan: Awaited<ReturnType<typeof checkApplication>>['plan'] | null = null;
    let planError = '';
    // 已完成的申请不再做检查（编码已经生成，再预览会显示成“已有”）
    if (run.status === 'running') {
      try { plan = (await checkApplication(em, user, this.bundles, { ...run.payload }, { strict: false, selfRunId: run.id, warehouse: wh })).plan; } catch (e) { planError = (e as Error).message; }
    }
    const rows = [];
    for (const [i, s] of specs.entries()) {
      const lineView = async (baseCodeId: number, qty: number, role: string) => ({ role, roleLabel: role === 'main' ? '主商品' : role === 'gift' ? '赠品' : WAREHOUSE_ROLE_LABEL[role as keyof typeof WAREHOUSE_ROLE_LABEL] ?? role, qty, ...(await info(baseCodeId)) });
      const lines = [...(await Promise.all(s.main.map((l) => lineView(l.baseCodeId, l.qty, 'main')))), ...(await Promise.all(s.gift.map((l) => lineView(l.baseCodeId, l.qty, 'gift'))))];
      const whLines = [];
      for (const l of wh?.[i]?.lines ?? []) {
        if (l.role === 'labor') {
          const rec = await em.findOne(ResourceRecord, { where: { id: l.laborId!, companyId: user.companyId, type: 'finance-labor-costs' } });
          whLines.push({ role: 'labor', roleLabel: '人工', qty: l.qty, code: str(rec?.data.workCode), name: str(rec?.data.workName) || rec?.title || '已删除', weightG: null, cost: canCost ? (num(rec?.data.unitPrice) ?? 0) : undefined });
        } else whLines.push(await lineView(l.baseCodeId!, l.qty, l.role));
      }
      const all = [...lines, ...whLines];
      const totalCost = canCost ? sumUnitCents(all.map((l) => multiplyUnitCents(l.cost ?? 0, l.qty))) : undefined;
      const weightG = Math.round(all.reduce((sum, l) => sum + (l.weightG ?? 0) * l.qty, 0) * 1e6) / 1e6;
      rows.push({
        name: s.name, note: s.note ?? '', reuseReason: s.reuseReason ?? '', lines, warehouse: whLines, notRequired: wh?.[i]?.notRequired ?? {}, weightG, totalCost,
        targets: plan ? plan[i].targets : [], created: created ? created.filter((c) => c.spec === s.name) : [],
      });
    }
    return {
      batch: run.payload._batchKey ? { key: str(run.payload._batchKey), index: num(run.payload._splitIndex), total: num(run.payload._splitTotal) } : null,
      runId, status: run.status, batchName: str(run.payload.batchName), scenario: await label('finance-scenarios', num(run.payload.scenarioId)), platforms,
      warehouseDone: !!wh, canCost, planError, specs: rows, costNote: '物料成本含人工，不含运费',
    };
  }

  /**
   * 复用历史仓库配置（旧系统“复用仓库配置”）：按主商品找以前办过的申请里，同样主商品的规格填过的包装、标签、打包材料、人工。
   * 只返回配置本身和商品名称，不带成本；用的时候由办理人逐项核对，提交时仍按现在的规则完整校验。
   */
  async historyConfigs(user: AuthUser, mainIds: number[], keyword = '') {
    const em = this.ds.manager;
    const want = new Set(mainIds);
    const kw = keyword.trim().toLowerCase().slice(0, 50);
    const runs = await em.find(FlowRun, { where: { companyId: user.companyId, templateKey: SKU_TEMPLATE }, order: { id: 'DESC' }, take: 300 });
    const hits: Array<{ runId: number; title: string; specName: string; main: Array<{ baseCodeId: number; qty: number }>; config: WarehouseSpec; score: number; status: string }> = [];
    for (const r of runs) {
      const wh = r.payload._warehouse as WarehouseSpec[] | undefined;
      if (!Array.isArray(wh)) continue;
      const specs: SkuSpec[] = normalizeSpecs(r.payload.specs).specs;
      specs.forEach((sp, i) => {
        const cfg = wh[i];
        if (!cfg || (!cfg.lines.length && !Object.keys(cfg.notRequired ?? {}).length)) return;
        const ids = sp.main.map((l) => l.baseCodeId);
        const same = want.size > 0 && ids.length === want.size && ids.every((x) => want.has(x));
        const overlap = ids.some((x) => want.has(x));
        if (want.size > 0 && !overlap) return;
        if (kw && !`${sp.name} ${str(r.payload.batchName)}`.toLowerCase().includes(kw)) return;
        hits.push({ runId: r.id, title: r.title, specName: sp.name, main: sp.main, config: cfg, score: same ? 2 : overlap ? 1 : 0, status: r.status });
      });
    }
    hits.sort((a, b) => b.score - a.score || b.runId - a.runId);
    const top = hits.slice(0, 20);
    const baseIds = [...new Set(top.flatMap((h) => [...h.main.map((m) => m.baseCodeId), ...h.config.lines.filter((l) => l.role !== 'labor').map((l) => l.baseCodeId!)]))];
    const laborIds = [...new Set(top.flatMap((h) => h.config.lines.filter((l) => l.role === 'labor').map((l) => l.laborId!)))];
    const find = async (type: string, ids: number[]) => (ids.length ? em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :c AND r.type = :t AND r.id IN (:...ids)', { c: user.companyId, t: type, ids }).getMany() : []);
    const names: Record<string, string> = {};
    for (const b of await find('finance-base-codes', baseIds)) names[`b${b.id}`] = `${b.title} ${str(b.data.name)}`.trim();
    for (const l of await find('finance-labor-costs', laborIds)) names[`l${l.id}`] = `${str(l.data.workCode)} ${str(l.data.workName) || l.title}`.trim();
    return { items: top.map(({ score, ...h }) => ({ ...h, exact: score === 2 })), names };
  }

  /** 每个规格独立办理：一次填完，拆成一个规格一条流程（各自走仓库、财务），同一批用 batchKey 关联；先整体检查，再逐条发起 */
  async startSplit(user: AuthUser, payloadIn: Record<string, unknown>, requestKey: string) {
    const payload = { ...payloadIn };
    delete payload.splitSpecs;
    const specs = normalizeSpecs(payload.specs).specs;
    if (specs.length < 2) throw new BadRequestException('只有一个规格不用拆开办理，直接发起即可');
    if (specs.length > 100) throw new BadRequestException('一次最多 100 个规格');
    // 整体检查一遍（和不拆开时一样的规则）：有问题就整体不发起，免得发起了一半
    await checkApplication(this.ds.manager, user, this.bundles, { ...payload }, { strict: true });
    const batchKey = `B${Date.now().toString(36)}${randomBytes(3).toString('hex')}`.slice(0, 20);
    const runs: Array<{ id: number; specName: string }> = [];
    const failed: Array<{ specName: string; message: string }> = [];
    for (const [i, spec] of specs.entries()) {
      try {
        const run = await this.flow.start(user, SKU_TEMPLATE, { ...payload, specs: [spec] }, `${requestKey}-${i}`.slice(0, 80));
        // 引擎只保存模板里声明的字段；批次标记是业务痕迹（下划线开头，页面上不显示），发起后补写
        await this.ds.query("UPDATE flow_runs SET payload = JSON_SET(payload, '$._batchKey', ?, '$._splitIndex', ?, '$._splitTotal', ?) WHERE id = ? AND company_id = ?", [batchKey, i + 1, specs.length, run.id, user.companyId]);
        runs.push({ id: run.id, specName: spec.name });
      } catch (e) { failed.push({ specName: spec.name, message: (e as Error).message }); }
    }
    return { batchKey, runs, failed };
  }

  /** 同一批拆开办理的申请：每个规格现在到哪一步了（只列你能看到的） */
  async batch(user: AuthUser, batchKey: string) {
    const em = this.ds.manager;
    const runs = await em.createQueryBuilder(FlowRun, 'r')
      .where('r.companyId = :c AND r.templateKey = :t AND JSON_UNQUOTE(JSON_EXTRACT(r.payload, :p)) = :k', { c: user.companyId, t: SKU_TEMPLATE, p: '$._batchKey', k: batchKey })
      .orderBy('r.id', 'ASC').limit(100).getMany();
    const out = [];
    for (const r of runs) {
      try {
        const d = await this.flow.detail(user, r.id);
        const spec = normalizeSpecs(r.payload.specs).specs[0];
        out.push({ id: r.id, specName: spec?.name ?? '', status: r.status, currentStep: d.activeStep?.name ?? '' });
      } catch { /* 看不到的不列 */ }
    }
    return { batchKey, total: runs.length, items: out };
  }
}
