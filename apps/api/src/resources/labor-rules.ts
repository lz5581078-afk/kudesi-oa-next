import { BadRequestException } from '@nestjs/common';
import { pinyin } from 'pinyin-pro';
import { EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import type { AfterSaveContext, BeforeSaveContext, RuleHost } from './resource-rules';

/**
 * 人力成本表规则：版本（生效期、默认版本）→ 项目归档分类树（最多三级）→ 工作项目。
 * 工作项目带“工作分类”和“计价单位”两本可维护的字典；工作编号自动生成，上级改名后同步刷新。
 * 被成品构成行、组合构成行引用的人工项目，不能换版本、换单位、停用或删除（删除由通用引用保护拦住）。
 */
type Data = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const rec = (em: EntityManager, companyId: number, type: string, id: unknown) =>
  typeof id === 'number' ? em.findOne(ResourceRecord, { where: { id, companyId, type } }) : Promise.resolve(null);

function initials(text: string): string {
  const out: string[] = [];
  for (const ch of text.normalize('NFKC')) {
    if (/[A-Za-z0-9]/.test(ch)) out.push(ch.toUpperCase());
    else if (/[一-龥]/.test(ch)) out.push(pinyin(ch, { pattern: 'first', toneType: 'none' }).toUpperCase());
  }
  return out.join('');
}
const cleanCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

export const LABOR_MAX_DEPTH = 3;

async function usageCount(host: RuleHost, em: EntityManager, companyId: number, laborId: number): Promise<number> {
  const boms = await host.findWhere(em, companyId, 'finance-product-boms', 'laborId', laborId);
  const lines = await host.findWhere(em, companyId, 'finance-bundle-lines', 'laborId', laborId);
  return boms.length + lines.length;
}

// ---------- 版本 ----------

async function beforeVersion({ existing, data, status }: BeforeSaveContext) {
  const code = str(data.versionCode).trim();
  if (!code) throw new BadRequestException('请填写版本编号');
  data.versionCode = code;
  const from = str(data.effectiveFrom), to = str(data.effectiveTo);
  if (from && to && to < from) throw new BadRequestException('生效结束不能早于生效开始');
  if (data.isDefault === true && status !== 'active') {
    if (existing?.data.isDefault !== true) throw new BadRequestException('只有已启用的版本才能设为默认版本，请先启用');
    data.isDefault = false; // 默认版本被停用/退回草稿后，不再是默认版本
  }
  if (status === 'active' && !str(existing?.data.activatedAt) && !str(data.activatedAt)) data.activatedAt = new Date().toISOString();
}

async function afterVersion({ em, host, user, record }: AfterSaveContext) {
  if (record.data.isDefault !== true) return;
  for (const other of await host.findWhere(em, user.companyId, 'finance-labor-versions', 'isDefault', 'true')) {
    if (other.id !== record.id) await host.patchData(em, user, 'finance-labor-versions', other.id, { isDefault: false }, '另一个版本设为默认，自动取消');
  }
}

// ---------- 归档分类 ----------

async function categoryDepth(em: EntityManager, companyId: number, id: number): Promise<number> {
  let depth = 0;
  let cur: ResourceRecord | null = await rec(em, companyId, 'finance-labor-categories', id);
  while (cur && depth < 10) {
    depth++;
    cur = await rec(em, companyId, 'finance-labor-categories', cur.data.parentId);
  }
  return depth;
}

async function beforeCategory({ em, host, user, existing, data }: BeforeSaveContext) {
  const version = await rec(em, user.companyId, 'finance-labor-versions', data.versionId);
  if (!version) throw new BadRequestException('请选择所属版本');
  if (version.status === 'inactive') throw new BadRequestException('这个版本已停用，不能再改它的归档分类');
  const name = str(data.name).trim();
  if (!name) throw new BadRequestException('请填写分类名称');
  data.name = name;
  if (existing && existing.data.versionId !== data.versionId) throw new BadRequestException('归档分类不能换到别的版本');
  let parentId: number | null = null;
  if (data.parentId !== undefined && data.parentId !== null) {
    const parent = await rec(em, user.companyId, 'finance-labor-categories', data.parentId);
    if (!parent) throw new BadRequestException('上级分类不存在');
    if (parent.data.versionId !== data.versionId) throw new BadRequestException('上级分类必须在同一个版本里');
    if (existing && parent.id === existing.id) throw new BadRequestException('上级分类不能是它自己');
    // 不能挂到自己的下级
    for (let cur: ResourceRecord | null = parent, i = 0; cur && existing && i < 10; i++) {
      if (cur.id === existing.id) throw new BadRequestException('上级分类不能选自己的下级');
      cur = await rec(em, user.companyId, 'finance-labor-categories', cur.data.parentId);
    }
    if ((await categoryDepth(em, user.companyId, parent.id)) + 1 > LABOR_MAX_DEPTH) throw new BadRequestException(`归档分类最多${LABOR_MAX_DEPTH}级`);
    if ((await host.findWhere(em, user.companyId, 'finance-labor-costs', 'archiveCategoryId', parent.id)).length > 0) {
      throw new BadRequestException(`「${parent.title}」下已经有工作项目了，不能再分下级`);
    }
    parentId = parent.id;
  } else {
    data.parentId = undefined;
  }
  if (existing) {
    // 有下级时整棵子树的深度不能超过三级
    const kids = await host.findWhere(em, user.companyId, 'finance-labor-categories', 'parentId', existing.id);
    if (kids.length > 0 && parentId !== null && (await categoryDepth(em, user.companyId, parentId)) + 1 + (await subtreeHeight(host, em, user.companyId, existing.id)) - 1 > LABOR_MAX_DEPTH) {
      throw new BadRequestException(`移动后归档分类会超过${LABOR_MAX_DEPTH}级`);
    }
    if (parentId !== null && (await host.findWhere(em, user.companyId, 'finance-labor-costs', 'archiveCategoryId', existing.id)).length > 0 && kids.length === 0) {
      // 叶子分类带着工作项目移动没问题
    }
  }
  const siblings = (await host.findWhere(em, user.companyId, 'finance-labor-categories', 'versionId', version.id)).filter(
    (c) => c.id !== existing?.id && (num(c.data.parentId) ?? null) === parentId,
  );
  if (siblings.some((c) => norm(c.title) === norm(name))) throw new BadRequestException(`同一级里已经有「${name}」了`);
  const code = cleanCode(str(data.code)) || initials(name) || 'X';
  data.code = code;
  if (siblings.some((c) => cleanCode(str(c.data.code)) === code)) throw new BadRequestException(`同一级里分类标识「${code}」重复了，请换一个`);
}

async function subtreeHeight(host: RuleHost, em: EntityManager, companyId: number, id: number, depth = 0): Promise<number> {
  if (depth > 6) return 1;
  const kids = await host.findWhere(em, companyId, 'finance-labor-categories', 'parentId', id);
  let h = 1;
  for (const k of kids) h = Math.max(h, 1 + (await subtreeHeight(host, em, companyId, k.id, depth + 1)));
  return h;
}

async function categoryPath(em: EntityManager, companyId: number, id: unknown): Promise<ResourceRecord[]> {
  const chain: ResourceRecord[] = [];
  let cur = await rec(em, companyId, 'finance-labor-categories', id);
  for (let i = 0; cur && i < 10; i++) {
    chain.unshift(cur);
    cur = await rec(em, companyId, 'finance-labor-categories', cur.data.parentId);
  }
  return chain;
}

/** 工作编号：RL-版本-归档分类路径-工作分类-工作名称首字母 */
export async function laborWorkCode(em: EntityManager, companyId: number, data: Data): Promise<string> {
  const version = await rec(em, companyId, 'finance-labor-versions', data.versionId);
  const wt = await rec(em, companyId, 'finance-labor-work-types', data.workTypeId);
  const path = await categoryPath(em, companyId, data.archiveCategoryId);
  const parts = ['RL', cleanCode(str(version?.data.versionCode)) || 'V', ...path.map((c) => cleanCode(str(c.data.code)) || 'X'), cleanCode(str(wt?.data.code)) || 'W', initials(str(data.workName)) || 'X'];
  return parts.join('-');
}

async function refreshItemCodes(host: RuleHost, em: EntityManager, user: AuthUser, items: ResourceRecord[]) {
  for (const item of items) {
    const workCode = await laborWorkCode(em, user.companyId, item.data);
    const wt = await rec(em, user.companyId, 'finance-labor-work-types', item.data.workTypeId);
    await host.patchData(em, user, 'finance-labor-costs', item.id, { workCode, label: `${wt?.title ?? ''}/${str(item.data.workName)}`.slice(0, 200) }, '上级名称或编码变了，工作编号同步更新');
  }
}

async function afterCategory({ em, host, user, record, existing }: AfterSaveContext) {
  if (!existing) return;
  if (existing.data.name === record.data.name && existing.data.code === record.data.code && existing.data.parentId === record.data.parentId) return;
  const ids = [record.id];
  for (let n = 0; n < ids.length && ids.length < 500; n++) {
    for (const k of await host.findWhere(em, user.companyId, 'finance-labor-categories', 'parentId', ids[n])) ids.push(k.id);
  }
  for (const id of ids) await refreshItemCodes(host, em, user, await host.findWhere(em, user.companyId, 'finance-labor-costs', 'archiveCategoryId', id));
}

// ---------- 工作分类 / 计价单位 ----------

const beforeDictionary = (label: string) => async ({ data }: BeforeSaveContext) => {
  const name = str(data.name).trim();
  if (!name) throw new BadRequestException(`请填写${label}`);
  data.name = name;
  data.code = cleanCode(str(data.code)) || initials(name) || 'X';
};

async function afterWorkType({ em, host, user, record, existing }: AfterSaveContext) {
  if (!existing || (existing.data.name === record.data.name && existing.data.code === record.data.code)) return;
  await refreshItemCodes(host, em, user, await host.findWhere(em, user.companyId, 'finance-labor-costs', 'workTypeId', record.id));
}

// ---------- 工作项目 ----------

async function beforeItem({ em, host, user, existing, data, status }: BeforeSaveContext) {
  const version = await rec(em, user.companyId, 'finance-labor-versions', data.versionId);
  if (!version) throw new BadRequestException('请选择成本版本');
  const cat = await rec(em, user.companyId, 'finance-labor-categories', data.archiveCategoryId);
  if (!cat) throw new BadRequestException('请选择项目归档分类');
  if (cat.data.versionId !== version.id) throw new BadRequestException('归档分类不属于所选的成本版本');
  if ((await host.findWhere(em, user.companyId, 'finance-labor-categories', 'parentId', cat.id)).length > 0) throw new BadRequestException(`「${cat.title}」还有下级分类，工作项目要放在最末级`);
  const wt = await rec(em, user.companyId, 'finance-labor-work-types', data.workTypeId);
  if (!wt) throw new BadRequestException('请选择工作分类');
  const unit = await rec(em, user.companyId, 'finance-labor-units', data.unitId);
  if (!unit) throw new BadRequestException('请选择计价单位');
  const sameVersionChanged = !existing || existing.data.versionId !== data.versionId;
  if (version.status === 'inactive' && (sameVersionChanged || existing?.data.unitPrice !== data.unitPrice)) throw new BadRequestException('这个成本版本已停用，不能再新增或改价');
  const workName = str(data.workName).trim();
  if (!workName) throw new BadRequestException('请填写工作名称');
  data.workName = workName;
  const price = num(data.unitPrice);
  if (price === null || price < 0) throw new BadRequestException('单位人力成本不能为空，也不能是负数');
  if (price === 0) {
    if (str(data.zeroReason).trim().length < 2) throw new BadRequestException('单位人力成本为 0 时，必须写明零值原因');
    data.zeroReason = str(data.zeroReason).trim();
  } else {
    data.zeroReason = undefined;
  }
  // 查重：同版本、同归档分类、同工作分类、同名
  const dup = (await host.findWhere(em, user.companyId, 'finance-labor-costs', 'versionId', version.id)).find(
    (r) => r.id !== existing?.id && r.data.archiveCategoryId === cat.id && r.data.workTypeId === wt.id && norm(str(r.data.workName)) === norm(workName),
  );
  if (dup) throw new BadRequestException(`这个版本的「${cat.title}」下已经有「${wt.title}」的「${workName}」了（${str(dup.data.workCode)}）`);
  if (existing) {
    const used = await usageCount(host, em, user.companyId, existing.id);
    if (used > 0) {
      if (existing.data.versionId !== data.versionId) throw new BadRequestException(`已被 ${used} 处成品或组合构成使用，不能换成本版本`);
      if (existing.data.unitId !== data.unitId) throw new BadRequestException(`已被 ${used} 处成品或组合构成使用，不能换计价单位（会让已有成本含义变掉）`);
      if (status !== 'active') throw new BadRequestException(`已被 ${used} 处成品或组合构成使用，不能停用；请先把它们改成别的项目`);
    }
  }
  data.workCode = await laborWorkCode(em, user.companyId, data);
  data.label = `${wt.title}/${workName}`.slice(0, 200);
}

export const LABOR_BEFORE_SAVE: Record<string, (ctx: BeforeSaveContext) => Promise<void>> = {
  'finance-labor-versions': beforeVersion,
  'finance-labor-categories': beforeCategory,
  'finance-labor-work-types': beforeDictionary('工作分类名称'),
  'finance-labor-units': beforeDictionary('计价单位'),
  'finance-labor-costs': beforeItem,
};

export const LABOR_AFTER_SAVE: Record<string, (ctx: AfterSaveContext) => Promise<void>> = {
  'finance-labor-versions': afterVersion,
  'finance-labor-categories': afterCategory,
  'finance-labor-work-types': afterWorkType,
};

/** 成品构成行 / 组合构成行用到人工项目时：项目要启用，所在版本也要启用 */
export async function assertLaborUsable(em: EntityManager, companyId: number, labor: ResourceRecord): Promise<void> {
  if (labor.status !== 'active') throw new BadRequestException(`人工项目「${labor.title}」已停用，请选已启用的`);
  const version = await rec(em, companyId, 'finance-labor-versions', labor.data.versionId);
  if (!version) throw new BadRequestException(`人工项目「${labor.title}」没有所属成本版本`);
  if (version.status !== 'active') throw new BadRequestException(`人工项目「${labor.title}」所在的成本版本还没启用（或已停用），不能用于构成`);
}
