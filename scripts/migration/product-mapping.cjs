'use strict';
/**
 * 商品档案相关的纯转换（不读库、不碰密钥），由 legacy-adapter.cjs 调用，也可单独测试：
 * - 旧“商品档案单位/产品包装单位/发货物料规格单位”三张表 + 档案里用过的包装类别、尺寸单位 → 新“单位与规格”列表
 * - 旧档案里存的是单位名称，新档案存编码：名称 → 编码
 * - 旧多构成基础编码（code_links 多行）→ 新“多构成”基础编码 + 构成行
 */
let pinyinFn = null;
try { pinyinFn = require('pinyin-pro').pinyin; } catch { /* 没有拼音库时，新编码退回序号 */ }

const UNIT_TABLES = [['spec_unit', 'finance_product_units'], ['packaging_unit', 'finance_product_packaging_units'], ['shipping_unit', 'finance_shipping_material_units']];
const KEEP_CASE = new Set(['packaging_category', 'dimension_unit']); // 内置的 bag、cm 这类编码是小写，商品里已经在用
const normCode = (v, kind) => { const t = String(v ?? '').trim().replace(/[^A-Za-z0-9]/g, ''); return KEEP_CASE.has(kind) ? t : t.toUpperCase(); };
const text = (v) => String(v ?? '').trim();

function initials(name) {
  if (!pinyinFn) return '';
  return String(pinyinFn(name, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' }).join('')).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 资料配置里的内置选项：名称 → 编码（常用单位、包装类别、尺寸单位） */
function staticNames(defs) {
  const product = defs.find((d) => d.key === 'finance-products');
  const pick = (key) => Object.fromEntries((product?.fields.find((f) => f.key === key)?.options ?? []).map((o) => [o.label, o.value]));
  return { unit: pick('specUnit'), packaging_category: pick('packagingCategory'), dimension_unit: pick('dimensionUnit') };
}

function buildUnitCatalog({ tables, defs, payloadOf }) {
  const fixed = staticNames(defs);
  const records = [];
  const byKind = new Map(); // kind -> { byName: Map, codes: Set }
  const bucket = (kind) => { if (!byKind.has(kind)) byKind.set(kind, { byName: new Map(), codes: new Set() }); return byKind.get(kind); };
  const unique = (kind, base, fallback) => {
    const b = bucket(kind);
    let code = base || fallback, n = 1;
    while (b.codes.has(code)) code = `${(base || fallback)}${++n}`;
    return code;
  };
  const suggest = (kind, name) => {
    const known = (kind === 'packaging_category' || kind === 'dimension_unit') ? fixed[kind][name] : fixed.unit[name];
    return normCode(known, kind) || initials(name);
  };
  const add = (kind, name, wantedCode, sortOrder, id) => {
    const b = bucket(kind);
    if (!name || b.byName.has(name)) return;
    const code = unique(kind, normCode(wantedCode, kind) || suggest(kind, name), `U${b.byName.size + 1}`);
    b.codes.add(code); b.byName.set(name, code);
    records.push({ id, data: { kind, name, code, sortOrder } });
  };
  for (const [kind, table] of UNIT_TABLES) {
    const rows = [...(tables[table] || [])].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id));
    rows.forEach((row, i) => add(kind, text(row.unit_name), row.unit_code, Number(row.sort_order) || i + 1, `${kind}:${row.id}`));
  }
  // 包装类别、尺寸单位在旧系统没有单独的表，只是档案里的文字：用到的名称都建成列表项，不丢
  const used = { packaging_category: new Set(), dimension_unit: new Set() };
  for (const p of tables.finance_products || []) {
    const payload = payloadOf(p);
    if (text(payload.packagingCategory)) used.packaging_category.add(text(payload.packagingCategory));
    if (text(payload.dimensionUnit)) used.dimension_unit.add(text(payload.dimensionUnit));
  }
  for (const kind of Object.keys(used)) [...used[kind]].sort().forEach((name, i) => add(kind, name, '', i + 1, `${kind}:name:${name}`));
  return {
    records,
    /** 旧档案里的单位名称 → 新编码；列表里没有返回 undefined */
    codeOf: (kind, name) => byKind.get(kind)?.byName.get(text(name)),
  };
}

/** 档案里的单位类字段：规格单位（发货物料读发货物料单位）、产品包装单位、包装类别、尺寸单位 */
function productUnitFields({ row, payload, catalog }) {
  const out = {};
  const unitKind = row.archive_key === 'shipping_material' ? 'shipping_unit' : 'spec_unit';
  const set = (key, code) => { if (code) out[key] = code; };
  set('specUnit', catalog.codeOf(unitKind, row.unit));
  set('productPackagingUnit', catalog.codeOf('packaging_unit', payload.productPackagingUnit));
  set('packagingCategory', catalog.codeOf('packaging_category', payload.packagingCategory));
  set('dimensionUnit', catalog.codeOf('dimension_unit', payload.dimensionUnit));
  return out;
}

/** 旧基础编码有多行商品关联 = 多构成：返回主要商品和构成行；单商品返回 null */
function composedFromLinks(links) {
  const list = [...(links || [])].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id));
  if (list.length < 2) return null;
  const primary = list.find((l) => Number(l.is_primary) === 1) ?? list[0];
  return {
    primaryProductId: String(primary.product_id),
    lines: list.map((l) => ({
      id: String(l.id),
      productId: String(l.product_id),
      data: { qty: Number(l.quantity), role: l === primary || Number(l.is_primary) === 1 ? 'main' : 'auxiliary', remark: text(l.remark) || undefined },
    })),
  };
}

module.exports = { buildUnitCatalog, productUnitFields, composedFromLinks, normCode, UNIT_TABLES };
