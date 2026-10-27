import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { createChecker, normalizeSpecs, normalizeWarehouse, type SkuSpec, type WarehouseLine, type WarehouseSpec } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { FlowRun, Notification, ResourceRecord } from '../entities';
import { sigOf } from '../resources/base-code-support';
import type { BundleToolsService, LineInput, TargetInput } from '../resources/bundle-tools.service';
import type { FlowAdapter } from './flow-adapters';

/**
 * SKU 批量申请流程的业务规则（运营 → 仓库 → 财务）。流转、办理人、退回、通知都由流程引擎负责，
 * 这里只声明：能不能发起、每一步办理时校验什么、财务通过时调用「商品组合编码」的批量生成服务建组合。
 */

export const SKU_TEMPLATE = 'sku-batch-apply';
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const asEngine = (user: AuthUser): AuthUser => ({ ...user, permissions: { isCompanyAdmin: true, allow: [], deny: [] } });

/** 各用途允许的商品档案类型（沿用旧系统：主品=原料/采购成品；赠品另加发货物料；包装=产品包装；标签/说明书/其他=发货物料） */
const ALLOWED_ARCHIVE: Record<string, string[]> = {
  main: ['raw', 'purchased'],
  gift: ['raw', 'purchased', 'shipping_material'],
  package: ['package', 'oem_package'],
  label: ['shipping_material'],
  instruction: ['shipping_material'],
  other: ['shipping_material'],
};
const ROLE_LABEL: Record<string, string> = { main: '主商品', gift: '赠品', package: '包装', label: '标签', instruction: '说明书', other: '其他物料' };

export const platformIdsOf = (p: Record<string, unknown>): number[] => (Array.isArray(p.platformIds) ? p.platformIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

export function specLines(spec: SkuSpec, wh?: WarehouseSpec): LineInput[] {
  const lines: LineInput[] = [
    ...spec.main.map((l) => ({ role: 'main', baseCodeId: l.baseCodeId, qty: l.qty })),
    ...spec.gift.map((l) => ({ role: 'gift', baseCodeId: l.baseCodeId, qty: l.qty })),
  ];
  for (const l of (wh?.lines ?? []) as WarehouseLine[]) lines.push(l.role === 'labor' ? { role: 'labor', laborId: l.laborId, qty: l.qty } : { role: l.role, baseCodeId: l.baseCodeId, qty: l.qty });
  return lines;
}
const lineSig = (lines: LineInput[]) => lines.map((l) => `${l.role}:${l.role === 'labor' ? `L${l.laborId}` : l.baseCodeId}:${l.qty}`).sort().join('|');

/** 检查每个商品：存在、同公司、已验证、档案类型符合用途、主品赠品有成本 */
async function checkBaseCode(em: EntityManager, companyId: number, id: number, role: string, cache: Map<number, { bc: ResourceRecord; archive: string }>) {
  let hit = cache.get(id);
  if (!hit) {
    const bc = await em.findOne(ResourceRecord, { where: { id, companyId, type: 'finance-base-codes' } });
    if (!bc) throw new BadRequestException('选择的商品不存在，请重新选择');
    const prod = await em.findOne(ResourceRecord, { where: { id: Number(bc.data.productId), companyId, type: 'finance-products' } });
    hit = { bc, archive: str(prod?.data.archiveType) };
    cache.set(id, hit);
  }
  const { bc, archive } = hit;
  if (bc.status !== 'verified') throw new BadRequestException(`商品「${bc.title}」还没验证，验证通过后才能用于申请`);
  if (!ALLOWED_ARCHIVE[role].includes(archive)) throw new BadRequestException(`「${bc.title}」不能当作${ROLE_LABEL[role]}（档案类型不对）`);
  if ((role === 'main' || role === 'gift') && num(bc.data.cost) === null) throw new BadRequestException(`商品「${bc.title}」还没有有效成本，请先让财务维护成本`);
  return bc;
}

async function checkLabor(em: EntityManager, companyId: number, id: number) {
  const labor = await em.findOne(ResourceRecord, { where: { id, companyId, type: 'finance-labor-costs' } });
  if (!labor) throw new BadRequestException('选择的人工项目不存在');
  if (labor.status !== 'active') throw new BadRequestException(`人工项目「${labor.title}」已停用`);
}

interface PlanTarget { platformId: number; platformName: string; code: string; name: string; reuse: { id: number; code: string; status: string } | null; duplicates: { layer: string; label: string; hit: string }[]; ok: boolean }

/** 申请的整体检查：规格格式、商品、重复。strict = 发起/重新提交时（已有相同组合要写原因） */
export async function checkApplication(em: EntityManager, user: AuthUser, bundles: BundleToolsService, payload: Record<string, unknown>, opts: { strict: boolean; selfRunId?: number; warehouse?: WarehouseSpec[] }) {
  const norm = normalizeSpecs(payload.specs);
  if (norm.errors.length) throw new BadRequestException(norm.errors.join('；'));
  payload.specs = norm.specs;
  const platformIds = platformIdsOf(payload);
  const scenarioId = num(payload.scenarioId);
  if (!scenarioId) throw new BadRequestException('请选择销售场景');
  if (platformIds.length === 0) throw new BadRequestException('请至少选一个销售平台');
  const cache = new Map<number, { bc: ResourceRecord; archive: string }>();
  const seen = new Map<string, string>();
  const plan: { name: string; lines: LineInput[]; targets: PlanTarget[] }[] = [];
  for (const [i, spec] of norm.specs.entries()) {
    for (const l of spec.main) await checkBaseCode(em, user.companyId, l.baseCodeId, 'main', cache);
    for (const l of spec.gift) await checkBaseCode(em, user.companyId, l.baseCodeId, 'gift', cache);
    const wh = opts.warehouse?.[i];
    for (const l of wh?.lines ?? []) {
      if (l.role === 'labor') await checkLabor(em, user.companyId, l.laborId!);
      else await checkBaseCode(em, user.companyId, l.baseCodeId!, l.role, cache);
    }
    const lines = specLines(spec, wh);
    const sig = lineSig(lines);
    if (seen.has(sig)) throw new BadRequestException(`规格「${spec.name}」和「${seen.get(sig)}」的构成完全一样，不用重复申请`);
    seen.set(sig, spec.name);
    const pre = await bundles.preview(asEngine(user), lines, platformIds.map((platformId): TargetInput => ({ platformId, scenarioId })), em);
    const targets = pre.targets.map((t): PlanTarget => ({ platformId: t.platformId, platformName: t.platformName, code: t.code, name: t.name, reuse: t.reuse, duplicates: t.duplicates, ok: t.ok }));
    // 编码被「本地组合编码」占用 = 系统里已经有主品、赠品相同的组合（编码只由主品、赠品、平台、场景决定）
    const sameBundle = (t: PlanTarget) => !t.reuse && t.duplicates.length > 0 && t.duplicates.every((d) => d.layer === 'bundle');
    const hardBad = targets.find((t) => !t.ok && !sameBundle(t));
    if (hardBad) throw new BadRequestException(`规格「${spec.name}」生成的编码「${hardBad.code}」重复：${hardBad.duplicates.map((d) => `${d.label}「${d.hit}」`).join('、')}`);
    const existing = targets.filter((t) => t.reuse || sameBundle(t));
    if (opts.strict) {
      if (existing.length && !spec.reuseReason) {
        throw new BadRequestException(`规格「${spec.name}」在系统里已经有主商品、赠品相同的组合编码（${existing.map((t) => t.reuse?.code ?? t.code).join('、')}），如果仍要申请，请在该规格里写明原因`);
      }
    } else {
      // 仓库配好之后：构成完全一样 → 沿用已有编码；只是包装、标签、人工不同 → 编码一样但内容不同，不能覆盖
      const clash = targets.find(sameBundle);
      if (clash) throw new BadRequestException(`规格「${spec.name}」的编码「${clash.code}」已被一个包装、标签或人工不同的组合占用（编码只由主商品、赠品、平台、场景决定，区分不了），不能覆盖。请改用已有组合，或联系财务调整命名规则后再申请`);
    }
    plan.push({ name: spec.name, lines, targets });
  }
  await assertNoInflightOverlap(em, user.companyId, norm.specs, platformIds, scenarioId, opts.selfRunId);
  return { specs: norm.specs, platformIds, scenarioId, plan, cache };
}

/** 其他在办的 SKU 申请里，同样的构成 × 平台 × 场景不能再申请一遍（只比运营填的主品和赠品） */
async function assertNoInflightOverlap(em: EntityManager, companyId: number, specs: SkuSpec[], platformIds: number[], scenarioId: number, selfRunId?: number) {
  const runs = await em.find(FlowRun, { where: { companyId, templateKey: SKU_TEMPLATE, status: 'running' } });
  const mine = new Map(specs.map((s) => [lineSig(specLines(s)), s.name]));
  for (const r of runs) {
    if (r.id === selfRunId) continue;
    const otherPlatforms = platformIdsOf(r.payload);
    if (num(r.payload.scenarioId) !== scenarioId || !otherPlatforms.some((p) => platformIds.includes(p))) continue;
    const other = normalizeSpecs(r.payload.specs).specs;
    for (const o of other) {
      const hit = mine.get(lineSig(specLines(o)));
      if (hit) throw new BadRequestException(`规格「${hit}」和在办的申请 #${r.id}（${r.title}）里的规格「${o.name}」重复，请等它办完或沟通后再申请`);
    }
  }
}

/** 仓库提交时算的“核对指纹”：编码、名称、各商品的验证快照和成本。财务通过时必须还是这个指纹 */
export async function reviewSignature(em: EntityManager, user: AuthUser, bundles: BundleToolsService, payload: Record<string, unknown>, warehouse: WarehouseSpec[], selfRunId?: number) {
  const r = await checkApplication(em, user, bundles, { ...payload }, { strict: false, warehouse, selfRunId });
  const parts: string[] = [];
  for (const p of r.plan) {
    parts.push(p.name, ...p.targets.map((t) => `${t.code}|${t.name}|${t.reuse?.id ?? ''}`));
    for (const l of p.lines) {
      if (l.role === 'labor') continue;
      const hit = r.cache.get(l.baseCodeId!);
      parts.push(`${l.baseCodeId}:${hit?.bc.data.signature ?? ''}:${hit?.bc.data.cost ?? ''}:${hit?.bc.data.weightG ?? ''}`);
    }
  }
  return sigOf(...parts);
}

const notify = (em: EntityManager, companyId: number, userId: number, title: string, body: string, link: string) =>
  em.insert(Notification, { companyId, userId, kind: 'result', title: title.slice(0, 200), body: body.slice(0, 500), link });

export interface CreatedBundle { spec: string; bundleId: number; code: string; reused: boolean }

export const skuBatchApply: FlowAdapter = {
  key: SKU_TEMPLATE,
  async title(_em, _companyId, p) {
    const n = Array.isArray(p.specs) ? p.specs.length : 0;
    return `SKU 批量申请 · ${str(p.batchName)} · ${n} 个规格`.slice(0, 200);
  },
  async validateStart({ em, user, payload, bundles }) {
    if (!bundles) throw new BadRequestException('服务没有准备好');
    const name = str(payload.batchName).trim();
    if (!name) throw new BadRequestException('请填写申请名称');
    if (!num(payload.bundleCategoryId)) throw new BadRequestException('请选择组合分类');
    await checkApplication(em, user, bundles, payload, { strict: true });
  },
  async beforePass({ em, user, run, payload, stepKey, form, bundles }) {
    if (!bundles) throw new BadRequestException('服务没有准备好');
    const specs = normalizeSpecs(payload.specs).specs;
    if (stepKey === 'warehouse') {
      const norm = normalizeWarehouse(form.config, specs.map((s) => s.name));
      if (norm.errors.length) throw new BadRequestException(norm.errors.join('；'));
      form.config = norm.config; // 整理后的配置
      await checkApplication(em, user, bundles, { ...payload }, { strict: false, selfRunId: run.id, warehouse: norm.config });
    }
    if (stepKey === 'review') {
      const can = createChecker(user.permissions);
      // 生成并验证组合编码相当于改「商品组合编码」资料，办理人自己必须有这个权限
      if (!can('resource.finance-bundles.create') || !can('resource.finance-bundles.edit')) throw new BadRequestException('财务审核会生成并验证商品组合编码，你没有「商品组合编码」的新增和修改权限，请联系管理员');
      if (form.confirmed !== true) throw new BadRequestException('请先勾选“我已核对规格、成本和编码”');
      if (form.syncToJst === true && !can('finance.jst-sync.view')) throw new BadRequestException('你没有聚水潭同步的权限，不能勾选“加入聚水潭同步队列”');
      const wh = payload._warehouse as WarehouseSpec[] | undefined;
      if (!wh || !payload._reviewSig) throw new BadRequestException('仓库还没有提交配置，不能审核');
      const now = await reviewSignature(em, user, bundles, payload, wh, run.id);
      if (now !== payload._reviewSig) throw new BadRequestException('仓库提交之后，商品、成本或编码发生了变化，请退回仓库重新确认');
    }
  },
  async onPass(ctx) {
    const { em, user, run, payload, stepKey, form, bundles, resources } = ctx;
    if (!bundles) throw new BadRequestException('服务没有准备好');
    if (stepKey === 'warehouse') {
      const wh = form.config as WarehouseSpec[];
      payload._warehouse = wh;
      payload._reviewSig = await reviewSignature(em, user, bundles, payload, wh, run.id);
      return;
    }
    if (stepKey !== 'review') return;
    const specs = normalizeSpecs(payload.specs).specs;
    const wh = payload._warehouse as WarehouseSpec[];
    const platformIds = platformIdsOf(payload);
    const scenarioId = num(payload.scenarioId)!;
    const actor = asEngine(user);
    const created: CreatedBundle[] = [];
    for (const [i, spec] of specs.entries()) {
      const res = await bundles.generate(actor, specLines(spec, wh[i]), platformIds.map((platformId) => ({ platformId, scenarioId, bundleCategoryId: num(payload.bundleCategoryId) ?? undefined })), em);
      for (const c of res.created) {
        const rec = await em.findOne(ResourceRecord, { where: { id: c.id, companyId: user.companyId, type: 'finance-bundles' } });
        if (!rec) continue;
        if (!c.reused) await resources.patchData(em, actor, 'finance-bundles', c.id, { sourceRunId: run.id }, `SKU 批量申请 #${run.id} 生成`);
        // 财务审核通过就是验证：新建的和“待验证/需重新验证”的一并验证；已验证的沿用
        if (rec.status === 'pending' || rec.status === 'reverify') await resources.setStatusChecked(em, actor, 'finance-bundles', c.id, 'verified', `SKU 批量申请 #${run.id} 财务审核通过`);
        created.push({ spec: spec.name, bundleId: c.id, code: c.code, reused: c.reused });
      }
    }
    payload._created = created;
    payload._syncRequested = form.syncToJst === true;
    await notify(em, run.companyId, run.requesterId, `SKU 申请已通过：${str(payload.batchName)}`,
      `共 ${specs.length} 个规格，生成 ${created.filter((c) => !c.reused).length} 个组合编码，沿用已有 ${created.filter((c) => c.reused).length} 个。到“财务 → 商品组合编码”查看。`, `/workbench/started?run=${run.id}`);
  },
  /** 事务提交后再加入聚水潭同步队列（队列用独立连接，必须等组合真正提交）；失败不影响已通过的申请，只提醒处理 */
  async afterCommit({ user, runId, companyId, requesterId, payload, outbox, db }) {
    if (payload._syncRequested !== true || !outbox) return;
    const ids = ((payload._created as CreatedBundle[] | undefined) ?? []).map((c) => c.bundleId);
    if (!ids.length) return;
    try {
      const r = await outbox.enqueue(asEngine(user), 'finance-bundles', ids);
      await notify(db, companyId, user.id, `SKU 申请 #${runId}：已加入聚水潭同步队列`, `新入队 ${r.queued} 个，跳过 ${r.skipped} 个。总开关打开并接入聚水潭后才会真正发送。`, `/workbench/started?run=${runId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '未知错误';
      for (const uid of new Set([user.id, requesterId])) await notify(db, companyId, uid, `SKU 申请 #${runId}：加入聚水潭同步队列失败`, `${msg}。申请本身已通过，请到“商品组合编码”页手工同步。`, `/workbench/started?run=${runId}`);
    }
  },
};

