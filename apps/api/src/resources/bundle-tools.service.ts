import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { OutboxService } from '../outbox/outbox.service';
import { COST_FIELDS, sigOf } from './base-code-support';
import { composeBundle } from './bundle-naming';
import { pickLine } from './bundle-checks';
import { buildBundleLines, bundleSnapshotJson, findNamingRule, namingInputFor } from './finance-rules';
import { ResourcesService } from './resources.service';

const TYPE = 'finance-bundles';
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface LineInput { role: string; baseCodeId?: number; laborId?: number; qty: number; unit?: string; lossRate?: number; isRequired?: boolean; includeInJst?: boolean; costBucket?: string; costTreatment?: string; note?: string }
export interface TargetInput { platformId: number; scenarioId: number; configNo?: string; bundleCategoryId?: number; brandId?: number }
interface SnapLine { role: string; ref: string; qty: number; weightG: number | null; cost: number | null }
interface BundleSnap { profile: Record<string, string>; lines: SnapLine[] }

const lineKey = (l: LineInput) => `${l.role}:${l.role === 'labor' ? `L${l.laborId}` : l.baseCodeId}:${l.qty}`;

/** 商品组合编码页面用的辅助接口：批量生成、重复检查、核对验证、构成修订、删除/归档。 */
@Injectable()
export class BundleToolsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly resources: ResourcesService,
    private readonly outbox: OutboxService,
  ) {}

  private canCost(user: AuthUser) { return createChecker(user.permissions)('product.cost.view'); }

  private async load(em: EntityManager, user: AuthUser, id: number) {
    const b = await em.findOne(ResourceRecord, { where: { id, companyId: user.companyId, type: TYPE } });
    if (!b) throw new NotFoundException('组合不存在');
    return b;
  }

  private async lineRecords(em: EntityManager, user: AuthUser, bundleId: number) {
    return (await this.resources.findWhere(em, user.companyId, 'finance-bundle-lines', 'bundleId', bundleId)).sort((a, b) => a.id - b.id);
  }

  /** 各状态的数量（页面的状态页签用） */
  async overview(user: AuthUser) {
    const rows = await this.ds.manager.find(ResourceRecord, { where: { companyId: user.companyId, type: TYPE }, select: ['id', 'status'] });
    const status: Record<string, number> = {};
    for (const r of rows) status[r.status] = (status[r.status] ?? 0) + 1;
    return { status };
  }

  private async resolveLines(em: EntityManager, user: AuthUser, lines: LineInput[]) {
    if (!lines.length) throw new BadRequestException('请先添加组合构成');
    const mains: { bc: ResourceRecord; qty: number }[] = [];
    const gifts: { bc: ResourceRecord; qty: number }[] = [];
    for (const l of lines) {
      if (!(l.qty > 0)) throw new BadRequestException('数量必须大于 0');
      if (l.role === 'labor') continue;
      const bc = await em.findOne(ResourceRecord, { where: { id: Number(l.baseCodeId), companyId: user.companyId, type: 'finance-base-codes' } });
      if (!bc) throw new BadRequestException('构成里有基础编码不存在');
      if (bc.status !== 'verified') throw new BadRequestException(`基础编码「${bc.title}」还没验证，验证通过后才能加入组合`);
      if (l.role === 'main') mains.push({ bc, qty: l.qty });
      if (l.role === 'gift') gifts.push({ bc, qty: l.qty });
    }
    if (!mains.length) throw new BadRequestException('至少要有一个主品');
    return { mains, gifts };
  }

  /**
   * 保存前检查：每个“平台 + 场景”算出编码和名称，并做重复检查。
   * 同一构成、同平台同场景已有的组合直接复用；编码撞上本地组合、本地基础编码、聚水潭普通商品、聚水潭组合装任何一层都算重复。
   */
  async preview(user: AuthUser, lines: LineInput[], targets: TargetInput[], em: EntityManager = this.ds.manager) {
    if (!targets.length) throw new BadRequestException('请至少选一个销售平台和销售场景');
    const seen = new Set<string>();
    for (const t of targets) {
      const k = `${t.platformId}:${t.scenarioId}:${t.configNo || '01'}`;
      if (seen.has(k)) throw new BadRequestException('同一个销售平台和销售场景不能重复选');
      seen.add(k);
    }
    const { mains, gifts } = await this.resolveLines(em, user, lines);
    const rule = await findNamingRule(this.resources, em, user.companyId, (await em.findOne(ResourceRecord, { where: { id: Number(mains[0].bc.data.productId), companyId: user.companyId, type: 'finance-products' } }))?.data.categoryId);
    const mySig = sigOf(...lines.map(lineKey).sort());
    const allBundles = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: TYPE } });
    const allLines = await em.find(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-bundle-lines' } });
    const linesOf = new Map<number, LineInput[]>();
    for (const l of allLines) {
      const arr = linesOf.get(Number(l.data.bundleId)) ?? [];
      arr.push({ role: str(l.data.role), baseCodeId: num(l.data.baseCodeId) ?? undefined, laborId: num(l.data.laborId) ?? undefined, qty: Number(l.data.qty) });
      linesOf.set(Number(l.data.bundleId), arr);
    }
    const out = [];
    for (const t of targets) {
      const platform = await em.findOne(ResourceRecord, { where: { id: t.platformId, companyId: user.companyId, type: 'finance-platforms' } });
      const scenario = await em.findOne(ResourceRecord, { where: { id: t.scenarioId, companyId: user.companyId, type: 'finance-scenarios' } });
      if (!platform || !scenario) throw new BadRequestException('销售平台或销售场景不存在');
      const configNo = t.configNo || '01';
      const composed = composeBundle(rule, await namingInputFor(em, user.companyId, mains, gifts, platform, scenario, configNo, t.brandId));
      const reuse = allBundles.find((b) => b.status !== 'archived' && b.data.platformId === platform.id && b.data.scenarioId === scenario.id && str(b.data.configNo || '01') === configNo
        && sigOf(...(linesOf.get(b.id) ?? []).map(lineKey).sort()) === mySig);
      const layers: { layer: string; label: string; hit: string }[] = [];
      if (!reuse) {
        const key = composed.code.toLowerCase();
        const byCode = async (type: string) => em.findOne(ResourceRecord, { where: { companyId: user.companyId, type, uniqueKey: key } });
        const b = await byCode(TYPE);
        if (b) layers.push({ layer: 'bundle', label: '本地组合编码', hit: b.title });
        const bc = await byCode('finance-base-codes');
        if (bc) layers.push({ layer: 'baseCode', label: '本地基础编码', hit: bc.title });
        const jst = await byCode('finance-jst-skus');
        if (jst) layers.push(jst.data.goodsType === 'combine' ? { layer: 'jstCombine', label: '聚水潭组合装', hit: jst.title } : { layer: 'jstNormal', label: '聚水潭普通商品', hit: jst.title });
      }
      out.push({
        platformId: platform.id, platformName: platform.title, scenarioId: scenario.id, scenarioName: scenario.title, configNo,
        code: composed.code, name: composed.name, styleCode: composed.styleCode, shortName: composed.shortName,
        reuse: reuse ? { id: reuse.id, code: str(reuse.data.code), status: reuse.status } : null,
        duplicates: layers,
        errors: composed.errors,
        ok: (!!reuse || layers.length === 0) && composed.errors.length === 0,
      });
    }
    return { targets: out, namingRule: !!rule };
  }

  /** 一次生成多个平台的组合：全部通过检查才保存，保存在同一个事务里，要么全成要么全不成。已有同构成同平台的直接复用。 */
  async generate(user: AuthUser, lines: LineInput[], targets: TargetInput[], outer?: EntityManager) {
    // 传入 outer 表示已经在别人的事务里（如流程引擎），和它同成同败；不传则自己开事务
    const run = <T>(fn: (em: EntityManager) => Promise<T>) => (outer ? fn(outer) : this.ds.transaction(fn));
    return run(async (em) => {
      const pre = await this.preview(user, lines, targets, em);
      const bad = pre.targets.find((t) => !t.ok);
      if (bad?.errors.length) throw new BadRequestException(bad.errors.join('；'));
      if (bad) throw new ConflictException(`「${bad.code}」重复：${bad.duplicates.map((d) => `${d.label}「${d.hit}」`).join('、')}`);
      const created: { id: number; code: string; reused: boolean }[] = [];
      for (const t of pre.targets) {
        if (t.reuse) { created.push({ id: t.reuse.id, code: t.reuse.code, reused: true }); continue; }
        const b = await this.resources.createRecord(em, user, TYPE, { platformId: t.platformId, scenarioId: t.scenarioId, configNo: t.configNo, bundleCategoryId: targets.find((x) => x.platformId === t.platformId && x.scenarioId === t.scenarioId)?.bundleCategoryId, brandId: targets.find((x) => x.platformId === t.platformId && x.scenarioId === t.scenarioId)?.brandId }, '批量生成组合');
        await buildBundleLines(this.resources as never, em, user, b.id, async () => {
          for (const l of lines) await this.resources.createRecord(em, user, 'finance-bundle-lines', { bundleId: b.id, ...pickLine(l as never), sortOrder: undefined }, '批量生成组合');
        });
        const fresh = await this.load(em, user, b.id);
        created.push({ id: b.id, code: str(fresh.data.code), reused: false });
      }
      return { created };
    });
  }

  // ---------- 构成修订 ----------

  async createRevision(user: AuthUser, bundleId: number, reason: string, lines: LineInput[]) {
    if (await this.pendingJobs(user, bundleId)) throw new ConflictException('这个组合还有没发送完的聚水潭同步任务，请等它发完再改构成');
    return this.ds.transaction(async (em) => {
      await this.load(em, user, bundleId);
      const r = await this.resources.createRecord(em, user, 'finance-bundle-revisions', { bundleId, reason, payload: JSON.stringify(lines) }, '提交构成修订');
      return { id: r.id };
    });
  }

  async cancelRevision(user: AuthUser, bundleId: number, reason: string) {
    if (reason.trim().length < 2) throw new BadRequestException('取消修订必须写明原因');
    const b = await this.load(this.ds.manager, user, bundleId);
    const id = num(b.data.pendingRevisionId);
    if (!id) throw new BadRequestException('这个组合没有待发布的修订');
    await this.resources.changeStatus(user, 'finance-bundle-revisions', id, 'cancelled', reason.trim());
    return { ok: true };
  }

  // ---------- 核对与验证 ----------

  private async currentLines(em: EntityManager, user: AuthUser, b: ResourceRecord): Promise<{ lines: LineInput[]; revision: ResourceRecord | null }> {
    const revId = num(b.data.pendingRevisionId);
    const revision = revId ? await em.findOne(ResourceRecord, { where: { id: revId, companyId: user.companyId, type: 'finance-bundle-revisions' } }) : null;
    if (revision && revision.status === 'pending') return { lines: JSON.parse(str(revision.data.payload)) as LineInput[], revision };
    const lines = (await this.lineRecords(em, user, b.id)).map((l) => ({ role: str(l.data.role), baseCodeId: num(l.data.baseCodeId) ?? undefined, laborId: num(l.data.laborId) ?? undefined, qty: Number(l.data.qty) }));
    return { lines, revision: null };
  }

  async report(user: AuthUser, id: number) {
    const em = this.ds.manager;
    const b = await this.load(em, user, id);
    const cost = this.canCost(user);
    const { lines, revision } = await this.currentLines(em, user, b);
    const issues: string[] = [];
    if (!lines.some((l) => l.role === 'main')) issues.push('还没有主品');
    const components = [];
    let totalWeight = 0, totalCost = 0;
    for (const l of lines) {
      if (l.role === 'labor') {
        const lab = await em.findOne(ResourceRecord, { where: { id: Number(l.laborId), companyId: user.companyId, type: 'finance-labor-costs' } });
        components.push({ role: l.role, code: '', name: lab?.title ?? '已删除的人工项目', qty: l.qty, weightG: null, cost: null });
        continue;
      }
      const bc = await em.findOne(ResourceRecord, { where: { id: Number(l.baseCodeId), companyId: user.companyId, type: 'finance-base-codes' } });
      if (!bc) { issues.push('构成里有基础编码已被删除'); continue; }
      if (bc.status !== 'verified') issues.push(`基础编码「${bc.title}」还没验证`);
      const w = num(bc.data.weightG), c = num(bc.data.cost);
      totalWeight += (w ?? 0) * l.qty;
      totalCost += (c ?? 0) * l.qty;
      components.push({ role: l.role, code: str(bc.data.code), name: str(bc.data.name) || bc.title, qty: l.qty, weightG: w, cost: cost ? c : undefined });
    }
    const snapJson = await bundleSnapshotJson(em, user.companyId, b.data, lines as never);
    const stored = this.parse(b.data.snapshot);
    const now = JSON.parse(snapJson) as BundleSnap;
    let changes = stored ? this.diff(stored, now) : [];
    if (!cost) changes = changes.filter((c) => !COST_FIELDS.has(c.field));
    const uploaded = str(b.data.jstUploadedCode);
    const outbound = { sku_id: str(b.data.code), i_id: str(b.data.styleCode), name: str(b.data.name), short_name: str(b.data.shortName), weight: Math.round(totalWeight) / 1000, cost_price: cost ? totalCost / 100 : undefined };
    return {
      id: b.id, code: str(b.data.code), name: str(b.data.name), styleCode: str(b.data.styleCode), shortName: str(b.data.shortName), status: b.status,
      components, totalWeightG: Math.round(totalWeight * 100) / 100, totalCost: cost ? totalCost : undefined,
      pendingRevision: revision ? { id: revision.id, reason: str(revision.data.reason) } : null,
      signature: sigOf(snapJson, b.status),
      issues, secondVerification: b.status === 'reverify', baselineMissing: b.status === 'reverify' && !stored, changes,
      outbound, uploadSignature: sigOf(JSON.stringify({ ...outbound, cost_price: undefined, lines: lines.map(lineKey).sort() })),
      uploadedCode: uploaded || null, replacing: !!uploaded && uploaded !== str(b.data.code), jstStatus: str(b.data.jstStatus) || 'not_synced',
    };
  }

  private parse(text: unknown): BundleSnap | null {
    if (typeof text !== 'string' || !text) return null;
    try { const s = JSON.parse(text) as BundleSnap; return s && Array.isArray(s.lines) ? s : null; } catch { return null; }
  }

  private diff(before: BundleSnap, after: BundleSnap) {
    const out: { source: string; field: string; label: string; before: unknown; after: unknown }[] = [];
    const push = (source: string, field: string, label: string, b: unknown, a: unknown) => { if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)) out.push({ source, field, label, before: b ?? null, after: a ?? null }); };
    const labels: Record<string, string> = { code: '组合编码', name: '组合名称', styleCode: '款式编码', shortName: '简称' };
    for (const k of Object.keys(labels)) push('组合', k, labels[k], before.profile[k], after.profile[k]);
    const key = (l: SnapLine) => `${l.role}|${l.ref}`;
    const was = new Map(before.lines.map((l) => [key(l), l]));
    const now = new Map(after.lines.map((l) => [key(l), l]));
    for (const [k, a] of now) {
      const b = was.get(k);
      if (!b) { out.push({ source: a.ref, field: 'line', label: '新增的构成', before: null, after: `${a.ref} ×${a.qty}` }); continue; }
      push(a.ref, 'qty', '数量', b.qty, a.qty);
      push(a.ref, 'weightG', '重量(克)', b.weightG, a.weightG);
      push(a.ref, 'cost', '成本', b.cost, a.cost);
    }
    for (const [k, b] of was) if (!now.has(k)) out.push({ source: b.ref, field: 'line', label: '去掉的构成', before: `${b.ref} ×${b.qty}`, after: null });
    return out;
  }

  async verify(user: AuthUser, items: { id: number; signature: string; uploadSignature?: string }[], opts: { confirmed: boolean; syncToJst: boolean; replaceConfirmed?: boolean }) {
    if (!opts.confirmed) throw new BadRequestException('请先勾选“已核对”');
    if (!items.length) throw new BadRequestException('没有要验证的组合');
    if (opts.syncToJst && !user.permissions.isCompanyAdmin) throw new ForbiddenException('只有公司管理员能把验证结果同步到聚水潭');
    const results: { id: number; ok: boolean; error?: string; queued?: boolean }[] = [];
    for (const it of items) {
      try {
        const rep = await this.report(user, it.id);
        if (!['pending', 'reverify'].includes(rep.status)) throw new BadRequestException('这条已经验证过了');
        if (rep.signature !== it.signature) throw new ConflictException('核对之后资料又变了，请重新核对');
        if (rep.issues.length) throw new BadRequestException(rep.issues[0]);
        if (opts.syncToJst && rep.uploadSignature !== it.uploadSignature) throw new ConflictException('要上传的内容在核对之后变了，请重新核对');
        await this.resources.changeStatus(user, TYPE, it.id, 'verified');
        let queued = false;
        if (opts.syncToJst) queued = (await this.outbox.enqueue(user, TYPE, [it.id], { replaceConfirmed: opts.replaceConfirmed })).queued > 0;
        results.push({ id: it.id, ok: true, queued });
      } catch (e) { results.push({ id: it.id, ok: false, error: (e as Error).message }); }
    }
    return { results, verified: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }

  // ---------- 删除与归档 ----------

  private async deletable(em: EntityManager, user: AuthUser, b: ResourceRecord) {
    if (b.data.verifiedAt || b.data.snapshot || b.data.jstUploadedCode || ['synced', 'pending', 'failed'].includes(str(b.data.jstStatus)) || ['verified', 'reverify', 'archived'].includes(b.status)) return '验证过或同步过聚水潭的组合不能直接删除，请改为“失效归档”';
    const [{ n }] = await em.query('SELECT COUNT(*) AS n FROM finance_cost_snapshots WHERE company_id = ? AND bundle_id = ?', [user.companyId, b.id]);
    if (Number(n) > 0) return '这个组合已有成本历史记录，不能直接删除，请改为“失效归档”';
    return '';
  }

  async deletionPreview(user: AuthUser, id: number) {
    const em = this.ds.manager;
    const b = await this.load(em, user, id);
    const reason = await this.deletable(em, user, b);
    return { id, code: str(b.data.code), name: str(b.data.name), canDelete: !reason, reason, token: sigOf('bundle-del', b.id, b.updatedAt ? new Date(b.updatedAt).getTime() : 0) };
  }

  async deletionExecute(user: AuthUser, id: number, token: string, confirmCode: string, reason: string) {
    if (reason.trim().length < 2) throw new BadRequestException('必须写明删除原因');
    const pre = await this.deletionPreview(user, id);
    if (pre.token !== token) throw new ConflictException('资料在预览之后变了，请重新预览');
    if (!pre.canDelete) throw new BadRequestException(pre.reason);
    if (confirmCode.trim().toUpperCase() !== pre.code.toUpperCase()) throw new BadRequestException('请完整输入要删除的组合编码来确认');
    for (const l of await this.lineRecords(this.ds.manager, user, id)) await this.resources.remove(user, 'finance-bundle-lines', l.id, reason.trim());
    const pend = num((await this.load(this.ds.manager, user, id)).data.pendingRevisionId);
    if (pend) await this.resources.remove(user, 'finance-bundle-revisions', pend, reason.trim());
    await this.resources.remove(user, TYPE, id, reason.trim());
    return { ok: true };
  }

  /** 失效归档：组合不再使用。上传过聚水潭的，同时把“停用旧编码”加入出站队列（需要确认，且只有管理员能做）。 */
  /** 还在队列里（待发送/发送中）的上传任务：这时改构成、归档都会和队列里的内容打架 */
  private async pendingJobs(user: AuthUser, id: number) {
    const [{ n }] = await this.ds.query("SELECT COUNT(*) AS n FROM outbox_jobs WHERE company_id = ? AND resource_type = ? AND resource_id = ? AND status IN ('pending', 'sending')", [user.companyId, TYPE, id]);
    return Number(n);
  }

  async archive(user: AuthUser, id: number, reason: string, disableConfirmed: boolean) {
    if (reason.trim().length < 2) throw new BadRequestException('必须写明归档原因');
    const b = await this.load(this.ds.manager, user, id);
    if (b.status === 'archived') throw new BadRequestException('已经归档了');
    if (await this.pendingJobs(user, id)) throw new ConflictException('这个组合还有没发送完的聚水潭同步任务，请先等它发完或在同步队列里取消');
    if (num(b.data.pendingRevisionId)) throw new ConflictException('这个组合有待发布的构成修订，请先发布或取消修订');
    const synced = !!str(b.data.jstUploadedCode);
    if (synced && !disableConfirmed) throw new BadRequestException('这个组合上传过聚水潭，需要确认“同时在聚水潭停用它”');
    if (synced && !user.permissions.isCompanyAdmin) throw new ForbiddenException('上传过聚水潭的组合，只有公司管理员能归档');
    let queued = false;
    if (synced) queued = (await this.outbox.enqueueDisable(user, TYPE, id, reason.trim())).queued;
    await this.resources.changeStatus(user, TYPE, id, 'archived', reason.trim());
    return { ok: true, disableQueued: queued };
  }
}
