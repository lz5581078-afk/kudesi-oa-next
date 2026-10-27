import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { pinyin } from 'pinyin-pro';
import { EntityManager } from 'typeorm';
import { multiplyUnitCents, sumUnitCents, ARCHIVE_TYPE_CODE, FEE_BOOKING_NODE_MAP, createChecker } from '@kudesi/shared';
import { AuthUser } from '../common/auth.decorators';
import { ResourceLink, ResourceRecord } from '../entities';
import { buildSnapshot, aliasCode, rawNames } from './base-code-support';
import { NamingInput, NamingItem, NamingRule, composeBundle, parseFieldList, parseOverrides, validateRule } from './bundle-naming';
import type { AfterSaveContext, BeforeSaveContext, RuleHost } from './resource-rules';
import { EXPRESS_AFTER_SAVE, EXPRESS_BEFORE_SAVE } from './express-rules';
import { assertLaborUsable, LABOR_AFTER_SAVE, LABOR_BEFORE_SAVE } from './labor-rules';

/**
 * 财务资料的专属规则：编码自动生成、成本汇总、验证状态联动、组合编码生成。
 * 规则都在保存记录的同一个事务里执行，任何一步出错整体回滚。
 */

type Data = Record<string, unknown>;
type DeleteCtx = { em: EntityManager; host: RuleHost; user: AuthUser; record: ResourceRecord };

const CODE_RE = /^[A-Z0-9+*]+(-[A-Z0-9+*]+)*$/;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const dstr = (n: number) => String(n).replace('.', 'D');

/** 取拼音首字母（大写）；英文数字原样保留，其它符号去掉。 */
export function initials(text: string): string {
  const out: string[] = [];
  for (const ch of text.normalize('NFKC')) {
    if (/[A-Za-z0-9]/.test(ch)) out.push(ch.toUpperCase());
    else if (/[一-龥]/.test(ch)) out.push(pinyin(ch, { pattern: 'first', toneType: 'none' }).toUpperCase());
  }
  return out.join('');
}

const rec = (em: EntityManager, companyId: number, type: string, id: unknown) =>
  typeof id === 'number' ? em.findOne(ResourceRecord, { where: { id, companyId, type } }) : Promise.resolve(null);

async function categoryChain(em: EntityManager, companyId: number, categoryId: number): Promise<ResourceRecord[]> {
  const chain: ResourceRecord[] = [];
  let cur = await rec(em, companyId, 'finance-categories', categoryId);
  for (let i = 0; cur && i < 8; i++) {
    chain.unshift(cur);
    cur = await rec(em, companyId, 'finance-categories', cur.data.parentId);
  }
  return chain;
}

const FAMILY: Record<string, (data: Data) => string | null> = {
  raw: () => 'raw',
  self_made: () => 'self_made',
  package: () => 'package',
  oem_package: () => 'oem_package',
  shipping_material: () => 'shipping_material',
  purchased: (d) => (d.supplyMode === 'supplier_oem' ? 'supplier_oem' : d.supplyMode === 'original_purchase' ? 'original_purchase' : null),
};

function checkCode(code: string, label: string) {
  if (code.length > 48) throw new BadRequestException(`${label}不能超过 48 位`);
  if (!CODE_RE.test(code)) throw new BadRequestException(`${label}只能用大写字母、数字、+、*，段与段之间用 - 连接`);
}

async function brandCode(em: EntityManager, companyId: number, brandId: unknown): Promise<string> {
  const b = await rec(em, companyId, 'finance-brands', brandId);
  return b ? str(b.data.code) || initials(b.title) : '';
}

// ---------- 保存前 ----------

async function beforeCategory(ctx: BeforeSaveContext) {
  const { em, host, user, data, existing } = ctx;
  data.name = str(data.name).normalize('NFKC').trim().replace(/\s+/g, ' ');
  data.code = str(data.code).toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(str(data.code))) throw new BadRequestException('分类码只能是 1～8 位大写字母或数字');
  const parent = await rec(em, user.companyId, 'finance-categories', data.parentId);
  if (parent) {
    data.archiveType = parent.data.archiveType;
    const chain = await categoryChain(em, user.companyId, parent.id);
    if (chain.length >= 4) throw new BadRequestException('分类最多 4 级');
    if ((await host.findWhere(em, user.companyId, 'finance-products', 'categoryId', parent.id)).length > 0) {
      throw new BadRequestException(`「${parent.title}」下已经挂了商品，不能再建下级分类`);
    }
  }
  if (existing && existing.data.archiveType !== data.archiveType && (await host.findWhere(em, user.companyId, 'finance-products', 'categoryId', existing.id)).length > 0) {
    throw new BadRequestException('这个分类下已有商品，不能改所属类型');
  }
}

async function beforeBrand(ctx: BeforeSaveContext) {
  const { data } = ctx;
  data.code = (str(data.code) || initials(str(data.name))).toUpperCase().slice(0, 8);
}

/** 商品编码：类型段 – (采购:YZ|OEM) – 分类链 – 品牌码 – 名称首字母 – 规格 – 形态 */
async function productCode(ctx: BeforeSaveContext, chain: ResourceRecord[]): Promise<string> {
  const { em, user, data } = ctx;
  const type = str(data.archiveType);
  const parts: string[] = [ARCHIVE_TYPE_CODE[type] ?? 'XX'];
  if (type === 'purchased') parts.push(data.supplyMode === 'supplier_oem' ? 'OEM' : 'YZ');
  const chainCode = chain.map((c) => str(c.data.code)).join('');
  if (chainCode) parts.push(chainCode);
  if (type !== 'raw') {
    const b = await brandCode(em, user.companyId, data.brandId);
    if (b) parts.push(b);
  }
  const ini = initials(str(data.name));
  if (ini) parts.push(ini);
  const qty = num(data.specQty);
  if (qty !== null) parts.push(`${dstr(qty)}${str(data.specUnit)}`);
  if (!['raw', 'self_made', 'purchased', 'package'].includes(type) && data.shape) {
    const sh = initials(str(data.shape));
    if (sh) parts.push(sh);
  }
  return parts.join('-');
}


/** 系统规格换算成克：如“斤”=500、“500克”=500、“2千克”=2000；认不出返回 null。 */
export function systemWeightG(spec: string): number | null {
  const m = spec.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)?\s*(千克|公斤|kg|克|g|斤|j|两|毫克|mg|吨|t)(?:\s*\([^)]*\))?$/i);
  if (!m) return null;
  const f: Record<string, number> = { 千克: 1000, 公斤: 1000, kg: 1000, 克: 1, g: 1, 斤: 500, j: 500, 两: 50, 毫克: 0.001, mg: 0.001, 吨: 1_000_000, t: 1_000_000 };
  return Math.round(Number(m[1] ?? 1) * f[m[2]] * 1e6) / 1e6;
}

/** 规格单位（G/KG/J/T）换算成克，体积、个数类单位返回 null。 */
const UNIT_G: Record<string, number> = { G: 1, KG: 1000, J: 500, T: 1_000_000 };

const FREIGHT_ZERO = [['purchasePrice', '采购价'], ['freight', '运费'], ['handlingFee', '装卸费']] as const;

async function beforeProduct(ctx: BeforeSaveContext) {
  const { em, host, user, data, existing } = ctx;
  const type = str(data.archiveType);
  if (type === 'purchased' && !data.supplyMode) throw new BadRequestException('采购成品请选择采购方式（原装采购 / 供应商 OEM）');
  if (type !== 'purchased') delete data.supplyMode;
  if (data.supplyMode !== 'supplier_oem') delete data.oemPackageWeightG;

  const cat = await rec(em, user.companyId, 'finance-categories', data.categoryId);
  if (!cat) throw new BadRequestException('请选择分类');
  if (cat.status !== 'active') throw new BadRequestException('这个分类已停用');
  if ((await host.findWhere(em, user.companyId, 'finance-categories', 'parentId', cat.id)).length > 0) throw new BadRequestException('必须选最末级分类');
  const need = FAMILY[type]?.(data);
  if (!need || cat.data.archiveType !== need) throw new BadRequestException('分类和档案类型不匹配');
  if (!((num(data.specQty) ?? 0) > 0)) throw new BadRequestException('规格数量必须大于 0');

  const statusChanging = !!existing && existing.status !== ctx.status;
  const canEditCost = createChecker(user.permissions)('product.cost.edit');

  // 品牌：原料、发货物料可不填；自制品、采购成品、OEM 包装必填
  if (['self_made', 'purchased', 'oem_package'].includes(type) && !statusChanging && typeof data.brandId !== 'number') throw new BadRequestException('请选择品牌');
  // 形态/款式要能参与编码
  if (str(data.shape).trim() && !initials(str(data.shape))) throw new BadRequestException('形态/款式里要有字母、数字或汉字，才能参与编码');

  // 重量：自动换算，勾选“人工修正重量”后按填写的为准
  const manual = data.weightManual === true;
  if (type !== 'raw') delete data.purchaseSpec;
  if (type !== 'self_made') delete data.productPackagingSpec;
  if (type === 'raw') {
    const spec = str(data.purchaseSpec).trim();
    if (!spec && !statusChanging) throw new BadRequestException('原料请填写系统规格（如“斤”“500克”）');
    const auto = spec ? systemWeightG(spec) : null;
    if (!manual) {
      if (auto !== null) data.weightG = auto;
      else if (spec && !statusChanging) throw new BadRequestException('系统规格换算不出重量；请勾选“人工修正重量”并填写重量（克）');
    }
  } else if (type !== 'self_made' && !manual) {
    const f = UNIT_G[str(data.specUnit)];
    if (f !== undefined) data.weightG = Math.round((num(data.specQty) ?? 0) * f * 100) / 100;
  }
  if (type === 'raw' || manual) {
    const w = num(data.weightG);
    if (!statusChanging && (w === null || w < 0)) throw new BadRequestException('重量要填一个不小于 0 的数字（克）');
  }
  if (!manual) delete data.weightManual;

  // 包装类专属字段
  if (type !== 'package' && type !== 'oem_package') {
    for (const k of ['packagingCategory', 'dimensions', 'dimensionUnit', 'capacities', 'printingCompany', 'orderStock', 'actualStock']) delete data[k];
  } else if (!statusChanging) {
    if (str(data.dimensions).trim() && !str(data.dimensionUnit)) throw new BadRequestException('填了尺寸，请选择尺寸单位');
    if (!str(data.capacities).split(/\r?\n/).some((x) => x.trim())) throw new BadRequestException('请至少填写一个容量');
    for (const k of ['orderStock', 'actualStock']) if (data[k] !== undefined && (num(data[k]) ?? -1) < 0) throw new BadRequestException('库存不能是负数');
  }

  // 原料成品名（马甲）：最多 100 个，每个 1～160 字，不能重复
  if (type === 'raw' && str(data.rawFinishedNames).trim()) {
    const names = str(data.rawFinishedNames).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (names.length > 100) throw new BadRequestException('成品名最多 100 个');
    if (names.some((x) => x.length > 160)) throw new BadRequestException('每个成品名不能超过 160 个字');
    if (new Set(names.map((x) => x.normalize('NFKC').toLowerCase())).size !== names.length) throw new BadRequestException('成品名里有重复的');
    data.rawFinishedNames = names.join('\n');
  } else if (type !== 'raw') delete data.rawFinishedNames;

  // 运费、装卸费必填（没有就填 0）；0 要逐项写明原因（“运费：自提”）
  if (canEditCost && !statusChanging && type !== 'self_made') {
    for (const k of ['freight', 'handlingFee'] as const) {
      const v = num(data[k]);
      if (v === null && !em.queryRunner?.data.legacyImport) throw new BadRequestException(`请填写${k === 'freight' ? '运费' : '装卸费'}（没有就填 0 并说明原因）`);
      if (v !== null && v < 0) throw new BadRequestException(`${k === 'freight' ? '运费' : '装卸费'}不能是负数`);
    }
  }
  const reasonLines = str(data.zeroValueReason).split(/\r?\n/).map((x) => x.trim());
  for (const [k, label] of FREIGHT_ZERO) {
    if (data[k] === 0 && !reasonLines.some((l) => l.startsWith(label) && l.replace(/^[^：:]*[：:]?/, '').trim())) {
      throw new BadRequestException(`${label}填了 0，请在“零值说明”里单独写一行说明原因，如“${label}：……”`);
    }
  }

  if (em.queryRunner?.data.legacyNotices?.length) data.migrationNotice = em.queryRunner.data.legacyNotices.join('；');

  // 成本：采购价 + 运费 + 装卸费，任何一项缺失则总成本为空；自制品和 OEM 由构成汇总，这里不动
  if (type !== 'self_made' && !(type === 'purchased' && data.supplyMode === 'supplier_oem')) {
    const p = num(data.purchasePrice), f = num(data.freight), h = num(data.handlingFee);
    if (p !== null && f !== null && h !== null) data.totalCost = sumUnitCents([p,f,h]);
    else delete data.totalCost;
  }

  // 编码：留空自动生成；手填则校验格式
  let code = str(data.code).toUpperCase();
  const chain = await categoryChain(em, user.companyId, cat.id);
  if (code) {
    checkCode(code, '商品编码');
  } else {
    const base = await productCode(ctx, chain);
    code = base;
    for (let i = 2; i < 50; i++) {
      const clash = await host.findByUnique(em, user.companyId, 'finance-products', code.toLowerCase());
      if (!clash || clash.id === existing?.id) break;
      code = `${base}-${i}`;
    }
    checkCode(code, '自动生成的商品编码');
  }
  data.code = code;
}

async function beforeBom(ctx: BeforeSaveContext) {
  const { em, host, user, data } = ctx;
  const parent = await rec(em, user.companyId, 'finance-products', data.productId);
  if (!parent) throw new BadRequestException('成品不存在');
  if (!(parent.data.archiveType === 'self_made' || (parent.data.archiveType === 'purchased' && parent.data.supplyMode === 'supplier_oem'))) {
    throw new BadRequestException('只有自制品和供应商 OEM 成品才有构成');
  }
  if (!((num(data.qty) ?? 0) > 0)) throw new BadRequestException('数量必须大于 0');
  if ((num(data.lossPercent) ?? 0) >= 100) throw new BadRequestException('损耗率必须小于 100%');
  const hasLabor = typeof data.laborId === 'number';
  if (hasLabor === (typeof data.componentId === 'number')) throw new BadRequestException('每一行要么选档案组件，要么选人工项目，二选一');
  if (hasLabor) {
    const labor = await rec(em, user.companyId, 'finance-labor-costs', data.laborId);
    if (!labor) throw new BadRequestException('人工项目不存在');
    await assertLaborUsable(em, user.companyId, labor);
    data.lossPercent = undefined;
    data.label = `${parent.title} ← 人工：${labor.title}`.slice(0, 200);
    return;
  }
  const comp = await rec(em, user.companyId, 'finance-products', data.componentId);
  if (!comp) throw new BadRequestException('组件不存在');
  if (parent.id === comp.id) throw new BadRequestException('组件不能是成品自己');
  // 不能成环：从组件往下找，不能再找到成品
  const seen = new Set<number>();
  const stack = [comp.id];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === parent.id) throw new BadRequestException('构成不能成环：组件的构成里已经包含了这个成品');
    if (seen.has(id) || seen.size > 500) continue;
    seen.add(id);
    for (const b of await host.findWhere(em, user.companyId, 'finance-product-boms', 'productId', id)) {
      if (typeof b.data.componentId === 'number') stack.push(b.data.componentId);
    }
  }
  data.label = `${parent.title} ← ${comp.title}`.slice(0, 200);
}

/** 供货来源：只有原料和发货物料有；原料必须填产区；系统规格默认取原料上的。 */
async function beforeSource(ctx: BeforeSaveContext) {
  const { em, user, data } = ctx;
  const p = await rec(em, user.companyId, 'finance-products', data.productId);
  if (!p) throw new BadRequestException('商品档案不存在');
  if (!['raw', 'shipping_material'].includes(str(p.data.archiveType))) throw new BadRequestException('只有原料和发货物料才有供货来源');
  const sup = await rec(em, user.companyId, 'finance-suppliers', data.supplierId);
  if (!sup) throw new BadRequestException('请选择供应商');
  if (p.data.archiveType === 'raw' && !str(data.originArea).trim()) throw new BadRequestException('原料的供货来源要填产区');
  if (!str(data.systemSpec).trim() && p.data.purchaseSpec) data.systemSpec = p.data.purchaseSpec;
  if (data.purchasePrice !== undefined && (num(data.purchasePrice) ?? -1) < 0) throw new BadRequestException('采购价不能是负数');
  data.label = `${p.title} ← ${sup.title}${str(data.originArea) ? `（${str(data.originArea)}）` : ''}`.slice(0, 200);
}

const sig = (...parts: unknown[]) => crypto.createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 24);
const today = () => new Date().toISOString().slice(0, 10);

async function beforeBaseCode(ctx: BeforeSaveContext) {
  const { em, host, user, data, existing, status } = ctx;
  const product = await rec(em, user.companyId, 'finance-products', data.productId);
  if (!product) throw new BadRequestException('请选择来源商品档案');
  if (product.status !== 'active' && !(existing && ['deleted', 'disabled'].includes(status))) throw new BadRequestException('来源商品档案已删除');
  if (!str(data.name)) data.name = product.title;

  // 马甲（别名）：由原料档案的“成品名”自动生成，指向真实编码，编码固定，只能改资料和状态
  if (data.canonicalId !== undefined && data.canonicalId !== null) {
    const real = await rec(em, user.companyId, 'finance-base-codes', data.canonicalId);
    if (!real || real.id === existing?.id) throw new BadRequestException('马甲指向的真实基础编码不存在');
    if (real.data.canonicalId) throw new BadRequestException('马甲不能再指向另一个马甲');
    if (real.data.productId !== product.id) throw new BadRequestException('马甲必须和真实编码来自同一个商品档案');
    if (product.data.archiveType !== 'raw') throw new BadRequestException('只有原料档案才有成品名（马甲）');
    if (!existing) {
      const migrating = em.queryRunner?.data.legacyImport === true;
      const ok = migrating || rawNames(product.data.rawFinishedNames).some((n) => aliasCode(user.companyId, product.id, n) === str(data.code));
      if (!ok) throw new BadRequestException('马甲由原料档案的“成品名（马甲）”自动生成，不能手工新增');
      data.aliasKey = migrating && str(em.queryRunner?.data.legacyAliasName) ? aliasCode(user.companyId, product.id, str(em.queryRunner?.data.legacyAliasName)) : data.code;
      if(migrating){data.migratedAliasName=str(em.queryRunner?.data.legacyAliasName);data.migratedAliasSpec=JSON.stringify([product.data.specQty,product.data.specUnit]);}
      const n = (await host.findWhere(em, user.companyId, 'finance-base-codes', 'canonicalId', real.id)).length;
      if (n >= 100) throw new BadRequestException('一个真实编码最多 100 个马甲');
    } else {
      data.code = existing.data.code;
      data.aliasKey = existing.data.aliasKey;
    }
  } else {
    delete data.canonicalId;
    const dup = (await host.findWhere(em, user.companyId, 'finance-base-codes', 'productId', product.id)).find((r) => r.id !== existing?.id && !r.data.canonicalId && !['disabled', 'deleted'].includes(r.status));
    if (dup) throw new BadRequestException(`这个商品已经有基础编码「${dup.title}」了`);

    // 款式编码 = 分类码链（相邻重复去掉）- 品牌码 - 品种首字母；编码 = 款式编码 - 规格数量+单位
    const chain = await categoryChain(em, user.companyId, Number(product.data.categoryId));
    const brand = product.data.archiveType === 'raw' ? '' : await brandCode(em, user.companyId, product.data.brandId);
    const variety = str(data.varietyName).trim() || str(product.data.name);
    const chainCodes = chain.map((c) => str(c.data.code)).filter((c, i, a) => c && c !== a[i - 1]);
    const generatedStyle = [...chainCodes, brand, initials(variety)].filter(Boolean).join('-');
    const qty = num(product.data.specQty);
    const suffix = qty !== null ? `-${dstr(qty)}${str(product.data.specUnit)}` : '';
    // 旧版把分类码、品牌码、首字母连在一起；碰到旧格式的已存编码，当作自动生成的重新生成
    const legacyStyle = `${chain.map((c) => str(c.data.code)).join('')}${brand}${initials(str(product.data.name))}`;
    const legacyCode = legacyStyle + suffix;
    const reasoned = !!str(data.codeChangeReason).trim();
    const manualStyle = str(data.styleCode).toUpperCase();
    const keepStyle = !!manualStyle && manualStyle !== generatedStyle && manualStyle !== legacyStyle && (reasoned || existing?.data.styleCode === manualStyle);
    if (manualStyle && manualStyle !== generatedStyle && manualStyle !== legacyStyle && !keepStyle) throw new BadRequestException('手改款式编码必须写明原因');
    const style = keepStyle ? manualStyle : generatedStyle;
    if (keepStyle) checkCode(style, '款式编码');
    data.styleCode = style;
    const generated = style + suffix;
    const manual = str(data.code).toUpperCase();
    if (manual && manual !== generated && manual !== legacyCode) {
      checkCode(manual, '基础编码');
      if (!reasoned && !(existing && existing.data.code === manual)) throw new BadRequestException('手改编码必须写明原因');
      data.code = manual;
    } else {
      checkCode(generated, '基础编码');
      data.code = generated;
      if (!keepStyle) delete data.codeChangeReason;
    }
    data.varietyName = str(data.varietyName).trim() || undefined;
    if (!str(data.spec).trim() && qty !== null) data.spec = `${dstr(qty).replace('D', '.')}${str(product.data.specUnit)}`;
  }

  if (status !== 'verified' || existing?.status !== 'verified') {
    data.categoryId = product.data.categoryId;
    data.weightG = product.data.weightG;
    if (product.data.totalCost !== undefined) data.cost = product.data.totalCost;
    else delete data.cost;
  }
  if (status === 'verified' && existing?.status !== 'verified') {
    if (!((num(product.data.weightG) ?? 0) > 0)) throw new BadRequestException('验证前商品档案要填重量（克）');
    if (num(product.data.totalCost) === null) throw new BadRequestException('验证前商品档案要有完整成本（采购价、运费、装卸费）');
    const probe = { id: existing?.id ?? 0, data: { ...data } } as ResourceRecord;
    const { snapshot, issues, signature } = await buildSnapshot(em, user.companyId, probe);
    if (issues.length) {
      const first = issues.slice(0, 3).map((i) => `「${i.archiveName}」${i.message}`).join('；');
      throw new BadRequestException(`验证前请先处理 ${issues.length} 个资料问题：${first}${issues.length > 3 ? ' 等' : ''}`);
    }
    data.snapshot = JSON.stringify(snapshot);
    data.signature = signature;
    data.verifiedAt = today();
    data.categoryId = product.data.categoryId;
    data.weightG = product.data.weightG;
    data.cost = product.data.totalCost;
  }
  if (status !== 'verified') {
    delete data.signature;
    delete data.verifiedAt;
    if (status === 'pending') delete data.snapshot;
  }
}

async function beforeBundle(ctx: BeforeSaveContext) {
  const { em, host, user, data, existing, status } = ctx;
  const platform = await rec(em, user.companyId, 'finance-platforms', data.platformId);
  const scenario = await rec(em, user.companyId, 'finance-scenarios', data.scenarioId);
  if (!platform || !scenario) throw new BadRequestException('请选择销售平台和销售场景');
  data.platformCode = str(platform.data.code).toUpperCase();
  data.configNo = str(data.configNo) || '01';
  data.weightMode = str(data.weightMode) || 'auto';
  if (data.weightMode !== 'manual') delete data.manualWeightG;
  if (data.weightMode === 'manual' && num(data.manualWeightG) === null) throw new BadRequestException('选了手工重量，请填写重量（克）');
  const overridden = data.weightMode === 'manual' || data.manualFreight !== undefined || data.marginOverridePercent !== undefined;
  if (overridden && !str(data.overrideReason).trim()) throw new BadRequestException('手工重量、运费或利润率覆盖必须写明原因');
  const pct = num(data.marginOverridePercent);
  if (pct !== null && pct >= 100) throw new BadRequestException('利润率必须小于 100%');
  if (!str(data.code)) data.code = `ZH-待配置-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  data.updatedAtKey = new Date().toISOString();
  const manuals = ['manualCode', 'manualStyleCode', 'manualName', 'manualShortName'].filter((k) => str(data[k]).trim());
  for (const k of ['manualCode', 'manualStyleCode', 'manualName', 'manualShortName']) if (!str(data[k]).trim()) delete data[k];
  if (manuals.length && !str(data.manualReason).trim()) throw new BadRequestException('手改编码、款式编码、名称或简称必须写明原因');
  if (!manuals.length) delete data.manualReason;
  if (str(data.manualCode)) {
    data.manualCode = str(data.manualCode).trim().toUpperCase();
    checkCode(str(data.manualCode), '手改组合编码');
    if (str(data.manualCode).length > 120) throw new BadRequestException('组合编码不能超过 120 位');
  }

  if (em.queryRunner?.data.legacyImport) {
    for (const [manual, computed] of [['manualCode','code'],['manualName','name'],['manualStyleCode','styleCode'],['manualShortName','shortName']]) {
      if (str(data[manual])) data[computed] = data[manual];
    }
  }
  if (status === 'verified' && existing?.status !== 'verified') {
    if (!existing) throw new BadRequestException('先添加组合构成再验证');
    // 有待发布的构成修订：按修订后的构成验证，验证通过后随之发布
    const revId = num(existing.data.pendingRevisionId);
    const revision = revId ? await rec(em, user.companyId, 'finance-bundle-revisions', revId) : null;
    const currentLines = (await host.findWhere(em, user.companyId, 'finance-bundle-lines', 'bundleId', existing.id)).map((l) => l.data);
    if (revision && revision.status === 'pending' && revision.data.sourceToken !== sig(...currentLines.map(lineKey).sort())) {
      throw new BadRequestException('提交修订之后，组合的构成又被改过了，请取消这份修订后重新提交');
    }
    const lines: Data[] = revision && revision.status === 'pending' ? (JSON.parse(str(revision.data.payload)) as Data[]) : currentLines;
    if (!lines.some((l) => l.role === 'main')) throw new BadRequestException('至少要有一个主品才能验证');
    const parts: string[] = [];
    for (const l of lines) {
      if (l.role === 'labor') { parts.push(`L${l.laborId}:${l.qty}`); continue; }
      const bc = await rec(em, user.companyId, 'finance-base-codes', l.baseCodeId);
      if (!bc || bc.status !== 'verified') throw new BadRequestException(`构成里的基础编码「${bc?.title ?? '已删除'}」还没验证`);
      parts.push(`${l.role}:${bc.id}:${bc.data.signature}:${l.qty}`);
    }
    data.signature = sig(...parts.sort());
    data.snapshot = await bundleSnapshotJson(em, user.companyId, { ...existing.data, ...data }, lines);
    data.verifiedAt = today();
  }
  if (status !== 'verified') {
    delete data.signature;
    delete data.verifiedAt;
    if (status === 'pending') delete data.snapshot;
  }
}

/** 组合验证时的资料快照：编码资料 + 每一行构成（基础编码、数量、重量、成本）。二次验证按它对比。 */
export async function bundleSnapshotJson(em: EntityManager, companyId: number, bundle: Data, lines: Data[]): Promise<string> {
  const out: Data[] = [];
  for (const l of lines) {
    if (l.role === 'labor') { out.push({ role: 'labor', ref: `L${l.laborId}`, qty: l.qty }); continue; }
    const bc = await rec(em, companyId, 'finance-base-codes', l.baseCodeId);
    out.push({ role: l.role, ref: str(bc?.data.code), qty: l.qty, weightG: bc?.data.weightG ?? null, cost: bc?.data.cost ?? null, signature: str(bc?.data.signature) });
  }
  out.sort((a, b) => `${a.role}${a.ref}`.localeCompare(`${b.role}${b.ref}`));
  return JSON.stringify({ profile: { code: str(bundle.code), name: str(bundle.name), styleCode: str(bundle.styleCode), shortName: str(bundle.shortName) }, lines: out });
}

const lineKey = (l: Data) => `${l.role}:${l.role === 'labor' ? `L${l.laborId}` : l.baseCodeId}:${l.qty}`;

async function beforeNamingRule({ em, user, data }: BeforeSaveContext) {
  if (!user.permissions.isCompanyAdmin) throw new BadRequestException('只有公司管理员能改命名规则');
  const cat = await rec(em, user.companyId, 'finance-categories', data.categoryId);
  if (!cat) throw new BadRequestException('请选择适用分类');
  data.scopeKey = `cat:${cat.id}`;
  data.label = `${cat.title} 命名规则`.slice(0, 200);
  data.prefix = str(data.prefix).trim().toUpperCase();
  if (data.stylePrefix) data.stylePrefix = str(data.stylePrefix).trim().toUpperCase();
  if (!str(data.codeFields).trim()) data.codeFields = 'platform,baseCode,scenario';
  if (!str(data.nameFields).trim()) data.nameFields = 'name';
  const err = validateRule({
    prefix: str(data.prefix), stylePrefix: str(data.stylePrefix), namePrefix: str(data.namePrefix), codeFields: parseFieldList(str(data.codeFields)), nameFields: parseFieldList(str(data.nameFields)),
    codeOverrides: str(data.codeOverrides), nameOverrides: str(data.nameOverrides),
  });
  if (err) throw new BadRequestException(err);
  if (parseFieldList(str(data.codeFields)).includes('custom') && !/^[A-Z0-9]{1,12}$/.test(str(data.customCode).toUpperCase())) throw new BadRequestException('编码选了“自定义”，请填 1～12 位大写字母或数字的自定义编码段');
  if (str(data.customCode)) data.customCode = str(data.customCode).toUpperCase();
}

/** 组合构成修订：只能改主品等，赠品必须原样不变；一个组合同时只有一份待发布的修订，随组合验证发布。 */
async function beforeBundleRevision({ em, host, user, data, existing, status }: BeforeSaveContext) {
  const bundle = await rec(em, user.companyId, 'finance-bundles', data.bundleId);
  if (!bundle) throw new BadRequestException('组合不存在');
  if (status === 'published' && existing?.status !== 'published') throw new BadRequestException('构成修订只能随组合验证发布，不能手工改成已发布');
  if (existing && existing.status !== 'pending') throw new BadRequestException('只有待发布的修订能修改或取消');
  if (status === 'cancelled') return;
  if (bundle.status === 'archived') throw new BadRequestException('组合已失效归档，不能再改构成');
  const reason = str(data.reason).trim();
  if (reason.length < 2 || reason.length > 500) throw new BadRequestException('请写明修订原因（2～500 字）');
  data.reason = reason;
  let lines: Data[];
  try { lines = JSON.parse(str(data.payload)) as Data[]; } catch { throw new BadRequestException('新构成的格式不对'); }
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 50) throw new BadRequestException('新构成要有 1～50 行');
  const norm: Data[] = [];
  for (const l of lines) {
    const role = str(l.role);
    if (!(num(l.qty) !== null && (num(l.qty) as number) > 0)) throw new BadRequestException('数量必须大于 0');
    if ((role === 'main' || role === 'gift') && !Number.isInteger(l.qty)) throw new BadRequestException('主品和赠品的数量必须是整数');
    if (role === 'labor') {
      if (!(await rec(em, user.companyId, 'finance-labor-costs', l.laborId))) throw new BadRequestException('请选择人工项目');
      norm.push({ role, laborId: l.laborId, qty: l.qty });
    } else {
      const bc = await rec(em, user.companyId, 'finance-base-codes', l.baseCodeId);
      if (!bc) throw new BadRequestException('请选择基础编码');
      if (bc.status !== 'verified') throw new BadRequestException(`基础编码「${bc.title}」还没验证，验证通过后才能加入组合`);
      norm.push({ role, baseCodeId: bc.id, qty: l.qty });
    }
  }
  if (!norm.some((l) => l.role === 'main')) throw new BadRequestException('至少要有一个主品');
  const current = (await host.findWhere(em, user.companyId, 'finance-bundle-lines', 'bundleId', bundle.id)).map((l) => l.data);
  const gifts = (xs: Data[]) => xs.filter((l) => l.role === 'gift').map(lineKey).sort().join('|');
  if (gifts(current) !== gifts(norm)) throw new BadRequestException('修订不能改赠品（商品、数量必须和现在完全一样）；要换赠品，请新建一个组合');
  const other = (await host.findWhere(em, user.companyId, 'finance-bundle-revisions', 'bundleId', bundle.id)).find((r) => r.status === 'pending' && r.id !== existing?.id);
  if (other) throw new BadRequestException('这个组合已经有一份待发布的修订，请先取消它');
  data.payload = JSON.stringify(norm);
  data.sourceToken = sig(...current.map(lineKey).sort());
  if (!existing) data.createdAtKey = new Date().toISOString();
  data.label = `${bundle.title} 构成修订`.slice(0, 200);
}

async function beforeBundleLine(ctx: BeforeSaveContext) {
  const { em, user, data } = ctx;
  const bundle = await rec(em, user.companyId, 'finance-bundles', data.bundleId);
  if (!bundle) throw new BadRequestException('组合不存在');
  if (bundle.status === 'archived') throw new BadRequestException('组合已失效归档，不能再改构成');
  if (!((num(data.qty) ?? 0) > 0)) throw new BadRequestException('数量必须大于 0');
  const role = str(data.role);
  let name = '';
  if (role === 'labor') {
    const labor = await rec(em, user.companyId, 'finance-labor-costs', data.laborId);
    if (!labor) throw new BadRequestException('请选择人工项目');
    if (!ctx.existing || ctx.existing.data.laborId !== labor.id) await assertLaborUsable(em, user.companyId, labor);
    delete data.baseCodeId;
    name = labor.title;
  } else {
    const bc = await rec(em, user.companyId, 'finance-base-codes', data.baseCodeId);
    if (!bc) throw new BadRequestException('请选择基础编码');
    if (bc.status !== 'verified' && !em.queryRunner?.data.legacyImport) throw new BadRequestException(`基础编码「${bc.title}」还没验证，验证通过后才能加入组合`);
    delete data.laborId;
    name = bc.title;
  }
  if (role === 'main' || role === 'gift') {
    if (!Number.isInteger(num(data.qty))) throw new BadRequestException('主品和赠品的数量必须是整数');
  }
  data.label = `${bundle.title} / ${name}`.slice(0, 200);
}

async function beforeMargin(ctx: BeforeSaveContext) {
  const { em, user, data } = ctx;
  const pct = num(data.profitPercent);
  if (pct !== null && (pct < 0 || pct >= 100)) throw new BadRequestException('利润率必须在 0 到 100% 之间（不含 100）');
  const cat = await rec(em, user.companyId, 'finance-categories', data.categoryId);
  data.scopeKey = cat ? `cat:${cat.id}` : 'all';
  data.label = cat ? `${cat.title} 利润率` : '全部默认利润率';
}

async function beforePackagingScheme({ data }: BeforeSaveContext) {
  const code = str(data.schemeCode).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(code)) throw new BadRequestException('方案编码只能用大写字母、数字、横线');
  data.schemeCode = code;
  const from = str(data.effectiveFrom), to = str(data.effectiveTo);
  if (from && to && to < from) throw new BadRequestException('失效日期不能早于生效日期');
}

async function beforePackagingLine({ em, user, data }: BeforeSaveContext) {
  const scheme = await rec(em, user.companyId, 'finance-packaging-schemes', data.schemeId);
  if (!scheme) throw new BadRequestException('包装方案不存在');
  const p = await rec(em, user.companyId, 'finance-products', data.componentId);
  if (!p) throw new BadRequestException('包装档案不存在');
  if (!['package', 'oem_package'].includes(str(p.data.archiveType))) throw new BadRequestException(`「${p.title}」不是产品包装/OEM 包装档案`);
  if (!((num(data.qty) ?? 0) > 0)) throw new BadRequestException('数量必须大于 0');
  const loss = num(data.lossRate);
  if (loss !== null && (loss < 0 || loss >= 100)) throw new BadRequestException('损耗率必须在 0 到 100% 之间（不含 100）');
  if (!data.costBucket) data.costBucket = str(scheme.data.usageScene) === 'dispatch' ? 'shipping_package' : 'pre_ship_package';
  data.label = `${scheme.title} / ${p.title}`.slice(0, 200);
}

async function beforePackagingRule({ em, user, data }: BeforeSaveContext) {
  const scheme = await rec(em, user.companyId, 'finance-packaging-schemes', data.schemeId);
  if (!scheme) throw new BadRequestException('包装方案不存在');
  const min = num(data.minWeightKg), max = num(data.maxWeightKg);
  if (min !== null && max !== null && max < min) throw new BadRequestException('重量上限不能小于下限');
  const dw = str(data.discreteWeights).trim();
  if (dw && dw.split(/[,，\s]+/).filter(Boolean).some((x) => !(Number(x) > 0))) throw new BadRequestException('指定重量要写成大于 0 的数字，用逗号分隔');
  const pr = num(data.priority);
  if (pr === null || !Number.isInteger(pr) || pr < 0) throw new BadRequestException('优先级要填 0 以上的整数');
  data.targetCode = str(data.targetCode).trim() || undefined;
  data.label = `${scheme.title} 规则 优先级${pr}`.slice(0, 200);
}


/** 自动编号：前缀-三位序号，取现有同前缀编号的最大值 +1（手填的编号不受影响）。 */
async function nextSeqCode(em: EntityManager, companyId: number, type: string, prefix: string): Promise<string> {
  const rows = await em
    .createQueryBuilder(ResourceRecord, 'r')
    .select(['r.id', 'r.data'])
    .where('r.companyId = :companyId AND r.type = :type', { companyId, type })
    .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.code')) LIKE :p", { p: `${prefix}-%` })
    .getMany();
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const r of rows) {
    const m = re.exec(str(r.data.code));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** 供应商/客户：编号自动生成；简称编号默认取拼音首字母。 */
const beforeParty = (prefix: string, type: string) => async (ctx: BeforeSaveContext) => {
  const { data, em, user, existing } = ctx;
  if (!str(data.code).trim()) data.code = existing && str(existing.data.code) ? str(existing.data.code) : await nextSeqCode(em, user.companyId, type, prefix);
  data.code = str(data.code).trim();
  if (!str(data.shortCode).trim()) data.shortCode = initials(str(data.shortName) || str(data.name)).slice(0, 16) || undefined;
  else data.shortCode = str(data.shortCode).trim().toUpperCase();
};

/** 供应商/客户分类树：最多 4 级（和旧系统一致）。 */
const beforePartyCategory = (type: string) => async (ctx: BeforeSaveContext) => {
  const { data, em, user } = ctx;
  let depth = 1;
  let cur = await rec(em, user.companyId, type, data.parentId);
  while (cur && depth < 10) {
    depth++;
    cur = await rec(em, user.companyId, type, cur.data.parentId);
  }
  if (depth > 4) throw new BadRequestException('分类最多 4 级');
  if (ctx.existing && typeof data.parentId === 'number') {
    // 下面已经挂了子分类的，加上自己这一层也不能超过 4 级
    const kids = await ctx.host.findWhere(em, user.companyId, type, 'parentId', ctx.existing.id);
    if (kids.length) {
      const deeper = async (id: number, d: number): Promise<number> => {
        const sub = await ctx.host.findWhere(em, user.companyId, type, 'parentId', id);
        let m = d;
        for (const k of sub) m = Math.max(m, await deeper(k.id, d + 1));
        return m;
      };
      if (depth - 1 + (await deeper(ctx.existing.id, 1)) > 4) throw new BadRequestException('挪过去后下面的分类会超过 4 级');
    }
  }
};

/** 费用档案：编号 FY-nnn；挂账节点规范化；“必须挂对象”由节点推出。 */
async function beforeFeeItem(ctx: BeforeSaveContext) {
  const { data, em, user, existing } = ctx;
  if (!str(data.code).trim()) data.code = existing && str(existing.data.code) ? str(existing.data.code) : await nextSeqCode(em, user.companyId, 'finance-fee-items', 'FY');
  data.code = str(data.code).trim();
  const nodes = [...new Set(str(data.defaultObject).split(/[、,，]/).map((x) => x.trim()).filter((x) => x && x !== '不固定'))];
  const bad = nodes.find((x) => !FEE_BOOKING_NODE_MAP.has(x));
  if (bad) throw new BadRequestException(`挂账节点“${bad}”不存在`);
  data.defaultObject = nodes.length ? nodes.join('、') : '不固定';
  data.requiredObject = nodes.some((n) => n !== '公司') ? 'yes' : 'no';
}

export const FINANCE_BEFORE_SAVE: Record<string, (ctx: BeforeSaveContext) => Promise<void>> = {
  'finance-packaging-schemes': beforePackagingScheme,
  'finance-packaging-lines': beforePackagingLine,
  'finance-packaging-rules': beforePackagingRule,
  'finance-categories': beforeCategory,
  'finance-brands': beforeBrand,
  'finance-suppliers': beforeParty('GYS', 'finance-suppliers'),
  'finance-customers': beforeParty('KH', 'finance-customers'),
  'finance-supplier-categories': beforePartyCategory('finance-supplier-categories'),
  'finance-customer-categories': beforePartyCategory('finance-customer-categories'),
  'finance-fee-items': beforeFeeItem,
  'finance-products': beforeProduct,
  'finance-product-boms': beforeBom,
  'finance-product-sources': beforeSource,
  'finance-base-codes': beforeBaseCode,
  'finance-bundles': beforeBundle,
  'finance-bundle-lines': beforeBundleLine,
  'finance-bundle-naming-rules': beforeNamingRule,
  'finance-bundle-revisions': beforeBundleRevision,
  'finance-margins': beforeMargin,
  ...EXPRESS_BEFORE_SAVE,
  ...LABOR_BEFORE_SAVE,
  'finance-freight-overrides': async ({ data }) => {
    if ((num(data.weightTo) ?? 0) <= (num(data.weightFrom) ?? 0)) throw new BadRequestException('重量段止必须大于起');
    data.label = `${data.weightFrom}-${data.weightTo}kg`;
  },
};

// ---------- 保存后：联动 ----------

/** 商品成本/重量变了：已验证的基础编码要重新验证，用到它们的已验证组合也要重新验证。 */
async function markReverify(host: RuleHost, em: EntityManager, user: AuthUser, productId: number) {
  for (const bc of await host.findWhere(em, user.companyId, 'finance-base-codes', 'productId', productId)) {
    if (bc.status !== 'verified') continue;
    await host.setStatusDirect(em, user, 'finance-base-codes', bc.id, 'reverify', '来源商品的重量或成本变了，需要重新验证');
    await markBundlesOfBaseCode(host, em, user, bc.id);
  }
}

/** 这个商品和所有用到它的上级商品（沿配方往上），已验证的基础编码资料快照变了就要重新验证。 */
async function recheckBaseCodes(host: RuleHost, em: EntityManager, user: AuthUser, productId: number) {
  const ids = new Set<number>();
  const walk = async (id: number, depth: number) => {
    if (ids.has(id) || depth > 10) return;
    ids.add(id);
    for (const b of await host.findWhere(em, user.companyId, 'finance-product-boms', 'componentId', id)) if (typeof b.data.productId === 'number') await walk(b.data.productId, depth + 1);
  };
  await walk(productId, 0);
  for (const id of ids) {
    for (const bc of await host.findWhere(em, user.companyId, 'finance-base-codes', 'productId', id)) {
      if (bc.status !== 'verified' || !bc.data.snapshot) continue;
      const { signature } = await buildSnapshot(em, user.companyId, bc);
      if (signature === bc.data.signature) continue;
      await host.setStatusDirect(em, user, 'finance-base-codes', bc.id, 'reverify', '商品资料有变化，需要重新验证');
      await markBundlesOfBaseCode(host, em, user, bc.id);
    }
  }
}

/** 原料的“成品名（马甲）”生成/更新/删除对应的马甲基础编码。被组合引用或已上传聚水潭的马甲不能删。 */
async function syncAliases(host: RuleHost, em: EntityManager, user: AuthUser, productId: number) {
  const p = await rec(em, user.companyId, 'finance-products', productId);
  if (!p) return;
  const real = (await host.findWhere(em, user.companyId, 'finance-base-codes', 'productId', productId)).find((r) => !r.data.canonicalId && !['disabled', 'deleted'].includes(r.status));
  if (!real) return;
  const names = p.data.archiveType === 'raw' ? rawNames(p.data.rawFinishedNames) : [];
  const have = new Map((await host.findWhere(em, user.companyId, 'finance-base-codes', 'canonicalId', real.id)).map((a) => [str(a.data.aliasKey), a]));
  const qty = num(p.data.specQty);
  const keep = new Set<string>();
  for (const n of names) {
    const code = aliasCode(user.companyId, productId, n);
    keep.add(code);
    const full = [n, qty !== null ? `${dstr(qty).replace('D', '.')}${str(p.data.specUnit)}` : '', str(p.data.code)].filter(Boolean).join('-').slice(0, 200);
    const cur = have.get(code);
    if (!cur) {
      await host.createRecord(em, user, 'finance-base-codes', { productId, code, name: full, canonicalId: real.id }, '由成品名（马甲）自动生成');
    } else if (cur.data.migratedAliasName === n && cur.data.migratedAliasSpec === JSON.stringify([p.data.specQty,p.data.specUnit])) {
      // 旧名称未变、规格未变时保留原展示名；改成本等字段不能重命名马甲。
      continue;
    } else if (str(cur.data.name) !== full) {
      await host.patchData(em, user, 'finance-base-codes', cur.id, { name: full, migratedAliasName: null, migratedAliasSpec: null }, '成品名（马甲）变了');
      if (cur.status === 'verified') await host.setStatusDirect(em, user, 'finance-base-codes', cur.id, 'reverify', '名称变了，需要重新验证');
    }
  }
  for (const [code, a] of have) {
    if (keep.has(code)) continue;
    if (a.data.jstUploadedCode || a.data.jstStatus === 'synced' || a.data.jstStatus === 'pending') throw new BadRequestException(`马甲「${a.title}」已经同步过聚水潭，不能直接去掉；请先在基础编码里处理`);
    if ((await host.findWhere(em, user.companyId, 'finance-bundle-lines', 'baseCodeId', a.id)).length) throw new BadRequestException(`马甲「${a.title}」已被组合引用，不能去掉`);
    await em.delete(ResourceLink, { companyId: user.companyId, sourceId: a.id });
    await em.delete(ResourceRecord, { id: a.id, companyId: user.companyId });
  }
}

async function markBundlesOfBaseCode(host: RuleHost, em: EntityManager, user: AuthUser, baseCodeId: number) {
  const seen = new Set<number>();
  for (const l of await host.findWhere(em, user.companyId, 'finance-bundle-lines', 'baseCodeId', baseCodeId)) {
    const bid = l.data.bundleId;
    if (typeof bid !== 'number' || seen.has(bid)) continue;
    seen.add(bid);
    const b = await rec(em, user.companyId, 'finance-bundles', bid);
    if (b?.status === 'verified') await host.setStatusDirect(em, user, 'finance-bundles', bid, 'reverify', '构成里的基础编码需要重新验证');
  }
}

/**
 * 构成汇总（自制品、供应商 OEM 成品）：
 * 成本 = Σ 数量×(1+损耗)×组件成本（人工行 = 数量×人工单价）+ 运费 + 装卸费（OEM 再加自己的采购价）；
 * 重量 = 自制品 Σ 数量×组件重量；OEM = 商品规格重量 + OEM 包装重量 + 构成里的包装重量；人工修正过的重量不动。
 * 然后向上刷新用到它的成品。
 */
export async function recomputeProduct(host: RuleHost, em: EntityManager, user: AuthUser, productId: number, depth = 0): Promise<void> {
  if (depth > 10) return;
  const p = await rec(em, user.companyId, 'finance-products', productId);
  if (!p) return;
  const isOem = p.data.archiveType === 'purchased' && p.data.supplyMode === 'supplier_oem';
  if (p.data.archiveType === 'self_made' || isOem) {
    const boms = await host.findWhere(em, user.companyId, 'finance-product-boms', 'productId', productId);
    let cost: number | null = boms.length || (isOem && num(p.data.purchasePrice) !== null) ? 0 : null;
    let weight = 0;
    for (const b of boms) {
      const qty = num(b.data.qty) ?? 0;
      if (typeof b.data.laborId === 'number') {
        const lab = await rec(em, user.companyId, 'finance-labor-costs', b.data.laborId);
        const price = lab ? num(lab.data.unitPrice) : null;
        if (cost !== null) cost = price === null ? null : sumUnitCents([cost, multiplyUnitCents(price, qty)]);
        continue;
      }
      const c = await rec(em, user.companyId, 'finance-products', b.data.componentId);
      const ct = c ? num(c.data.totalCost) : null;
      if (cost !== null) cost = ct === null ? null : sumUnitCents([cost, multiplyUnitCents(ct, qty, num(b.data.lossPercent) ?? 0)]);
      weight += qty * (num(c?.data.weightG) ?? 0);
    }
    if (cost !== null) cost = sumUnitCents([cost, isOem ? num(p.data.purchasePrice) ?? 0 : 0, num(p.data.freight) ?? 0, num(p.data.handlingFee) ?? 0]);
    let weightG = p.data.weightG;
    if (p.data.weightManual !== true) {
      if (isOem) {
        const base = (UNIT_G[str(p.data.specUnit)] ?? 0) * (num(p.data.specQty) ?? 0);
        weightG = Math.round((base + (num(p.data.oemPackageWeightG) ?? 0) + weight) * 100) / 100;
      } else if (boms.length) weightG = Math.round(weight * 100) / 100;
    }
    const patch: Data = { totalCost: cost, weightG };
    const changed = patch.totalCost !== (p.data.totalCost ?? null) || patch.weightG !== p.data.weightG;
    await host.patchData(em, user, 'finance-products', productId, patch, '构成变化，自动汇总成本和重量');
    if (changed) await markReverify(host, em, user, productId);
  }
  for (const parentBom of await host.findWhere(em, user.companyId, 'finance-product-boms', 'componentId', productId)) {
    if (typeof parentBom.data.productId === 'number') await recomputeProduct(host, em, user, parentBom.data.productId, depth + 1);
  }
}

/** 原料/发货物料的当前采购价和供应商 = 最近更新的启用供货来源。 */
export async function refreshFromSources(host: RuleHost, em: EntityManager, user: AuthUser, productId: number) {
  const p = await rec(em, user.companyId, 'finance-products', productId);
  if (!p || !['raw', 'shipping_material'].includes(str(p.data.archiveType))) return;
  const live = (await host.findWhere(em, user.companyId, 'finance-product-sources', 'productId', productId)).filter((x) => x.status === 'active');
  live.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.data.legacySourceId && b.data.legacySourceId ? Number(BigInt(str(b.data.legacySourceId))-BigInt(str(a.data.legacySourceId))) : b.id - a.id));
  const cur = live[0];
  const price = cur ? num(cur.data.purchasePrice) : null;
  const f = num(p.data.freight), h = num(p.data.handlingFee);
  const patch: Data = { purchasePrice: price, supplierId: cur ? cur.data.supplierId : null, totalCost: price !== null && f !== null && h !== null ? sumUnitCents([price,f,h]) : null };
  await host.patchData(em, user, 'finance-products', productId, patch, '供货来源变化，更新当前采购价');
}

/** 正在发布构成修订的组合：这期间构成变化不再把它打回“需重新验证” */
const publishing = new Set<number>();
/** 正在批量建构成行的组合：行建完之前不要逐行刷新编码（否则中间状态“只有第一个主品”的编码可能撞上别的组合） */
const deferred = new Set<number>();

/** 先把所有构成行建好，最后一次性刷新编码和名称。 */
export async function buildBundleLines(host: RuleHost, em: EntityManager, user: AuthUser, bundleId: number, build: () => Promise<void>): Promise<void> {
  deferred.add(bundleId);
  try { await build(); } finally { deferred.delete(bundleId); }
  await refreshBundle(host, em, user, bundleId);
}

async function namingItem(em: EntityManager, companyId: number, bc: ResourceRecord, qty: number): Promise<NamingItem> {
  const p = await rec(em, companyId, 'finance-products', bc.data.productId);
  const chain = await categoryChain(em, companyId, Number(p?.data.categoryId));
  const brand = await rec(em, companyId, 'finance-brands', p?.data.brandId);
  const variety = str(bc.data.varietyName) || str(p?.data.name);
  return {
    code: str(bc.data.code), name: str(bc.data.name) || bc.title, shortName: str(bc.data.shortName), styleCode: str(bc.data.styleCode), spec: str(bc.data.spec), qty,
    categoryCode: chain.map((c) => str(c.data.code)).filter((c, i, a) => c && c !== a[i - 1]).join('-'), categoryName: chain.map((c) => c.title).join('/'),
    brandCode: brand ? str(brand.data.code) || initials(brand.title) : '', brandName: brand?.title ?? '',
    varietyInitials: initials(variety), varietyName: variety, packageType: str(p?.data.shape), supplyMode: p?.data.supplyMode === 'supplier_oem' ? 'OEM' : p?.data.supplyMode === 'original_purchase' ? 'YZ' : '',
    weightG: num(bc.data.weightG) ?? num(p?.data.weightG) ?? 0,
  };
}

/** 主品所在分类往上找命名规则：自己没有就用上级的 */
export async function findNamingRule(host: RuleHost, em: EntityManager, companyId: number, categoryId: unknown): Promise<NamingRule | null> {
  const chain = await categoryChain(em, companyId, Number(categoryId));
  for (const c of [...chain].reverse()) {
    const r = await host.findByUnique(em, companyId, 'finance-bundle-naming-rules', `cat:${c.id}`);
    if (r) {
      const d = r.data;
      return {
        prefix: str(d.prefix), namePrefix: str(d.namePrefix), stylePrefix: str(d.stylePrefix), codeFields: parseFieldList(str(d.codeFields)), nameFields: parseFieldList(str(d.nameFields)),
        customCode: str(d.customCode), customName: str(d.customName), codeOverrides: parseOverrides(str(d.codeOverrides)), nameOverrides: parseOverrides(str(d.nameOverrides)),
      };
    }
  }
  return null;
}

export async function namingInputFor(em: EntityManager, companyId: number, mainsIn: { bc: ResourceRecord; qty: number }[], giftsIn: { bc: ResourceRecord; qty: number }[], platform: ResourceRecord | null, scenario: ResourceRecord | null, configNo: string): Promise<NamingInput> {
  return {
    mains: await Promise.all(mainsIn.map((m) => namingItem(em, companyId, m.bc, m.qty))),
    gifts: await Promise.all(giftsIn.map((m) => namingItem(em, companyId, m.bc, m.qty))),
    platformCode: str(platform?.data.code), platformName: platform?.title ?? '', scenarioSegment: str(scenario?.data.segment), scenarioName: scenario?.title ?? '', configNo,
  };
}

/** 按构成重新生成组合编码和名称；已验证的组合构成一变就要重新验证。 */
export async function refreshBundle(host: RuleHost, em: EntityManager, user: AuthUser, bundleId: number): Promise<void> {
  if (deferred.has(bundleId)) return;
  const bundle = await rec(em, user.companyId, 'finance-bundles', bundleId);
  if (!bundle) return;
  const platform = await rec(em, user.companyId, 'finance-platforms', bundle.data.platformId);
  const scenario = await rec(em, user.companyId, 'finance-scenarios', bundle.data.scenarioId);
  const lines = (await host.findWhere(em, user.companyId, 'finance-bundle-lines', 'bundleId', bundleId)).sort((a, b) => a.id - b.id);
  const merge = async (roles: string[]) => {
    const acc = new Map<number, { bc: ResourceRecord; qty: number }>();
    for (const l of lines) {
      if (!roles.includes(str(l.data.role)) || typeof l.data.baseCodeId !== 'number') continue;
      const bc = await rec(em, user.companyId, 'finance-base-codes', l.data.baseCodeId);
      if (!bc) continue;
      const cur = acc.get(bc.id) ?? { bc, qty: 0 };
      cur.qty += num(l.data.qty) ?? 0;
      acc.set(bc.id, cur);
    }
    return [...acc.values()];
  };
  const mains = await merge(['main']);
  const gifts = await merge(['gift']);
  if (mains.length === 0) return; // 还没有主品：保持占位编码
  const input = await namingInputFor(em, user.companyId, mains, gifts, platform, scenario, str(bundle.data.configNo));
  const rule = await findNamingRule(host, em, user.companyId, (await rec(em, user.companyId, 'finance-products', mains[0].bc.data.productId))?.data.categoryId);
  const composed = composeBundle(rule, input);
  const code = str(bundle.data.manualCode).trim().toUpperCase() || composed.code;
  if (code.length > 120) throw new BadRequestException('组合编码太长了（超过 120 位），请减少主品或赠品');
  const name = str(bundle.data.manualName).trim() || composed.name;
  if (await em.findOne(ResourceRecord, { where: { companyId: user.companyId, type: 'finance-base-codes', uniqueKey: code.toLowerCase() } })) {
    throw new BadRequestException(`组合编码「${code}」和某个基础编码重复`);
  }
  await host.patchData(em, user, 'finance-bundles', bundleId, {
    code, name, styleCode: str(bundle.data.manualStyleCode).trim() || composed.styleCode || undefined, shortName: str(bundle.data.manualShortName).trim() || composed.shortName,
    updatedAtKey: new Date().toISOString(),
  }, '按构成重新生成编码');
  if (bundle.status === 'verified' && !publishing.has(bundleId)) await host.setStatusDirect(em, user, 'finance-bundles', bundleId, 'reverify', '构成变了，需要重新验证');
}

/** 发布待生效的构成修订：用新构成替换旧构成（赠品必须原样不变，发布前已校验）。 */
async function publishRevision(host: RuleHost, em: EntityManager, user: AuthUser, bundleId: number, revisionId: number) {
  const revision = await rec(em, user.companyId, 'finance-bundle-revisions', revisionId);
  if (!revision || revision.status !== 'pending') return;
  publishing.add(bundleId);
  try {
    for (const l of await host.findWhere(em, user.companyId, 'finance-bundle-lines', 'bundleId', bundleId)) {
      await em.delete(ResourceLink, { companyId: user.companyId, sourceId: l.id });
      await em.delete(ResourceRecord, { id: l.id, companyId: user.companyId });
    }
    for (const l of JSON.parse(str(revision.data.payload)) as Data[]) {
      await host.createRecord(em, user, 'finance-bundle-lines', { bundleId, role: l.role, baseCodeId: l.baseCodeId, laborId: l.laborId, qty: l.qty }, '发布构成修订');
    }
    await refreshBundle(host, em, user, bundleId);
    const fresh = await rec(em, user.companyId, 'finance-bundles', bundleId);
    const newLines = (await host.findWhere(em, user.companyId, 'finance-bundle-lines', 'bundleId', bundleId)).map((l) => l.data);
    await host.patchData(em, user, 'finance-bundles', bundleId, { pendingRevisionId: null, snapshot: fresh ? await bundleSnapshotJson(em, user.companyId, fresh.data, newLines) : undefined }, '构成修订已发布');
    await host.setStatusDirect(em, user, 'finance-bundle-revisions', revisionId, 'published', '随组合验证发布');
  } finally {
    publishing.delete(bundleId);
  }
}

export const FINANCE_AFTER_SAVE: Record<string, (ctx: AfterSaveContext) => Promise<void>> = {
  ...LABOR_AFTER_SAVE,
  ...EXPRESS_AFTER_SAVE,
  'finance-labor-costs': async (ctx) => {
    const { em, host, user, record, existing } = ctx;
    if (!existing || existing.data.unitPrice === record.data.unitPrice) return;
    // 人工单价变了：用到它的成品重新汇总成本，用到它的组合重新生成并要求重新验证
    const seenProducts = new Set<number>();
    for (const b of await host.findWhere(em, user.companyId, 'finance-product-boms', 'laborId', record.id)) {
      if (typeof b.data.productId === 'number' && !seenProducts.has(b.data.productId)) {
        seenProducts.add(b.data.productId);
        await recomputeProduct(host, em, user, b.data.productId);
      }
    }
    const seenBundles = new Set<number>();
    for (const l of await host.findWhere(em, user.companyId, 'finance-bundle-lines', 'laborId', record.id)) {
      const bid = l.data.bundleId;
      if (typeof bid !== 'number' || seenBundles.has(bid)) continue;
      seenBundles.add(bid);
      await refreshBundle(host, em, user, bid);
    }
  },
  'finance-product-sources': async ({ em, host, user, record, existing }) => {
    if (em.queryRunner?.data.legacyImport) return;
    if (typeof record.data.productId === 'number') await refreshFromSources(host, em, user, record.data.productId);
    if (existing && typeof existing.data.productId === 'number' && existing.data.productId !== record.data.productId) await refreshFromSources(host, em, user, existing.data.productId);
  },
  'finance-product-boms': async ({ em, host, user, record }) => {
    if (typeof record.data.productId === 'number') {
      await recomputeProduct(host, em, user, record.data.productId);
      await recheckBaseCodes(host, em, user, record.data.productId);
    }
  },
  'finance-products': async ({ em, host, user, record, existing }) => {
    if (existing && !em.queryRunner?.data.legacyImport) await syncAliases(host, em, user, record.id);
    const changed = existing && (existing.data.weightG !== record.data.weightG || existing.data.totalCost !== record.data.totalCost);
    if (changed) await markReverify(host, em, user, record.id);
    if (existing && (record.data.archiveType === 'self_made' || (record.data.archiveType === 'purchased' && record.data.supplyMode === 'supplier_oem'))) await recomputeProduct(host, em, user, record.id);
    else if (existing) {
      // 成本变了，用到它的自制品要重新汇总
      for (const b of await host.findWhere(em, user.companyId, 'finance-product-boms', 'componentId', record.id)) {
        if (typeof b.data.productId === 'number') await recomputeProduct(host, em, user, b.data.productId);
      }
    }
    if (existing) await recheckBaseCodes(host, em, user, record.id);
  },
  'finance-base-codes': async ({ em, host, user, record, existing }) => {
    if (!existing) {
      if (!em.queryRunner?.data.legacyImport && !record.data.canonicalId && typeof record.data.productId === 'number') await syncAliases(host, em, user, record.data.productId);
      return;
    }
    // 已验证的基础编码，自己的资料（名称、简称、规格、款式编码、品种）改了也要重新验证
    if (record.status === 'verified' && existing.status === 'verified' && record.data.snapshot) {
      const { signature } = await buildSnapshot(em, user.companyId, record);
      if (signature !== record.data.signature) {
        await host.setStatusDirect(em, user, 'finance-base-codes', record.id, 'reverify', '基础编码资料变了，需要重新验证');
        await markBundlesOfBaseCode(host, em, user, record.id);
      }
    }
    if (existing.status === 'verified' && record.status !== 'verified') await markBundlesOfBaseCode(host, em, user, record.id);
    if (existing.data.code !== record.data.code || existing.data.name !== record.data.name) {
      const seen = new Set<number>();
      for (const l of await host.findWhere(em, user.companyId, 'finance-bundle-lines', 'baseCodeId', record.id)) {
        if (typeof l.data.bundleId === 'number' && !seen.has(l.data.bundleId)) {
          seen.add(l.data.bundleId);
          await refreshBundle(host, em, user, l.data.bundleId);
        }
      }
    }
  },
  'finance-bundle-lines': async ({ em, host, user, record }) => {
    if (typeof record.data.bundleId === 'number') await refreshBundle(host, em, user, record.data.bundleId);
  },
  'finance-bundle-revisions': async ({ em, host, user, record, existing }) => {
    const bundleId = record.data.bundleId;
    if (typeof bundleId !== 'number') return;
    if (record.status === 'cancelled') {
      await host.patchData(em, user, 'finance-bundles', bundleId, { pendingRevisionId: null }, '构成修订已取消');
    } else if (record.status === 'pending' && !existing) {
      await host.patchData(em, user, 'finance-bundles', bundleId, { pendingRevisionId: record.id }, '提交了构成修订');
      const b = await rec(em, user.companyId, 'finance-bundles', bundleId);
      if (b?.status === 'verified') await host.setStatusDirect(em, user, 'finance-bundles', bundleId, 'reverify', '有构成修订待验证发布');
    }
  },
  'finance-bundles': async ({ em, host, user, record, existing }) => {
    const revId = num(record.data.pendingRevisionId);
    if (existing && existing.status !== 'verified' && record.status === 'verified' && revId) {
      await publishRevision(host, em, user, record.id, revId);
      return;
    }
    // 手改项变了，也要重新生成
    const manualChanged = existing && ['manualCode', 'manualStyleCode', 'manualName', 'manualShortName'].some((k) => str(existing.data[k]) !== str(record.data[k]));
    if (manualChanged) await refreshBundle(host, em, user, record.id);
    // 平台/场景/配置号变了，重新生成编码
    if (existing && (existing.data.platformId !== record.data.platformId || existing.data.scenarioId !== record.data.scenarioId || existing.data.configNo !== record.data.configNo)) {
      await refreshBundle(host, em, user, record.id);
    }
  },
};

export const FINANCE_AFTER_DELETE: Record<string, (ctx: DeleteCtx) => Promise<void>> = {
  'finance-product-sources': async ({ em, host, user, record }) => {
    if (typeof record.data.productId === 'number') await refreshFromSources(host, em, user, record.data.productId);
  },
  'finance-product-boms': async ({ em, host, user, record }) => {
    if (typeof record.data.productId === 'number') {
      await recomputeProduct(host, em, user, record.data.productId);
      await recheckBaseCodes(host, em, user, record.data.productId);
    }
  },
  'finance-bundle-lines': async ({ em, host, user, record }) => {
    if (typeof record.data.bundleId === 'number') {
      await refreshBundle(host, em, user, record.data.bundleId);
      const b = await rec(em, user.companyId, 'finance-bundles', record.data.bundleId);
      if (b?.status === 'verified') await host.setStatusDirect(em, user, 'finance-bundles', b.id, 'reverify', '构成变了，需要重新验证');
    }
  },
};
