import { BadRequestException } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { pinyin } from 'pinyin-pro';
import { EntityManager } from 'typeorm';
import { getResourceDef, readZeroValueConfirmation, zeroValueContext } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { Company, ResourceRecord } from '../entities';
import type { AfterSaveContext, BeforeSaveContext, RuleHost } from './resource-rules';

/**
 * 人力成本表规则：版本（生效期、默认版本）→ 项目归档分类树（最多三级）→ 工作项目。
 * 工作项目带“工作分类”和“计价单位”两本可维护的字典；工作编号自动生成，上级改名后同步刷新。
 * 被成品构成行、组合构成行引用的人工项目，不能换版本、换单位、停用或删除（删除由通用引用保护拦住）。
 */
type Data = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const rec = (em: EntityManager, companyId: number, type: string, id: unknown, currentRead = false) =>
  typeof id === 'number' ? em.findOne(ResourceRecord, { where: { id, companyId, type }, ...(currentRead ? { lock: { mode: 'pessimistic_read' as const } } : {}) }) : Promise.resolve(null);
const currentRows = (em: EntityManager, companyId: number, type: string, field: string, value: number) => em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :companyId AND r.type = :type', { companyId, type }).andWhere(`JSON_EXTRACT(r.data, '$.${field}') = :value`, { value }).orderBy('r.id', 'ASC').setLock('pessimistic_read').getMany();
async function lockVersion(em: EntityManager, companyId: number, id: unknown) {
  await lockLaborCompany(em, companyId);
  return typeof id === 'number' ? em.findOne(ResourceRecord, { where: { id, companyId, type: 'finance-labor-versions' }, lock: { mode: 'pessimistic_write' } }) : null;
}
const copiedSource = new AsyncLocalStorage<ResourceRecord>();
/** 仅服务端版本复制使用的原事实；不能由请求体开启，也不伪造新的零值确认。 */
export const withLaborCopySource = <T>(source: ResourceRecord, run: () => Promise<T>) => copiedSource.run(source, run);
/** 默认版本变更先锁公司；复制采用同一顺序，再锁来源版本。 */
export async function lockLaborCompany(em: EntityManager, companyId: number): Promise<void> {
  if (!await em.findOne(Company, { where: { id: companyId }, lock: { mode: 'pessimistic_write' } })) throw new BadRequestException('公司不存在');
}

function initials(text: string): string {
  // 整段转换保留词语读音；逐字转换会把“重庆”等多音词拆错。
  const letters = pinyin(text.trim(), { pattern: 'first', toneType: 'none', separator: '' });
  return letters.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
const cleanCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

export const LABOR_MAX_DEPTH = 3;

async function usageCount(host: RuleHost, em: EntityManager, companyId: number, laborId: number): Promise<number> {
  const boms = await currentRows(em, companyId, 'finance-product-boms', 'laborId', laborId);
  const lines = await currentRows(em, companyId, 'finance-bundle-lines', 'laborId', laborId);
  return boms.length + lines.length;
}

// ---------- 版本 ----------

async function beforeVersion({ existing, data, status, em, host, user }: BeforeSaveContext) {
  if (!existing) await lockLaborCompany(em, user.companyId);
  if (!existing && status !== 'draft') throw new BadRequestException('新建成本版本必须从草稿开始');
  if (existing) {
    const fresh = await lockVersion(em, user.companyId, existing.id);
    if (!fresh || fresh.status !== existing.status || JSON.stringify(fresh.data) !== JSON.stringify(existing.data)) throw new BadRequestException('版本资料已变化，请刷新后重试');
    if (existing.status !== 'draft' && ['versionCode', 'versionName', 'periodName', 'effectiveFrom', 'effectiveTo', 'note'].some(key => str(existing.data[key]) !== str(data[key]))) throw new BadRequestException('只有草稿版本可以修改版本资料');
    if (existing.status !== 'draft' && status === 'draft') throw new BadRequestException('已启用或停用的版本不能退回草稿');
    if (existing.status === 'active' && status === 'active' && existing.data.isDefault === true && data.isDefault !== true) throw new BadRequestException('请通过设定其他默认版本或停用版本取消默认');
  }
  const code = str(data.versionCode).trim();
  if (!code) throw new BadRequestException('请填写版本编号');
  data.versionCode = code;
  const from = str(data.effectiveFrom), to = str(data.effectiveTo);
  if (from && to && to < from) throw new BadRequestException('生效结束不能早于生效开始');
  if (status === 'active' && existing && existing.status !== 'active') {
    // 启用版本：至少要有一条启用的项目；启用后自动成为默认版本（原默认版本由保存后规则取消）
    const items = await currentRows(em, user.companyId, 'finance-labor-costs', 'versionId', existing.id);
    if (!items.some((i) => i.status === 'active' && !i.archivedAt)) throw new BadRequestException('至少维护一条启用的人力成本项目后才能启用版本');
    data.isDefault = true;
  }
  if (data.isDefault === true && status !== 'active') {
    if (existing?.data.isDefault !== true) throw new BadRequestException('只有已启用的版本才能设为默认版本，请先启用');
    data.isDefault = false; // 默认版本被停用/退回草稿后，不再是默认版本
  }
  if (status === 'active' && !str(existing?.data.activatedAt) && !str(data.activatedAt)) data.activatedAt = new Date().toISOString();
}

async function afterVersion({ em, host, user, record }: AfterSaveContext) {
  if (record.data.isDefault !== true) return;
  const defaults = await em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :companyId AND r.type = :type', { companyId: user.companyId, type: 'finance-labor-versions' }).andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.isDefault')) = 'true'").orderBy('r.id', 'ASC').setLock('pessimistic_write').getMany();
  for (const other of defaults) {
    if (other.id !== record.id) await host.patchData(em, user, 'finance-labor-versions', other.id, { isDefault: false }, '另一个版本设为默认，自动取消', false, true);
  }
}

// ---------- 归档分类 ----------

async function categoryDepth(em: EntityManager, companyId: number, id: number): Promise<number> {
  let depth = 0;
  let cur: ResourceRecord | null = await rec(em, companyId, 'finance-labor-categories', id, true);
  while (cur && depth < 10) {
    depth++;
    cur = await rec(em, companyId, 'finance-labor-categories', cur.data.parentId, true);
  }
  return depth;
}

async function beforeCategory({ em, host, user, existing, data }: BeforeSaveContext) {
  const version = await lockVersion(em, user.companyId, data.versionId);
  if (!version) throw new BadRequestException('请选择所属版本');
  if (version.archivedAt || !['draft', 'active'].includes(version.status)) throw new BadRequestException('这个版本已停用，不能再改它的归档分类');
  const name = str(data.name).trim();
  if (!name) throw new BadRequestException('请填写分类名称');
  data.name = name;
  if (existing && existing.data.versionId !== data.versionId) throw new BadRequestException('归档分类不能换到别的版本');
  let parentId: number | null = null;
  if (data.parentId !== undefined && data.parentId !== null) {
    const parent = await rec(em, user.companyId, 'finance-labor-categories', data.parentId, true);
    if (!parent) throw new BadRequestException('上级分类不存在');
    if (parent.data.versionId !== data.versionId) throw new BadRequestException('上级分类必须在同一个版本里');
    if (existing && parent.id === existing.id) throw new BadRequestException('上级分类不能是它自己');
    // 不能挂到自己的下级
    for (let cur: ResourceRecord | null = parent, i = 0; cur && existing && i < 10; i++) {
      if (cur.id === existing.id) throw new BadRequestException('上级分类不能选自己的下级');
      cur = await rec(em, user.companyId, 'finance-labor-categories', cur.data.parentId, true);
    }
    if ((await categoryDepth(em, user.companyId, parent.id)) + 1 > LABOR_MAX_DEPTH) throw new BadRequestException(`归档分类最多${LABOR_MAX_DEPTH}级`);
    if ((await currentRows(em, user.companyId, 'finance-labor-costs', 'archiveCategoryId', parent.id)).length > 0) {
      throw new BadRequestException(`「${parent.title}」下已经有工作项目了，不能再分下级`);
    }
    parentId = parent.id;
  } else {
    data.parentId = undefined;
  }
  if (existing) {
    // 有下级时整棵子树的深度不能超过三级
    const kids = await currentRows(em, user.companyId, 'finance-labor-categories', 'parentId', existing.id);
    if (kids.length > 0 && parentId !== null && (await categoryDepth(em, user.companyId, parentId)) + 1 + (await subtreeHeight(host, em, user.companyId, existing.id)) - 1 > LABOR_MAX_DEPTH) {
      throw new BadRequestException(`移动后归档分类会超过${LABOR_MAX_DEPTH}级`);
    }
    if (parentId !== null && (await currentRows(em, user.companyId, 'finance-labor-costs', 'archiveCategoryId', existing.id)).length > 0 && kids.length === 0) {
      // 叶子分类带着工作项目移动没问题
    }
  }
  const siblings = (await currentRows(em, user.companyId, 'finance-labor-categories', 'versionId', version.id)).filter(
    (c) => c.id !== existing?.id && (num(c.data.parentId) ?? null) === parentId,
  );
  if (siblings.some((c) => norm(c.title) === norm(name))) throw new BadRequestException(`同一级里已经有「${name}」了`);
  const code = (initials(str(data.code) || name) || 'FL').slice(0, 40);
  data.code = code;
  if (siblings.some((c) => cleanCode(str(c.data.code)) === code)) throw new BadRequestException(`同一级里分类标识「${code}」重复了，请换一个`);
}

async function subtreeHeight(host: RuleHost, em: EntityManager, companyId: number, id: number, depth = 0): Promise<number> {
  if (depth > 6) return 1;
  const kids = await currentRows(em, companyId, 'finance-labor-categories', 'parentId', id);
  let h = 1;
  for (const k of kids) h = Math.max(h, 1 + (await subtreeHeight(host, em, companyId, k.id, depth + 1)));
  return h;
}

async function categoryPath(em: EntityManager, companyId: number, id: unknown, currentRead = false): Promise<ResourceRecord[]> {
  const chain: ResourceRecord[] = [];
  let cur = await rec(em, companyId, 'finance-labor-categories', id, currentRead);
  for (let i = 0; cur && i < 10; i++) {
    chain.unshift(cur);
    cur = await rec(em, companyId, 'finance-labor-categories', cur.data.parentId, currentRead);
  }
  return chain;
}

/** 工作编号：RL-版本-归档分类路径-工作分类-工作名称首字母 */
export async function laborWorkCode(em: EntityManager, companyId: number, data: Data, excludeId?: number, supplied?: ResourceRecord[], currentRead = false): Promise<string> {
  const version = await rec(em, companyId, 'finance-labor-versions', data.versionId, currentRead);
  const wt = await rec(em, companyId, 'finance-labor-work-types', data.workTypeId, currentRead);
  const path = await categoryPath(em, companyId, data.archiveCategoryId, currentRead);
  const parts = ['RL', initials(str(version?.data.versionCode).trim().replace(/^RL[-_]?/i, '')) || 'V', ...path.map((c) => cleanCode(str(c.data.code)) || 'X'), cleanCode(str(wt?.data.code)) || 'X', initials(str(data.workName)) || 'X'];
  const base = parts.join('-').slice(0, 80);
  const rows = supplied ?? (typeof data.versionId === 'number' ? currentRead ? await currentRows(em, companyId, 'finance-labor-costs', 'versionId', data.versionId) : await em.createQueryBuilder(ResourceRecord, 'r').where('r.companyId = :companyId AND r.type = :type AND r.archivedAt IS NULL', { companyId, type: 'finance-labor-costs' }).andWhere("JSON_EXTRACT(r.data, '$.versionId') = :versionId", { versionId: data.versionId }).getMany() : []);
  const used = new Set(rows.filter(row => row.id !== excludeId && !row.archivedAt).map(row => str(row.data.workCode).toUpperCase()));
  let code = base;
  for (let index = 2; used.has(code); index++) {
    const suffix = `-${index}`;
    code = `${base.slice(0, 80 - suffix.length)}${suffix}`;
  }
  return code;
}

/** 只读编号预览与保存共用生成器；未填项保留占位，但任何已给出的引用必须属于当前公司。 */
export async function previewLaborWorkCode(em: EntityManager, companyId: number, values: Data, excludeId?: number) {
  const references = { versionId: ['finance-labor-versions', '成本版本'], archiveCategoryId: ['finance-labor-categories', '归档分类'], workTypeId: ['finance-labor-work-types', '工作分类'] } as const;
  const allowed = new Set(['workName', ...Object.keys(references)]);
  if (Object.keys(values).some(key => !allowed.has(key))) throw new BadRequestException('编号预览字段不合法');
  if (values.workName !== undefined && (typeof values.workName !== 'string' || values.workName.length > 160)) throw new BadRequestException('工作名称最多160字');
  const data: Data = { workName: values.workName ?? '' };
  const records = new Map<string, ResourceRecord>();
  for (const [field, [type, label]] of Object.entries(references)) {
    const value = values[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new BadRequestException(`${label}不合法`);
    const record = await rec(em, companyId, type, value);
    if (!record || record.archivedAt) throw new BadRequestException(`${label}不存在`);
    data[field] = value; records.set(field, record);
  }
  const version = records.get('versionId'), category = records.get('archiveCategoryId');
  if (version && category && category.data.versionId !== version.id) throw new BadRequestException('归档分类不属于所选成本版本');
  return { code: await laborWorkCode(em, companyId, data, excludeId) };
}

async function refreshItemCodes(host: RuleHost, em: EntityManager, user: AuthUser, items: ResourceRecord[]) {
  for (const item of items) {
    const workCode = await laborWorkCode(em, user.companyId, item.data, item.id, undefined, true);
    const wt = await rec(em, user.companyId, 'finance-labor-work-types', item.data.workTypeId, true);
    await host.patchData(em, user, 'finance-labor-costs', item.id, { workCode, label: `${wt?.title ?? ''}/${str(item.data.workName)}`.slice(0, 200) }, '上级名称或编码变了，工作编号同步更新', false, true);
  }
}

async function afterCategory({ em, host, user, record, existing }: AfterSaveContext) {
  if (!existing) return;
  if (existing.data.name === record.data.name && existing.data.code === record.data.code && existing.data.parentId === record.data.parentId) return;
  const versionId = Number(record.data.versionId);
  const categories = await currentRows(em, user.companyId, 'finance-labor-categories', 'versionId', versionId);
  const children = new Map<number, number[]>();
  for (const category of categories) {
    const parent = Number(category.data.parentId || 0);
    const siblings = children.get(parent) ?? []; siblings.push(category.id); children.set(parent, siblings);
  }
  const ids = [record.id], seen = new Set(ids);
  for (let index = 0; index < ids.length; index++) for (const id of children.get(ids[index]) ?? []) if (!seen.has(id)) { seen.add(id); ids.push(id); }
  const items = (await currentRows(em, user.companyId, 'finance-labor-costs', 'versionId', versionId)).filter(row => seen.has(Number(row.data.archiveCategoryId)) && !row.archivedAt);
  await refreshItemCodes(host, em, user, items);
}

// ---------- 工作分类 / 计价单位 ----------

const beforeDictionary = (label: string, fallback: string) => async ({ data, em, user }: BeforeSaveContext) => {
  await lockLaborCompany(em, user.companyId);
  const name = str(data.name).trim();
  if (!name) throw new BadRequestException(`请填写${label}`);
  data.name = name;
  data.code = (initials(str(data.code) || name) || fallback).slice(0, 40);
};

async function afterWorkType({ em, host, user, record, existing }: AfterSaveContext) {
  if (!existing || (existing.data.name === record.data.name && existing.data.code === record.data.code)) return;
  await refreshItemCodes(host, em, user, await currentRows(em, user.companyId, 'finance-labor-costs', 'workTypeId', record.id));
}

// ---------- 工作项目 ----------

async function beforeItem({ em, host, user, existing, data, status }: BeforeSaveContext) {
  if (existing && existing.data.versionId !== data.versionId) throw new BadRequestException('工作项目不能换成本版本，请复制到其他版本');
  const version = await lockVersion(em, user.companyId, data.versionId);
  if (!version) throw new BadRequestException('请选择成本版本');
  const cat = await rec(em, user.companyId, 'finance-labor-categories', data.archiveCategoryId, true);
  if (!cat) throw new BadRequestException('请选择项目归档分类');
  if (cat.data.versionId !== version.id) throw new BadRequestException('归档分类不属于所选的成本版本');
  if ((await currentRows(em, user.companyId, 'finance-labor-categories', 'parentId', cat.id)).length > 0) throw new BadRequestException(`「${cat.title}」还有下级分类，工作项目要放在最末级`);
  const wt = await rec(em, user.companyId, 'finance-labor-work-types', data.workTypeId, true);
  if (!wt) throw new BadRequestException('请选择工作分类');
  const unit = await rec(em, user.companyId, 'finance-labor-units', data.unitId, true);
  if (!unit) throw new BadRequestException('请选择计价单位');
  if (version.archivedAt || !['draft', 'active'].includes(version.status)) throw new BadRequestException('这个成本版本已停用，不能再新增或修改工作项目');
  const workName = str(data.workName).trim();
  if (!workName) throw new BadRequestException('请填写工作名称');
  data.workName = workName;
  const price = num(data.unitPrice);
  if (price === null || price < 0) throw new BadRequestException('单位人力成本不能为空，也不能是负数');
  const copied = copiedSource.getStore();
  const copyingFact = !existing && copied?.companyId === user.companyId && copied.type === 'finance-labor-costs' && copied.data.unitPrice === price && copied.data.workTypeId === data.workTypeId && copied.data.unitId === data.unitId && str(copied.data.workName).trim() === workName;
  if (price === 0) {
    const confirmation = readZeroValueConfirmation(data.zeroCostConfirmation);
    const context = zeroValueContext(getResourceDef('finance-labor-costs')!.zeroValueConfirmation!, data, { unitId: unit.title, workTypeId: wt.title });
    if (copyingFact) {
      data.zeroReason = copied!.data.zeroReason;
      data.zeroCostConfirmation = undefined;
    } else {
      if (!confirmation || confirmation.context !== context) throw new BadRequestException('单位人力成本为0，请明确确认并填写零值原因；名称、工作分类或计价单位变化后需要重新确认');
      data.zeroReason = confirmation.reason;
      data.zeroCostConfirmation = { ...confirmation, employeeId: user.id, confirmedAt: new Date().toISOString() };
    }
  } else {
    data.zeroReason = undefined;
    data.zeroCostConfirmation = undefined;
  }
  // 原版按同版本的工作名称、工作分类、计价单位查重，与归档目录无关。
  const versionItems = (await currentRows(em, user.companyId, 'finance-labor-costs', 'versionId', version.id)).filter(row => !row.archivedAt);
  const dup = versionItems.find(
    r => r.id !== existing?.id && r.data.workTypeId === wt.id && r.data.unitId === unit.id && str(r.data.workName).trim().toLowerCase() === workName.toLowerCase(),
  );
  if (dup) throw new BadRequestException('当前版本已存在工作名称、工作分类和计价单位完全相同的项目');
  if (existing) {
    const used = await usageCount(host, em, user.companyId, existing.id);
    if (used > 0) {
      if (existing.data.versionId !== data.versionId) throw new BadRequestException(`已被 ${used} 处成品或组合构成使用，不能换成本版本`);
      if (existing.data.unitId !== data.unitId) throw new BadRequestException(`已被 ${used} 处成品或组合构成使用，不能换计价单位（会让已有成本含义变掉）`);
      if (status !== 'active') throw new BadRequestException(`已被 ${used} 处成品或组合构成使用，不能停用；请先把它们改成别的项目`);
    }
  }
  data.workCode = copyingFact && str(copied!.data.workCode) ? copied!.data.workCode : await laborWorkCode(em, user.companyId, data, existing?.id, versionItems, true);
  data.label = `${wt.title}/${workName}`.slice(0, 200);
}

export const LABOR_BEFORE_SAVE: Record<string, (ctx: BeforeSaveContext) => Promise<void>> = {
  'finance-labor-versions': beforeVersion,
  'finance-labor-categories': beforeCategory,
  'finance-labor-work-types': beforeDictionary('工作分类名称', 'FL'),
  'finance-labor-units': beforeDictionary('计价单位', 'UNIT'),
  'finance-labor-costs': beforeItem,
};

export const LABOR_AFTER_SAVE: Record<string, (ctx: AfterSaveContext) => Promise<void>> = {
  'finance-labor-versions': afterVersion,
  'finance-labor-categories': afterCategory,
  'finance-labor-work-types': afterWorkType,
};

/** 删除与新增/编辑锁定同一版本，防止检查后又插入子资料；子删除仍走通用引用校验和日志。 */
export async function beforeLaborDelete(type: string, { em, host, user, record }: { em: EntityManager; host: RuleHost; user: AuthUser; record: ResourceRecord }): Promise<void> {
  const version = await lockVersion(em, user.companyId, type === 'finance-labor-versions' ? record.id : record.data.versionId);
  if (!version || version.archivedAt) throw new BadRequestException('成本版本不存在');
  if (version.status !== 'draft') throw new BadRequestException('只有草稿版本可以删除版本、归档分类或工作项目');
  if (type !== 'finance-labor-versions') return;
  const items = await currentRows(em, user.companyId, 'finance-labor-costs', 'versionId', version.id);
  for (const item of items) await host.removeRecord(em, user, 'finance-labor-costs', item.id, '删除草稿版本及其中工作项目', [], true);
  const categories = await currentRows(em, user.companyId, 'finance-labor-categories', 'versionId', version.id);
  const byId = new Map(categories.map(category => [category.id, category]));
  const depth = (category: ResourceRecord) => { const seen = new Set<number>(); let current: ResourceRecord | undefined = category; while (current && !seen.has(current.id)) { seen.add(current.id); current = byId.get(Number(current.data.parentId)); } return seen.size; };
  categories.sort((a, b) => depth(b) - depth(a) || b.id - a.id);
  for (const category of categories) await host.removeRecord(em, user, 'finance-labor-categories', category.id, '删除草稿版本及其中归档分类', [], true);
}

/** 成品构成行 / 组合构成行用到人工项目时：项目要启用，所在版本也要启用 */
export async function assertLaborUsable(em: EntityManager, companyId: number, labor: ResourceRecord): Promise<void> {
  if (labor.status !== 'active') throw new BadRequestException(`人工项目「${labor.title}」已停用，请选已启用的`);
  const version = await rec(em, companyId, 'finance-labor-versions', labor.data.versionId);
  if (!version) throw new BadRequestException(`人工项目「${labor.title}」没有所属成本版本`);
  if (version.status !== 'active') throw new BadRequestException(`人工项目「${labor.title}」所在的成本版本还没启用（或已停用），不能用于构成`);
}
