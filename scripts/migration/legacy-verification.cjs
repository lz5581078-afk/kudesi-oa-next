'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
// These are the reviewed read/report policies, not the old route handlers.
// The source connection is already in a READ ONLY snapshot transaction.
const POLICY = {
  'product-data-verification.js': 'bf876524579ee0d0950c8aec5eb52e3bdaf43748db6f6c26cfc0d83c728d241d',
  'bundle-verification.js': '65abaa309e1236b4e582ced1030007958fdc955a9f7fc3b830bd07e0d04fc20c',
  'verification-snapshot.js': '86b436723d9c67bc2deae8e6316ed95c2e1307ff629c8b1af155d019800c30e1',
  'archive-quality.mjs': 'd68d6911136d72ab37a916607efac42ff0d8e98fee4827fed488971a9e15def6',
  'product-category-validation.js': '5f5814aa30787332882911b8873f000c0a0c4d64f65620ad9043e97e6055070a',
  'bundle-extras.js': '2652ae36d3643109901c6bd516ea23a708cce8ecffefc84765757cf67b9afd60',
  'bundle-current-values.js': 'd165b6fcbfe43a611ce48c0798d891ad2ea9abc9998587441b8324698fcb878b',
  'product-archive-linkage.js': '69622afbebf8fed4c3e4813e26451f275786db4037c1fcc5606079a1c50e4cee',
  'raw-finished-names.js': '1e6ceba2cf37f810f6ea4b7c4573ccc61196b0db7c0a601fc9abbd2f1df9c2ae',
};
function checkPolicy(app) {
  for (const [name, known] of Object.entries(POLICY)) {
    const source = fs.readFileSync(path.join(app, 'server/modules/finance', name));
    if (crypto.createHash('sha256').update(source).digest('hex') !== known) throw Error('旧商品验证策略已变化，须重新核对源码');
  }
}
function readonlyQuery(connection) {
  return async (sql, args) => {
    if (!/^\s*SELECT\b/i.test(sql) || /;/.test(sql)) throw Error('旧商品核对仅允许只读查询');
    return (await connection.query(sql, args))[0];
  };
}
const COST_BASIS = 'source-purchase-records-with-composition-recalculation';
function millionths(value) {
  const text = typeof value === 'number' ? value.toFixed(6) : String(value ?? '');
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(text);
  if (!m) throw Error('旧成本记录或运杂费无法精确换算');
  return BigInt(m[1]) * 1000000n + BigInt(((m[2] || '') + '000000').slice(0, 6));
}
/** Independent source-side quote: current purchase records, not the old
 * editable archive purchase-price cache. This is the user's chosen cost basis. */
function baseCostBasis(tables, base, day) {
  const real = base.canonical_base_code_id ? (tables.finance_product_base_codes || []).find(b => String(b.id) === String(base.canonical_base_code_id)) : base;
  if (!real) return null;
  let links = (tables.finance_product_code_links || []).filter(l => String(l.base_code_id) === String(real.id));
  if (!links.length && real.source_product_id) links = [{ product_id: real.source_product_id, quantity: '1' }];
  if (!links.length) return null;
  const quote = (productId, trail = []) => {
    if (trail.includes(String(productId)) || trail.length > 20) throw Error('旧成本组成存在循环或过深引用');
    const product = (tables.finance_products || []).find(p => String(p.id) === String(productId));
    const costs = (tables.finance_product_archive_costs || []).filter(c => String(c.product_id) === String(productId) && c.cost_type === 'purchase' && c.status === 'active' && c.effective_from <= day && (!c.effective_to || c.effective_to >= day)).sort((a,b) => String(b.effective_from).localeCompare(String(a.effective_from)) || Number(b.id)-Number(a.id));
    const cost = costs[0]; if (!product || !cost) return null;
    const payload = typeof product.payload_json === 'string' ? JSON.parse(product.payload_json) : product.payload_json || {};
    if (payload.freightAmount == null || payload.handlingAmount == null) return null;
    const composed = product.archive_key === 'self_made' || product.archive_key === 'purchased' && product.supply_mode === 'supplier_oem';
    if (composed && Number(cost.manual_override) === 1) throw Error('旧成品成本已人工锁定，需保留锁定口径');
    const bom = composed && (tables.finance_product_archive_boms || []).filter(b => String(b.owner_product_id) === String(productId) && b.status === 'active').sort((a,b) => Number(b.id)-Number(a.id))[0];
    const children = [], labor = [];
    const isOem = product.archive_key === 'purchased' && product.supply_mode === 'supplier_oem';
    const rawPurchase = isOem ? require('./sku-mapping.cjs').oemRawPurchase(payload) : undefined;
    if (isOem && rawPurchase === undefined) return null;
    const includePurchase = !composed || isOem;
    const purchaseInput = isOem ? rawPurchase : cost.unit_cost;
    const node = { productId: String(productId), recordId: String(cost.id), unitCost: String(cost.unit_cost), freight: String(payload.freightAmount), handling: String(payload.handlingAmount), includePurchase, ...(isOem ? { rawMaterialPurchasePrice: String(rawPurchase), purchaseBasis: 'explicit-oem-raw-input' } : {}), children, labor };
    let amount = millionths(payload.freightAmount) + millionths(payload.handlingAmount) + (includePurchase ? millionths(purchaseInput) : 0n);
    if (composed && !bom && !includePurchase) return null;
    for (const line of bom ? (tables.finance_product_archive_bom_lines || []).filter(l => String(l.bom_id) === String(bom.id)) : []) {
      if (line.cost_treatment && line.cost_treatment !== 'include') throw Error('旧组成存在非计入成本行，须明确兼容');
      const child = quote(line.component_product_id, [...trail,String(productId)]); if (!child) return null;
      const quantity = millionths(line.quantity), loss = millionths(line.loss_rate || '0');
      amount += (child.amount * quantity * (1000000n + loss) + 500000000000n) / 1000000000000n;
      children.push({ sourceLineId: String(line.id), quantity: String(line.quantity), lossRate: String(line.loss_rate || '0'), node: child.node });
    }
    for (const line of bom ? (tables.finance_product_archive_labor_lines || []).filter(l => String(l.bom_id) === String(bom.id)) : []) {
      const item = (tables.finance_labor_cost_items || []).find(i => String(i.id) === String(line.labor_cost_item_id));
      if (!item || item.unit_cost == null) return null;
      amount += (millionths(item.unit_cost) * millionths(line.quantity) + 500000n) / 1000000n;
      labor.push({ sourceLineId: String(line.id), itemId: String(item.id), quantity: String(line.quantity), unitCost: String(item.unit_cost) });
    }
    return { amount, node };
  };
  const components = []; let total = 0n;
  for (const link of links) {
    const result = quote(link.product_id); if (!result) return null;
    total += (result.amount * millionths(link.quantity) + 500000n) / 1000000n;
    components.push({ quantity: String(link.quantity), node: result.node });
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('旧成本汇总超过精确范围');
  return { policy: COST_BASIS, costCents: Number(total) / 10000, components };
}
async function readLegacyVerification(connection, app, companyId, req, context) {
  if (context && !(context.tables.finance_product_base_codes || []).length && !(context.tables.finance_product_bundle_codes || []).length) return [];
  checkPolicy(app);
  const query = readonlyQuery(connection), result = [{ table: 'legacy_verification_policy', key: 'current', row: { company_id: companyId, hashes: POLICY, costBasisPolicy: COST_BASIS } }];
  const base = req(path.join(app, 'server/modules/finance/product-data-verification.js')).verificationReports;
  const bundle = req(path.join(app, 'server/modules/finance/bundle-verification.js')).bundleVerificationReports;
  for (const [kind, reports] of [['base', await base(companyId, query)], ['bundle', await bundle(companyId, query)]]) for (const [id, report] of reports) {
    // JSON is the old report's public scalar representation; no Date coercion
    // of DB timestamps occurs because the source reader uses dateStrings.
    const baseRow = kind === 'base' && context?.tables.finance_product_base_codes?.find(b => String(b.id) === String(id));
    const row = JSON.parse(JSON.stringify({ company_id: companyId, id: String(id), kind, report, ...(baseRow ? { costBasis: baseCostBasis(context.tables, baseRow, context.businessDay) } : {}) }));
    result.push({ table: 'legacy_verification_reports', key: `${kind}:${id}`, row });
  }
  return result;
}
module.exports = { readLegacyVerification, readonlyQuery, checkPolicy, baseCostBasis, COST_BASIS };
