import {lockSourceUnitCompany,materializeSourceUnits} from './source-unit-form';
import {bomUnitReferences} from './bom-unit-references';
import {sourceUnitCode} from './finance-dictionary-codes';
import {trustedResourceImport} from './resource-import-capability';
import { packagingCapacities } from './packaging-capacities';
import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { CATEGORY_ROOTS, PRODUCT_UNIT_CODED_KINDS, PRODUCT_UNIT_SEEDS } from '@kudesi/shared';
import { ResourceRecord } from '../entities';
import type { BeforeSaveContext } from './resource-rules';
import { loadUnitLists, UNIT_RESOURCE } from './unit-options';
import { initials } from './finance-rules';

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/** 商品档案里用到这一项的数量：编码类存编码，系统规格存名称（旧系统删除/改编码前的“已被引用”检查） */
export async function productsUsingUnit(em: EntityManager, companyId: number, kind: string, value: string): Promise<number> {
  const col: Record<string, { field: string; extra?: string }> = {
    archive_unit:{field:'specUnit',extra:"AND JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.unitDictionaryKind')) = 'archive_unit'"},
    spec_unit: { field: 'specUnit', extra: "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.archiveType')), '') <> 'shipping_material' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.unitDictionaryKind')), '') <> 'archive_unit'" },
    shipping_unit: { field: 'specUnit', extra: "AND JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.archiveType')) = 'shipping_material' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.unitDictionaryKind')), '') <> 'archive_unit'" },
    packaging_unit: { field: 'productPackagingUnit' },
    system_spec: { field: 'purchaseSpec' },
    packaging_category: { field: 'packagingCategory' },
    dimension_unit: { field: 'dimensionUnit' },
    archive_type: { field: 'archiveType' },
  };
  const c = col[kind];
  if (!c || !value) return 0;
  const products = await em.createQueryBuilder(ResourceRecord, 'r')
    .where("r.companyId = :c AND r.type = 'finance-products'", { c: companyId })
    .andWhere(`JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.${c.field}')) = :v ${c.extra ?? ''}`, { v: value })
    .getCount();
  if (!['archive_unit','spec_unit', 'shipping_unit'].includes(kind)) return products;
  const codes=kind==='spec_unit' ? await em.createQueryBuilder(ResourceRecord,'r').where("r.companyId=:c AND r.type='finance-base-codes'",{c:companyId}).andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.codeSpecUnit')) = :v",{v:value}).getCount() : 0;
  const baseLines=kind==='archive_unit' ? await em.createQueryBuilder(ResourceRecord,'r').where("r.companyId=:c AND r.type='finance-base-code-lines'",{c:companyId}).andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data,'$.unit')) = :v",{v:value}).getCount() : 0;
  const lines = kind==='archive_unit' ? 0 : await em.createQueryBuilder(ResourceRecord, 'r')
    .where("r.companyId = :c AND r.type = 'finance-bundle-lines'", { c: companyId })
    .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.unit')) = :v", { v: value }).getCount();
  let capacityProducts = 0;
  if (kind === 'spec_unit') {
    const units = await loadUnitLists(em, companyId);
    const packaging = await em.createQueryBuilder(ResourceRecord, 'r').select(['r.id', 'r.data'])
      .where("r.companyId = :c AND r.type = 'finance-products'", { c: companyId })
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.archiveType')) IN ('package','oem_package')").getMany();
    capacityProducts = packaging.filter(row => String(row.data.specUnit ?? '') !== value && packagingCapacities(row.data.capacities, units).some(capacity => (capacity.code || capacity.unit) === value)).length;
  }
  const history=await bomUnitReferences(em,companyId,value);if(history.unknown)throw new BadRequestException('历史BOM单位记录不完整，请先核对后再更改或删除单位');
  return products + lines + capacityProducts + codes + baseLines+history.count;
}

/** 常用单位用固定编码（克 G、千克 KG…），其它取名称拼音首字母（对照旧系统 suggestUnitCode） */
const KEEP_CASE = ['packaging_category', 'dimension_unit'];

function suggestCode(name: string, kind: string): string {
  if(['spec_unit','archive_unit','shipping_unit','packaging_unit'].includes(kind))return sourceUnitCode(name);
  const seeded = PRODUCT_UNIT_SEEDS.find((s) => s[0] === kind && s[1] === name && s[2]);
  if (seeded) return seeded[2];
  const seededAny = PRODUCT_UNIT_SEEDS.find((s) => s[1] === name && s[2] && !KEEP_CASE.includes(s[0]));
  if (seededAny && !KEEP_CASE.includes(kind)) return seededAny[2];
  return initials(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function beforeUnit(ctx: BeforeSaveContext) {
  const { em, user, data, existing } = ctx;
  await lockSourceUnitCompany(em,user.companyId);
  const kind = str(data.kind);
  const name = str(data.name).normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!name) throw new BadRequestException('名称必填');
  if((!existing||name!==str(existing.data.name))&&name.length>(kind==='spec_unit'?160:80))throw new BadRequestException('名称超过本类字典允许长度');
  data.name = name;
  const coded = (PRODUCT_UNIT_CODED_KINDS as readonly string[]).includes(kind);
  if(existing&&coded&&!str(existing.data.code)&&!Object.prototype.hasOwnProperty.call(ctx.input??{},'code')){if(str(existing.data.kind)!==kind)throw new BadRequestException('种类建好后不能改');data.code=existing.data.code;return;}
  if (coded) {
    // 单位编码一律大写（旧系统规则）；包装类别、尺寸单位保留原有大小写（bag、cm 这类内置编码已在商品里用着）
    const supplied=str(data.code),sameCode=!!existing&&supplied===str(existing.data.code);
    if(existing&&!supplied&&Object.prototype.hasOwnProperty.call(ctx.input??{},'code'))throw new BadRequestException('已有单位编码不能为空');
    const raw=sameCode?supplied:(supplied||(!existing?suggestCode(name,kind):str(existing?.data.code))).replace(trustedResourceImport(em,user,'dictionaries')&&kind==='spec_unit'?/[^A-Za-z0-9+*]/g:/[^A-Za-z0-9]/g,'');
    const code=sameCode?supplied:KEEP_CASE.includes(kind)?raw:raw.toUpperCase();
    const imported=kind==='spec_unit'&&(trustedResourceImport(em,user,'dictionaries')||em.queryRunner?.data.legacyImport===true);
    if(code.length>(kind==='spec_unit'?48:32))throw new BadRequestException('编码超过本类字典允许长度');
    if(!sameCode&&!(imported?/^[A-Z0-9+*]+$/:KEEP_CASE.includes(kind)?/^[A-Za-z0-9]+$/:/^[A-Z0-9]+$/).test(code))throw new BadRequestException('编码只能是英文字母和数字，请手动填写');
    // 自定义档案类型的编码就是商品里存的“档案类型”取值，不能和内置类型（raw、package…）重名（比较不分大小写）
    if (kind === 'archive_type' && CATEGORY_ROOTS.some((r) => r.value.toLowerCase() === code.toLowerCase())) throw new BadRequestException(`编码「${code}」和内置档案类型重名，请换一个`);
    data.code = code;
  } else {
    delete data.code; // 系统规格没有编码
  }
  await materializeSourceUnits(ctx);
  if (!existing) return;
  if (str(existing.data.kind) !== kind) throw new BadRequestException('种类建好后不能改');
  const oldValue = coded ? str(existing.data.code) : str(existing.data.name);
  const newValue = coded ? str(data.code) : name;
  if (oldValue !== newValue && (await productsUsingUnit(em, user.companyId, kind, oldValue)) > 0) {
    throw new BadRequestException(`“${oldValue}”已被商品档案使用或被组合构成引用，不能改${coded ? '编码' : '名称'}；可以停用后新建一项`);
  }
}

export async function beforeUnitDelete(ctx: { em: EntityManager; user: { companyId: number }; record: ResourceRecord }) {
  const kind = str(ctx.record.data.kind);
  const coded = (PRODUCT_UNIT_CODED_KINDS as readonly string[]).includes(kind);
  // 系统规格只存名称：删除维护项不修改历史商品。带编码的单位仍保护引用。
  if (!coded) return;
  const value = coded ? str(ctx.record.data.code) : str(ctx.record.data.name);
  const n = await productsUsingUnit(ctx.em, ctx.user.companyId, kind, value);
  if (n > 0) throw new BadRequestException(`已被 ${n} 条商品档案或组合构成引用，不能删除；可以改为停用`);
}

export { UNIT_RESOURCE };
