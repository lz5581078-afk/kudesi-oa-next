import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';
import { EntityManager } from 'typeorm';
import { FlowRun, ResourceRecord } from '../entities';
import type { BeforeSaveContext } from './resource-rules';

/**
 * 商品专属领取（旧系统 product-exclusivity）。
 * 归属以“分类 + 品牌 + 品种(无则商品名)”为一族：同一族的基础编码（不同规格、别名、带赠品的组合）共享一个专属归属。
 * 申请走统一流程引擎（模板 product-exclusive，审批人由管理员在流程定义里配置，这里不写死）；
 * 通过时生成一条专属记录，同一族同一时间只能有一条有效记录、一条在办的申请。
 */
type Data = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
export const EXCLUSIVE_TYPE = 'finance-product-exclusives';
export const EXCLUSIVE_TEMPLATE = 'product-exclusive';
export const EXCLUSIVE_KEY = 'exclusiveGrant';
const MAX_DAYS = 3650;

const normalize = (v: unknown) => str(v).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export interface FamilyMember { id: number; title: string; name: string; familyKey: string; canonicalId: number | null; status: string }

/** 每个基础编码属于哪一族。别名（马甲）跟着真实编码走；已领取过的编码冻结在领取时的族里，之后资料改了也不换族。 */
export async function familyMembers(em: EntityManager, companyId: number): Promise<Map<number, FamilyMember>> {
  const [codes, products, grants] = await Promise.all([
    em.find(ResourceRecord, { where: { companyId, type: 'finance-base-codes' } }),
    em.find(ResourceRecord, { where: { companyId, type: 'finance-products' }, select: ['id', 'data', 'title'] }),
    em.find(ResourceRecord, { where: { companyId, type: EXCLUSIVE_TYPE } }),
  ]);
  const byId = new Map(codes.map((c) => [c.id, c]));
  const prod = new Map(products.map((p) => [p.id, p]));
  const frozen = new Map<number, string>();
  for (const g of grants) for (const id of Array.isArray(g.data.memberIds) ? (g.data.memberIds as unknown[]) : []) if (typeof id === 'number' && !frozen.has(id)) frozen.set(id, str(g.data.familyKey));
  const fingerprint = (c: ResourceRecord): string => {
    const base: ResourceRecord = byId.get(Number(c.data.canonicalId)) ?? c;
    const composed = base.data.origin === 'composed';
    const p = prod.get(Number(base.data.productId));
    const category = composed ? base.data.codeCategoryId : (base.data.categoryId ?? p?.data.categoryId);
    const brand = composed ? base.data.codeBrandId : p?.data.brandId;
    const name = normalize(base.data.varietyName) || normalize(base.data.name) || normalize(p?.title);
    return crypto.createHash('sha256').update(JSON.stringify([str(category), str(brand), name])).digest('hex');
  };
  const printed = new Map<number, string>();
  const byPrint = new Map<string, string>();
  for (const c of codes) {
    const fp = fingerprint(c);
    printed.set(c.id, fp);
    const f = frozen.get(c.id);
    if (f && !byPrint.has(fp)) byPrint.set(fp, f);
  }
  const out = new Map<number, FamilyMember>();
  for (const c of codes) {
    const fp = printed.get(c.id)!;
    out.set(c.id, { id: c.id, title: c.title, name: str(c.data.name), familyKey: frozen.get(c.id) ?? byPrint.get(fp) ?? fp, canonicalId: c.data.canonicalId ? Number(c.data.canonicalId) : null, status: c.status });
  }
  return out;
}

const isLive = (g: ResourceRecord, now: string) => g.status === 'active' && str(g.data.startsAt) <= now && str(g.data.endsAt) > now;

export async function activeGrants(em: EntityManager, companyId: number): Promise<ResourceRecord[]> {
  const now = new Date().toISOString();
  return (await em.find(ResourceRecord, { where: { companyId, type: EXCLUSIVE_TYPE, status: 'active' } })).filter((g) => isLive(g, now));
}

export interface BundleOwner { id: number; ownerId: number; ownerName: string; productName: string; startsAt: string; endsAt: string }

/**
 * 组合的专属归属（旧系统 bundleOwnership）：组合里“主品”行的基础编码所在的族有有效专属，就算这个组合有专属人。
 * 每族只看第一条有效专属；同一组合里同一条专属只算一次。lines 是组合构成行（bundleId、baseCodeId、role）。
 */
export async function bundleOwnership(em: EntityManager, companyId: number, lines: ResourceRecord[]): Promise<Map<number, BundleOwner[]>> {
  const out = new Map<number, BundleOwner[]>();
  const grants = await activeGrants(em, companyId);
  if (!grants.length) return out;
  const members = await familyMembers(em, companyId);
  const byFamily = new Map<string, ResourceRecord>();
  for (const g of [...grants].sort((a, b) => str(a.data.startsAt).localeCompare(str(b.data.startsAt)) || a.id - b.id)) if (!byFamily.has(str(g.data.familyKey))) byFamily.set(str(g.data.familyKey), g);
  const seen = new Map<number, Set<number>>();
  for (const l of lines) {
    if (str(l.data.role) !== 'main') continue;
    const g = byFamily.get(members.get(Number(l.data.baseCodeId))?.familyKey ?? '');
    if (!g) continue;
    const bundleId = Number(l.data.bundleId);
    const ids = seen.get(bundleId) ?? new Set<number>();
    if (ids.has(g.id)) continue;
    ids.add(g.id); seen.set(bundleId, ids);
    (out.get(bundleId) ?? out.set(bundleId, []).get(bundleId)!).push({ id: g.id, ownerId: Number(g.data.ownerId), ownerName: str(g.data.ownerName), productName: str(g.data.productName), startsAt: str(g.data.startsAt), endsAt: str(g.data.endsAt) });
  }
  return out;
}

/** 申请前后都要查：这一族已有有效专属，或有别的在办申请，就不能再领。selfRunId 是本申请自己。 */
export async function assertFamilyFree(em: EntityManager, companyId: number, baseCodeId: unknown, selfRunId: number | null): Promise<{ member: FamilyMember; members: FamilyMember[] }> {
  const all = await familyMembers(em, companyId);
  const member = all.get(Number(baseCodeId));
  if (!member) throw new BadRequestException('请选择有效的基础商品');
  if (['disabled', 'archived'].includes(member.status)) throw new BadRequestException(`基础商品「${member.title}」已停用或归档，不能领取`);
  const grant = (await activeGrants(em, companyId)).find((g) => g.data.familyKey === member.familyKey);
  if (grant) throw new BadRequestException('该基础商品已有有效专属归属，不能重复领取');
  const running = await em.find(FlowRun, { where: { companyId, templateKey: EXCLUSIVE_TEMPLATE, status: 'running' } });
  for (const r of running) {
    if (r.id === selfRunId) continue;
    if (all.get(Number(r.payload.baseCodeId))?.familyKey === member.familyKey) throw new BadRequestException(`该基础商品正在申请专属领取（申请 #${r.id}）`);
  }
  return { member, members: [...all.values()].filter((m) => m.familyKey === member.familyKey) };
}

export function parsePeriodDays(v: unknown): number {
  const n = num(v);
  if (n === null || !Number.isInteger(n) || n < 1 || n > MAX_DAYS) throw new BadRequestException(`专属期须为 1 至 ${MAX_DAYS} 天`);
  return n;
}

/** 审批通过时生成专属记录；锁公司行让并发申请排队，之后重新检查。 */
export async function grantExclusive(em: EntityManager, create: (values: Data) => Promise<ResourceRecord>, p: { companyId: number; runId: number; baseCodeId: number; ownerId: number; ownerName: string; approverId: number; approverName: string; days: number }): Promise<ResourceRecord> {
  await em.query('SELECT id FROM companies WHERE id = ? FOR UPDATE', [p.companyId]);
  const { member, members } = await assertFamilyFree(em, p.companyId, p.baseCodeId, p.runId);
  const starts = new Date();
  const ends = new Date(starts.getTime() + p.days * 86400000);
  const data = em.queryRunner?.data;
  // 专属记录的字段都是只读的（输入会被丢弃），由 beforeExclusive 从这里取值写入
  const values: Data = {
      label: `${member.name || member.title} · ${p.ownerName}`.slice(0, 200), baseCodeId: p.baseCodeId, productName: (member.name || member.title).slice(0, 180),
      ownerId: p.ownerId, ownerName: p.ownerName, approverId: p.approverId, approverName: p.approverName, startsAt: starts.toISOString(), endsAt: ends.toISOString(),
      runId: p.runId, familyKey: member.familyKey, memberIds: members.map((m) => m.id),
  };
  if (data) data[EXCLUSIVE_KEY] = values;
  try {
    return await create({});
  } finally { if (data) delete data[EXCLUSIVE_KEY]; }
}

/** 专属记录只能由流程生成；手工只能“取消”：本人放弃，或原审批人、管理员取消，必须写原因。 */
export async function beforeExclusive(ctx: BeforeSaveContext): Promise<void> {
  const { em, user, data, existing, status } = ctx;
  const sys = em.queryRunner?.data[EXCLUSIVE_KEY] as Data | undefined;
  if (sys) {
    if (!existing) Object.assign(data, sys);
    return;
  }
  if (!existing) throw new BadRequestException('专属记录只能通过“专属品领取”流程生成，不能手工新增');
  if (existing.status === 'cancelled') throw new BadRequestException('已取消的专属记录不能再改');
  for (const k of Object.keys(existing.data)) {
    if (JSON.stringify(data[k] ?? null) !== JSON.stringify(existing.data[k] ?? null) && k !== 'cancelledAt') throw new BadRequestException('专属记录不能修改，只能取消');
  }
  if (status !== 'cancelled') throw new BadRequestException('专属记录不能修改，只能取消');
  const mine = existing.data.ownerId === user.id || existing.data.approverId === user.id;
  if (!mine && !user.permissions.isCompanyAdmin) throw new ForbiddenException('只有专属人本人、原审批人或管理员可以取消专属');
  data.cancelledAt = new Date().toISOString();
}
