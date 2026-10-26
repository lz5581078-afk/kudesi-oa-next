import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import type { AfterSaveContext, BeforeSaveContext, RuleHost } from './resource-rules';

/**
 * 快递价格规则：快递公司 → 经营网点 → 价格版本 → 价格规则。
 *  - 价格规则仍是平铺的“快递价格表”记录，运费预估直接读它；规则是否生效（状态 启用/停用）由层级决定：
 *    所在网点的当前版本 + 合作状态“合作中” + 版本未停用 + 快递公司和网点正常 + 价格来源与版本“最终价格依据”一致。
 *  - 没挂版本的老规则（直接手填快递公司）保持原样，由自己的状态决定。
 */
type Data = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const rec = (em: EntityManager, companyId: number, type: string, id: unknown) =>
  typeof id === 'number' ? em.findOne(ResourceRecord, { where: { id, companyId, type } }) : Promise.resolve(null);

export interface VersionContext {
  version: ResourceRecord;
  branch: ResourceRecord;
  carrier: ResourceRecord;
  /** 版本里实际采用的价格来源 */
  source: 'ai' | 'manual';
  /** 版本是否处在“参与运费预估”的状态（不含日期） */
  enabled: boolean;
}

/** 版本实际采用的价格来源：版本里选了就用选的；没选时有手工价格用手工，只有 AI 价格才用 AI */
export function resolveSource(version: Pick<ResourceRecord, 'data'>, rules: Array<Pick<ResourceRecord, 'data'>>): 'ai' | 'manual' {
  if (version.data.priceSource === 'ai') return 'ai';
  if (version.data.priceSource === 'manual') return 'manual';
  return !rules.some((r) => (r.data.source ?? 'manual') === 'manual') && rules.some((r) => r.data.source === 'ai') ? 'ai' : 'manual';
}

/** 版本是否参与运费预估（不含日期）：网点当前版本 + 合作中 + 版本未停用 + 快递公司和网点都正常 */
export function versionEnabled(version: Pick<ResourceRecord, 'id' | 'status' | 'data'>, branch: Pick<ResourceRecord, 'status' | 'data'>, carrier: Pick<ResourceRecord, 'status'>): boolean {
  return branch.data.currentVersionId === version.id && version.data.cooperationStatus === 'active' && version.status !== 'inactive' && branch.status === 'normal' && carrier.status === 'normal';
}

export async function versionContext(em: EntityManager, host: RuleHost, companyId: number, versionId: unknown): Promise<VersionContext | null> {
  const version = await rec(em, companyId, 'finance-express-versions', versionId);
  if (!version) return null;
  const branch = await rec(em, companyId, 'finance-express-branches', version.data.branchId);
  if (!branch) return null;
  const carrier = await rec(em, companyId, 'finance-express-carriers', branch.data.carrierId);
  if (!carrier) return null;
  const rules = version.data.priceSource ? [] : await host.findWhere(em, companyId, 'finance-express-prices', 'versionId', version.id);
  return { version, branch, carrier, source: resolveSource(version, rules), enabled: versionEnabled(version, branch, carrier) };
}

/** 一条价格规则应有的派生字段和状态 */
export function derivedRuleState(ctx: VersionContext, rule: ResourceRecord) {
  const v = ctx.version.data;
  const patch: Data = {
    carrier: ctx.carrier.title,
    branch: ctx.branch.title,
    validFrom: str(v.effectiveStart) || undefined,
    validTo: str(v.effectiveEnd) || undefined,
    limitMin: num(v.shippingWeightMin) ?? 0,
    limitMax: num(v.shippingWeightMax) ?? undefined,
  };
  const ruleSource = (rule.data.source as string) || 'manual';
  const status = ctx.enabled && ruleSource === ctx.source ? 'active' : 'inactive';
  return { patch, status };
}

export async function syncRule(host: RuleHost, em: EntityManager, user: AuthUser, ctx: VersionContext, rule: ResourceRecord) {
  const { patch, status } = derivedRuleState(ctx, rule);
  await host.patchData(em, user, 'finance-express-prices', rule.id, patch);
  await host.setStatusDirect(em, user, 'finance-express-prices', rule.id, status);
}

export async function syncVersionRules(host: RuleHost, em: EntityManager, user: AuthUser, versionId: number) {
  const ctx = await versionContext(em, host, user.companyId, versionId);
  if (!ctx) return;
  for (const rule of await host.findWhere(em, user.companyId, 'finance-express-prices', 'versionId', versionId)) await syncRule(host, em, user, ctx, rule);
}

export async function syncBranchRules(host: RuleHost, em: EntityManager, user: AuthUser, branchId: number) {
  for (const v of await host.findWhere(em, user.companyId, 'finance-express-versions', 'branchId', branchId)) await syncVersionRules(host, em, user, v.id);
}

// ---------- 保存前 ----------

async function beforeCarrier({ em, user, existing, data }: BeforeSaveContext) {
  const name = str(data.name).trim();
  if (!name) throw new BadRequestException('请填写快递公司名称');
  data.name = name;
  if (data.defaultBranchId !== undefined && data.defaultBranchId !== null) {
    const b = await rec(em, user.companyId, 'finance-express-branches', data.defaultBranchId);
    if (!b || !existing || b.data.carrierId !== existing.id) throw new BadRequestException('默认网点必须是这家快递公司下的网点');
  }
}

async function beforeBranch({ em, user, existing, data }: BeforeSaveContext) {
  const carrier = await rec(em, user.companyId, 'finance-express-carriers', data.carrierId);
  if (!carrier) throw new BadRequestException('请选择快递公司');
  if (existing && existing.data.carrierId !== data.carrierId) throw new BadRequestException('网点不能换快递公司');
  const name = str(data.name).trim();
  if (!name) throw new BadRequestException('请填写经营网点名称');
  data.name = name;
  if (data.jstLogisticsName !== undefined) data.jstLogisticsName = str(data.jstLogisticsName).trim() || undefined;
  if (data.currentVersionId !== undefined && data.currentVersionId !== null) {
    const v = await rec(em, user.companyId, 'finance-express-versions', data.currentVersionId);
    if (!v || !existing || v.data.branchId !== existing.id) throw new BadRequestException('当前价格版本必须是这个网点下的版本');
  }
}

async function beforeVersion({ em, user, existing, data }: BeforeSaveContext) {
  const branch = await rec(em, user.companyId, 'finance-express-branches', data.branchId);
  if (!branch) throw new BadRequestException('请选择经营网点');
  if (existing && existing.data.branchId !== data.branchId) throw new BadRequestException('价格版本不能换网点');
  const name = str(data.versionName).trim();
  if (!name) throw new BadRequestException('请填写版本名称');
  data.versionName = name;
  if (!data.cooperationStatus) data.cooperationStatus = 'pending';
  const from = str(data.effectiveStart), to = str(data.effectiveEnd);
  if (from && to && to < from) throw new BadRequestException('失效日期不能早于生效日期');
  const min = num(data.shippingWeightMin) ?? 0, max = num(data.shippingWeightMax);
  if (min < 0) throw new BadRequestException('可发货重量下限不能小于 0');
  if (max !== null && max <= min) throw new BadRequestException('可发货重量上限必须大于下限');
}

async function beforeRule(ctx: BeforeSaveContext) {
  const { em, host, user, data } = ctx;
  if (data.versionId !== undefined && data.versionId !== null) {
    const vc = await versionContext(em, host, user.companyId, data.versionId);
    if (!vc) throw new BadRequestException('价格版本不存在');
    if (ctx.existing && ctx.existing.data.versionId !== data.versionId) throw new BadRequestException('价格规则不能换版本');
    data.carrier = vc.carrier.title;
    data.branch = vc.branch.title;
    if (!data.source) data.source = 'manual';
  } else if (!str(data.carrier).trim()) {
    throw new BadRequestException('请选择价格版本，或填写快递公司');
  }
  const min = num(data.shipWeightMin) ?? 0, max = num(data.shipWeightMax);
  if (min < 0) throw new BadRequestException('适用重量下限不能小于 0');
  if (max !== null && max <= min) throw new BadRequestException('适用重量上限必须大于下限');
  const fixed = num(data.fixedPrice);
  if (fixed === null) {
    const fw = num(data.firstWeight);
    if (fw === null || num(data.firstPrice) === null) throw new BadRequestException('请填写固定价，或填写首重和首重价');
    if (fw !== 0 && fw !== 1) throw new BadRequestException('首重只能是 0 或 1 公斤');
  }
  if (data.validFrom && data.validTo && str(data.validTo) < str(data.validFrom)) throw new BadRequestException('失效日期不能早于生效日期');
  data.label = `${str(data.carrier)}${data.branch ? `/${str(data.branch)}` : ''} ${str(data.province) === 'ALL' ? '全国' : str(data.province)}`.slice(0, 200);
}

async function beforeSurchargeBatch({ em, user, data }: BeforeSaveContext) {
  if (!(await rec(em, user.companyId, 'finance-express-versions', data.versionId))) throw new BadRequestException('价格版本不存在');
  if (!str(data.batchName).trim()) throw new BadRequestException('请填写批次名称');
}

async function beforeSurcharge({ em, user, data }: BeforeSaveContext) {
  if (!(await rec(em, user.companyId, 'finance-express-versions', data.versionId))) throw new BadRequestException('价格版本不存在');
  if (data.batchId !== undefined && data.batchId !== null) {
    const b = await rec(em, user.companyId, 'finance-express-fee-batches', data.batchId);
    if (!b || b.data.versionId !== data.versionId) throw new BadRequestException('加收批次不属于这个价格版本');
  }
  const type = str(data.chargeType);
  if (type === 'percent') {
    const p = num(data.percent);
    if (p === null || p <= 0 || p > 1000) throw new BadRequestException('按比例加收要填 0 到 1000 之间的百分数');
    data.amount = undefined;
  } else {
    const a = num(data.amount);
    if (a === null || a <= 0) throw new BadRequestException('请填写大于 0 的加收金额');
    data.percent = undefined;
  }
  const from = str(data.effectiveStart), to = str(data.effectiveEnd);
  if (from && to && to < from) throw new BadRequestException('结束日期不能早于开始日期');
  const mode = str(data.weightMode) || 'all';
  const ws = num(data.weightStart), we = num(data.weightEnd);
  if (mode === 'all') { data.weightStart = undefined; data.weightEnd = undefined; }
  else if (mode === 'below') { if (we === null || we <= 0) throw new BadRequestException('请填写“多少公斤以内”的重量'); data.weightStart = undefined; }
  else if (mode === 'above') { if (ws === null || ws < 0) throw new BadRequestException('请填写“多少公斤以上”的重量'); data.weightEnd = undefined; }
  else if (mode === 'between') { if (ws === null || we === null || we <= ws) throw new BadRequestException('区间重量要填起始和结束，结束必须大于起始'); }
  else throw new BadRequestException('重量范围不合法');
}

// ---------- 保存后 ----------

async function afterBranch({ em, host, user, record, existing }: AfterSaveContext) {
  if (!existing || existing.status !== record.status || existing.data.currentVersionId !== record.data.currentVersionId) await syncBranchRules(host, em, user, record.id);
  if (!existing) {
    // 第一个网点自动成为公司默认网点
    const carrier = await rec(em, user.companyId, 'finance-express-carriers', record.data.carrierId);
    if (carrier && !carrier.data.defaultBranchId) await host.patchData(em, user, 'finance-express-carriers', carrier.id, { defaultBranchId: record.id }, '第一个网点自动设为默认网点');
  }
}

async function afterCarrier({ em, host, user, record, existing }: AfterSaveContext) {
  if (existing && existing.status !== record.status) {
    for (const b of await host.findWhere(em, user.companyId, 'finance-express-branches', 'carrierId', record.id)) await syncBranchRules(host, em, user, b.id);
  }
}

async function afterVersion({ em, host, user, record, existing }: AfterSaveContext) {
  if (!existing) {
    const branch = await rec(em, user.companyId, 'finance-express-branches', record.data.branchId);
    // 第一个版本自动成为网点的当前版本
    if (branch && !branch.data.currentVersionId) await host.patchData(em, user, 'finance-express-branches', branch.id, { currentVersionId: record.id }, '第一个价格版本自动设为当前版本');
  }
  await syncVersionRules(host, em, user, record.id);
}

async function afterRule({ em, host, user, record }: AfterSaveContext) {
  if (typeof record.data.versionId !== 'number') return;
  const ctx = await versionContext(em, host, user.companyId, record.data.versionId);
  if (ctx) await syncRule(host, em, user, ctx, record);
}

async function afterSurchargeBatch({ em, host, user, record, existing }: AfterSaveContext) {
  if (!existing || existing.status === record.status) return;
  const to = record.status === 'active' ? 'active' : 'stopped';
  for (const s of await host.findWhere(em, user.companyId, 'finance-express-surcharges', 'batchId', record.id)) await host.setStatusDirect(em, user, 'finance-express-surcharges', s.id, to, '加收批次状态变了');
}

export const EXPRESS_BEFORE_SAVE: Record<string, (ctx: BeforeSaveContext) => Promise<void>> = {
  'finance-express-carriers': beforeCarrier,
  'finance-express-branches': beforeBranch,
  'finance-express-versions': beforeVersion,
  'finance-express-prices': beforeRule,
  'finance-express-fee-batches': beforeSurchargeBatch,
  'finance-express-surcharges': beforeSurcharge,
};

export const EXPRESS_AFTER_SAVE: Record<string, (ctx: AfterSaveContext) => Promise<void>> = {
  'finance-express-carriers': afterCarrier,
  'finance-express-branches': afterBranch,
  'finance-express-versions': afterVersion,
  'finance-express-prices': afterRule,
  'finance-express-fee-batches': afterSurchargeBatch,
};
