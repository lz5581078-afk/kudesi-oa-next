import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';
import { ResourceRecord } from '../entities';

/**
 * 商品档案的几个独立小规则（从旧系统 gift-aliases / buildProductBasicInfoFullName 对照而来）：
 * 赠品简称、赠品编码简称的规范化与跨档案排重，基础信息全称。
 * 放在单独文件里，避免继续撑大 finance-rules.ts。
 */
type Data = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** 只有这三类档案有赠品简称（旧系统 giftArchiveKeys） */
export const GIFT_ARCHIVE_TYPES = ['raw', 'purchased', 'shipping_material'];

const nameKey = (v: string) => v.replace(/\s/g, '').toLocaleLowerCase('zh-CN');

/** 规范化赠品简称/赠品编码简称，并在整个公司的商品档案里排重（名称不分大小写、不计空白）。 */
export async function applyGiftAliases(em: EntityManager, companyId: number, data: Data, selfId: number | null): Promise<void> {
  if (!GIFT_ARCHIVE_TYPES.includes(str(data.archiveType))) {
    delete data.giftShortName;
    delete data.giftCodeShortName;
    return;
  }
  for (const k of ['giftShortName', 'giftCodeShortName']) {
    if (data[k] != null && typeof data[k] !== 'string') throw new BadRequestException('赠品简称和赠品编码简称必须填写文字');
  }
  const name = str(data.giftShortName).normalize('NFKC').trim();
  const code = str(data.giftCodeShortName).normalize('NFKC').trim().toUpperCase();
  if ([...name].length > 40 || /[+×*\u0000-\u001f\u007f]/.test(name)) throw new BadRequestException('赠品简称最多 40 字，不能包含连接符 +、×、* 或换行');
  if (code && !/^[A-Z0-9]{1,20}$/.test(code)) throw new BadRequestException('赠品编码简称只允许 1 至 20 位英文字母和数字');
  data.giftShortName = name || undefined;
  data.giftCodeShortName = code || undefined;
  if (!name && !code) return;
  const rows = await em
    .createQueryBuilder(ResourceRecord, 'r')
    .select(['r.id', 'r.data'])
    .where('r.companyId = :companyId AND r.type = :type AND r.status <> :deleted', { companyId, type: 'finance-products', deleted: 'deleted' })
    .andWhere("(JSON_EXTRACT(r.data, '$.giftShortName') IS NOT NULL OR JSON_EXTRACT(r.data, '$.giftCodeShortName') IS NOT NULL)")
    .getMany();
  for (const r of rows) {
    if (r.id === selfId) continue;
    if (name && str(r.data.giftShortName) && nameKey(str(r.data.giftShortName)) === nameKey(name)) throw new BadRequestException('赠品简称已被其他商品使用，请更换（跨赠品档案排重）');
    if (code && str(r.data.giftCodeShortName).toUpperCase() === code) throw new BadRequestException('赠品编码简称已被其他商品使用，请更换（跨赠品档案排重）');
  }
}

const PRODUCT_DEF = FINANCE_RESOURCE_DEFS.find((d) => d.key === 'finance-products')!;
const optLabel = (key: string, value: unknown) => PRODUCT_DEF.fields.find((f) => f.key === key)?.options?.find((o) => o.value === value)?.label ?? str(value);
const join = (parts: unknown[]) => parts.map((p) => str(p).trim()).filter(Boolean).join('-');

/** 基础信息全称：按档案类型把名称、品牌、规格拼起来（对照旧系统 buildProductBasicInfoFullName）。 */
export function basicInfoFullName(data: Data, brandName: string): string {
  const type = str(data.archiveType);
  const name = str(data.name);
  const qty = typeof data.specQty === 'number' ? String(data.specQty) : '';
  const unit = optLabel('specUnit', data.specUnit);
  if (type === 'package' || type === 'oem_package') {
    const caps = str(data.capacities).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return join([optLabel('packagingCategory', data.packagingCategory) || data.shape, name, brandName, data.dimensions, data.dimensions ? optLabel('dimensionUnit', data.dimensionUnit) : '', ...(caps.length ? caps : qty ? [`${qty}${unit}`] : [])]);
  }
  if (type === 'raw' || type === 'shipping_material') return join([name, qty, unit, data.materialCode]);
  if (type === 'self_made') return join([name, brandName, qty, unit, data.productPackagingSpec]);
  if (type === 'purchased') return join([name, brandName, qty, unit, data.purchaseSpec, data.supplyMode === 'supplier_oem' ? '供应商OEM' : '原装采购']);
  return join([name, brandName, qty, unit, data.shape]);
}
