import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { PRODUCT_UNIT_CODED_KINDS, PRODUCT_UNIT_SEEDS } from '@kudesi/shared';
import { ResourceRecord } from '../entities';
import type { BeforeSaveContext } from './resource-rules';
import { UNIT_RESOURCE } from './unit-options';
import { initials } from './finance-rules';

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** 商品档案里用到这一项的数量：编码类存编码，系统规格存名称（旧系统删除/改编码前的“已被引用”检查） */
export async function productsUsingUnit(em: EntityManager, companyId: number, kind: string, value: string): Promise<number> {
  const col: Record<string, { field: string; extra?: string }> = {
    spec_unit: { field: 'specUnit', extra: "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.archiveType')), '') <> 'shipping_material'" },
    shipping_unit: { field: 'specUnit', extra: "AND JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.archiveType')) = 'shipping_material'" },
    packaging_unit: { field: 'productPackagingUnit' },
    system_spec: { field: 'purchaseSpec' },
    packaging_category: { field: 'packagingCategory' },
    dimension_unit: { field: 'dimensionUnit' },
  };
  const c = col[kind];
  if (!c || !value) return 0;
  return em.createQueryBuilder(ResourceRecord, 'r')
    .where("r.companyId = :c AND r.type = 'finance-products'", { c: companyId })
    .andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${c.field}')) = :v ${c.extra ?? ''}`, { v: value })
    .getCount();
}

/** 常用单位用固定编码（克 G、千克 KG…），其它取名称拼音首字母（对照旧系统 suggestUnitCode） */
function suggestCode(name: string): string {
  const seeded = PRODUCT_UNIT_SEEDS.find((s) => s[1] === name && s[2]);
  if (seeded) return seeded[2];
  return initials(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function beforeUnit(ctx: BeforeSaveContext) {
  const { em, user, data, existing } = ctx;
  const kind = str(data.kind);
  const name = str(data.name).normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!name) throw new BadRequestException('名称必填');
  data.name = name;
  const coded = (PRODUCT_UNIT_CODED_KINDS as readonly string[]).includes(kind);
  if (coded) {
    const code = (str(data.code) || suggestCode(name)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) throw new BadRequestException('编码只能是英文字母和数字，请手动填写');
    data.code = code;
  } else {
    delete data.code; // 系统规格没有编码
  }
  if (!existing) return;
  if (str(existing.data.kind) !== kind) throw new BadRequestException('种类建好后不能改');
  const oldValue = coded ? str(existing.data.code) : str(existing.data.name);
  const newValue = coded ? str(data.code) : name;
  if (oldValue !== newValue && (await productsUsingUnit(em, user.companyId, kind, oldValue)) > 0) {
    throw new BadRequestException(`“${oldValue}”已被商品档案使用，不能改${coded ? '编码' : '名称'}；可以停用后新建一项`);
  }
}

export async function beforeUnitDelete(ctx: { em: EntityManager; user: { companyId: number }; record: ResourceRecord }) {
  const kind = str(ctx.record.data.kind);
  const coded = (PRODUCT_UNIT_CODED_KINDS as readonly string[]).includes(kind);
  const value = coded ? str(ctx.record.data.code) : str(ctx.record.data.name);
  const n = await productsUsingUnit(ctx.em, ctx.user.companyId, kind, value);
  if (n > 0) throw new BadRequestException(`已被 ${n} 个商品档案使用，不能删除；可以改为停用`);
}

export { UNIT_RESOURCE };
