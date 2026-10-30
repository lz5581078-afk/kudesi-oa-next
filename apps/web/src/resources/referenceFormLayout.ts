import { productLayoutKey, type FieldDef } from '@kudesi/shared';

export const REFERENCE_PARTIES = ['finance-suppliers', 'finance-customers', 'finance-fee-items'];
export function referenceRecordLabel(type: string, values: Record<string, unknown>) {
  if (type === 'finance-products') return ({ raw: '原料', self_made: '自产成品', purchased_original: '原装采购成品', purchased_oem: '供应商 OEM 成品', package: '产品包装', oem_package: 'OEM包装', shipping_material: '发货物料', custom: '商品' })[productLayoutKey(values)];
  return ({ 'finance-suppliers': '供应商', 'finance-customers': '客户', 'finance-fee-items': '费用类型', 'finance-base-codes': '商品基础编码', 'finance-bundles': '商品组合编码' } as Record<string, string>)[type] ?? '';
}

/** 顺序取自 24 号往来档案编辑界面；新增的数据字段保留在补充资料区。 */
export function referencePartyGroups(type: string, fields: FieldDef[]): Array<[string, FieldDef[]]> {
  const groups: ReadonlyArray<readonly [string, readonly string[]]> = type === 'finance-fee-items'
    ? [['基础信息', ['categoryId', 'code', 'name', 'accountingSubject', 'direction', 'platform', 'isCommon', 'needFlow', 'relationRequirement', 'note']]]
    : type === 'finance-customers' ? [['基础信息', ['categoryIds', 'code', 'name', 'contact', 'phone', 'note']]]
    : [['归入分类', ['categoryIds']], ['系统自动编号', ['code']], ['基础资料', ['name', 'shortName', 'shortCode']], ['联系资料', ['contact', 'phone', 'note']], ['收款与银行资料', ['bankAccountName', 'bank', 'bankAccountNo', 'paymentQr']]];
  const used = new Set<string>(), result: Array<[string, FieldDef[]]> = [];
  for (const [title, keys] of groups) {
    const list = keys.flatMap(key => { const f = fields.find(f => f.key === key); if (!f) return []; used.add(key); return [{ ...f, label: type === 'finance-fee-items' ? ({categoryId:'费用分类',code:'费用类型编号',name:'费用类型名称',accountingSubject:'会计/核算科目',isCommon:'是否常用',note:'费用备注'} as Record<string,string>)[key] ?? f.label : key === 'phone' ? '联系电话' : key === 'bankAccountNo' ? '银行账号' : f.label }]; });
    if (list.length) result.push([title, list]);
  }
  const extra = fields.filter(f => !used.has(f.key));
  if (extra.length) result.push(['补充资料', extra]);
  return result;
}

export function referenceFieldSpan(type: string, field: FieldDef) {
  if (['finance-customers','finance-fee-items'].includes(type) && ['categoryIds','categoryId','code'].includes(field.key)) return 6;
  if (['note', 'categoryIds', 'categoryId', 'code', 'paymentQr', 'bankAccountNo'].includes(field.key) || ['files', 'textarea', 'attrs'].includes(field.type)) return 12;
  return 6;
}
