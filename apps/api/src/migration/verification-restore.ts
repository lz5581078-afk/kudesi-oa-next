import type { EntityManager } from 'typeorm';
import { yuanToPreciseCents, multiplyUnitCents, sumUnitCents } from '@kudesi/shared';
import { ResourceRecord, User } from '../entities';
import type { LegacyArchive } from './protocol';
import { baseCodeOutbound, buildSnapshot, byField, sigOf } from '../resources/base-code-support';
import { sourceRowHash } from './source-rows';
import { bundleIssues } from '../resources/bundle-checks';
import { bundleSnapshotJson, unitNameOf } from '../resources/finance-rules';
import { CostService } from '../resources/cost.service';
import { loadUnitLists } from '../resources/unit-options';

type Row = Record<string, any>;
const COST_BASIS = 'source-purchase-records-with-composition-recalculation';
function referenceCost(row: Row, source: LegacyArchive): number | null {
  const basis = row.costBasis;
  const required = source.sourceRows?.some(r => r.table === 'legacy_verification_policy' && r.row.costBasisPolicy === COST_BASIS);
  if (!basis && !required) return null;
  if (!basis || basis.policy !== COST_BASIS || !Array.isArray(basis.components) || !basis.components.length) throw new Error('旧成本记录缺少独立核算依据');
  const original = (table: string, id: unknown) => source.sourceRows?.find(r => r.table === table && String(r.row.id) === String(id))?.row as Row | undefined;
  const quote = (node: Row, depth = 0): number => {
    if (depth > 20) throw new Error('旧成本核算组成过深');
    const record = original('finance_product_archive_costs', node.recordId), product = original('finance_products', node.productId);
    if (!record || !product || String(record.product_id) !== node.productId || String(record.unit_cost) !== node.unitCost) throw new Error('旧成本独立核算与原始记录不一致');
    const payload = (typeof product.payload_json === 'string' ? JSON.parse(product.payload_json) : product.payload_json) as Row;
    if (String(payload.freightAmount) !== node.freight || String(payload.handlingAmount) !== node.handling) throw new Error('旧成本独立核算与原运杂费不一致');
    if (node.includePurchase === false && product.archive_key !== 'self_made' && record.source_type !== 'production_bom') throw new Error('旧成本核算不能遗漏采购价');
    let amount = sumUnitCents([node.includePurchase === false ? '0' : node.unitCost, node.freight, node.handling].map(v => yuanToPreciseCents(v, 4)));
    for (const child of node.children ?? []) {
      const line = original('finance_product_archive_bom_lines', child.sourceLineId);
      if (!line || String(line.component_product_id) !== child.node.productId || String(line.quantity) !== child.quantity || Number(line.loss_rate) !== Number(child.lossRate)) throw new Error('旧成本独立核算与原组成不一致');
      amount = sumUnitCents([amount, multiplyUnitCents(quote(child.node, depth + 1), Number(child.quantity), Number(child.lossRate) * 100)]);
    }
    for (const labor of node.labor ?? []) {
      const line = original('finance_product_archive_labor_lines', labor.sourceLineId), item = original('finance_labor_cost_items', labor.itemId);
      if (!line || !item || String(line.labor_cost_item_id) !== labor.itemId || String(line.quantity) !== labor.quantity || String(item.unit_cost) !== labor.unitCost) throw new Error('旧成本独立核算与原人工项目不一致');
      amount = sumUnitCents([amount, multiplyUnitCents(yuanToPreciseCents(labor.unitCost, 4), Number(labor.quantity))]);
    }
    return amount;
  };
  let total = 0;
  for (const c of basis.components) {
    if (!(Number(c.quantity) > 0)) throw new Error('旧成本核算数量不合法');
    total = sumUnitCents([total, multiplyUnitCents(quote(c.node ?? c), Number(c.quantity))]);
  }
  if (Math.abs(total - basis.costCents) > 0.00001) throw new Error('旧成本独立核算合计不一致');
  return total;
}
interface Context {
  em: EntityManager; companyId: number; sourceCompanyId: number;
  lookup(type: string, old: unknown): number | undefined;
  createdIds: Set<number>;
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
  count(which: 'created' | 'reused', type: string): void;
  fail(type: string, id: string, reason: string): void;
}

export async function restoreBundleVerifications(ctx: Context, source: LegacyArchive) {
  if (!ctx.em.queryRunner?.isTransactionActive || ctx.em.queryRunner.data.legacyImport !== true) throw new Error('旧验证恢复必须位于迁移事务');
  const proofs = (source.sourceRows ?? []).filter(r => r.table === 'legacy_verification_reports' && r.row.kind === 'bundle');
  if (!proofs.length) return;
  const original = (table: string) => (source.sourceRows ?? []).filter(r => r.table === table).map(r => r.row as Row);
  const codes = original('finance_product_bundle_codes'), oldLines = original('finance_product_bundle_bom_lines'), oldLabor = original('finance_bundle_labor_lines'), confirmations = original('finance_bundle_data_verifications');
  const costs = new CostService(ctx.em.connection), data = await costs.load(ctx.companyId, ctx.em), units = await loadUnitLists(ctx.em, ctx.companyId);
  for (const proof of proofs) {
    const row = proof.row as Row, report = row.report as Row;
    try {
      await ctx.savepoint(async () => {
        if (String(row.company_id) !== String(ctx.sourceCompanyId) || proof.key !== `bundle:${row.id}`) throw new Error('旧组合验证来源公司或身份不一致');
        const id = ctx.lookup('finance-bundles', row.id);
        if (!id) throw new Error('旧验证对应的组合未迁入');
        const b = await ctx.em.findOneByOrFail(ResourceRecord, { id, companyId: ctx.companyId, type: 'finance-bundles' });
        if (!ctx.createdIds.has(id)) { ctx.count('reused', 'bundle-verification'); return; }
        if (report.status === 'pending') return;
        if (report.status !== 'verified' || !Array.isArray(report.issues) || report.issues.length || !report.verifiedAt) throw new Error('旧组合验证为待复核或带问题，尚需保留原差异基线');
        const confirmation = confirmations.find(r => String(r.base_code_id) === String(row.id));
        if (!confirmation || confirmation.verified_at !== report.verifiedAt || confirmation.composition_signature !== report.signature) throw new Error('旧组合人工验证记录与核对事实不一致');
        if (confirmation.verified_by != null) {
          const by = ctx.lookup('user', confirmation.verified_by);
          if (!by || !await ctx.em.findOneBy(User, { id: by, companyId: ctx.companyId })) throw new Error('旧组合验证人员未迁入本公司');
        }
        const lines = await byField(ctx.em, ctx.companyId, 'finance-bundle-lines', 'bundleId', b.id);
        const platform = await ctx.em.findOneBy(ResourceRecord, { id: Number(b.data.platformId), companyId: ctx.companyId, type: 'finance-platforms' });
        const issues = await bundleIssues(ctx.em, ctx.companyId, b.data, lines.map(r => r.data), platform?.status);
        if (issues.length) throw new Error(`转换后组合存在${issues.length}项核对问题：${issues.slice(0, 3).join('；')}`);
        const before = report.snapshot.profile;
        for (const [native, old] of [['code', 'final_code'], ['styleCode', 'final_style_code'], ['name', 'product_name'], ['shortName', 'short_name'], ['propertiesValue', 'properties_value'], ['baseUnit', 'base_unit']]) if (String(b.data[native] ?? '') !== String(before[old] ?? '')) throw new Error(`转换前后组合${native}不一致`);
        const code = codes.find(c => String(c.id) === String(row.id));
        if (!code) throw new Error('旧组合原始档案缺失');
        const material = oldLines.filter(l => String(l.bom_id) === String(code.bom_id)).sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id));
        const labor = oldLabor.filter(l => String(l.bom_id) === String(code.bom_id));
        const originals = [...material, ...labor];
        if (originals.length !== lines.length || originals.length !== report.components.length) throw new Error('转换前后组合组成数量不一致');
        const parts: string[] = [];
        let cost = 0, oldCostSum = 0, weight = 0, rebased = false;
        for (let i = 0; i < originals.length; i++) {
          const old = originals[i], comp = report.components[i], isLabor = i >= material.length;
          if (comp.costPrice == null || !Number.isFinite(Number(comp.costPrice))) throw new Error('旧组合组成成本缺失');
          const oldUnitCost = yuanToPreciseCents(Number(comp.costPrice).toFixed(6), 4);
          oldCostSum = sumUnitCents([oldCostSum, multiplyUnitCents(oldUnitCost, Number(old.quantity))]);
          const lineId = ctx.lookup('finance-bundle-lines', `${row.id}:${isLabor ? 'labor:' : ''}${old.id}`);
          const line = lines.find(l => l.id === lineId);
          if (!line || line.data.qty !== Number(old.quantity) || line.data.qty !== comp.quantity || line.data.role !== (isLabor ? 'labor' : old.role)) throw new Error('转换前后组合组成引用、用途或数量不一致');
          if (isLabor) {
            if (line.data.laborId !== ctx.lookup('finance-labor-costs', old.labor_item_id)) throw new Error('转换前后人工项目不一致');
            const item = data.labor.get(Number(line.data.laborId));
            if (!item || typeof item.data.unitPrice !== 'number') throw new Error('转换后人工成本缺失');
            const unit = yuanToPreciseCents(Number(comp.costPrice).toFixed(6), 4);
            if (Math.abs(item.data.unitPrice - unit) > 0.00001) throw new Error('转换前后人工成本不一致');
            cost = sumUnitCents([cost, multiplyUnitCents(unit, Number(old.quantity))]);
            parts.push(`L${line.data.laborId}:${line.data.qty}`); continue;
          }
          const bc = data.baseCodes.get(Number(line.data.baseCodeId));
          if (!bc || old.component_type === 'base_code' && bc.id !== ctx.lookup('finance-base-codes', old.base_code_id) || old.component_type === 'archive' && bc.data.productId !== ctx.lookup('finance-products', old.product_archive_id)) throw new Error('转换前后组合商品引用不一致');
          for (const [native, value] of Object.entries({ includeInJst: Number(old.include_in_jst_bundle) === 1, isRequired: Number(old.is_required) === 1, lossRate: Number(old.loss_rate), costTreatment: old.cost_treatment })) if (line.data[native] !== value) throw new Error(`转换前后组成${native}不一致`);
          if (old.cost_bucket && line.data.costBucket !== old.cost_bucket) throw new Error('转换前后组成成本归集不一致');
          const unitText = String(line.data.unit ?? '');
          if (unitText !== comp.unitName && unitNameOf(unitText) !== comp.unitName && ![...units.values()].flat().some(u => u.code === unitText && u.name === comp.unitName)) throw new Error('转换前后组成计量单位不一致');
          const conversion = bc.data._legacyCostChange as Row | undefined;
          const converted = conversion?.policy === COST_BASIS && Math.abs(conversion.fromCents - oldUnitCost) <= 0.00001 && conversion.toCents === bc.data.cost;
          const expectedCost = converted ? conversion!.toCents : oldUnitCost, expectedWeight = comp.weight == null ? null : Number(comp.weight) * 1000;
          if (converted) rebased = true;
          if (expectedCost == null || typeof bc.data.cost !== 'number' || Math.abs(bc.data.cost - expectedCost) > 0.00001) throw new Error('转换前后组成成本不一致');
          if (expectedWeight == null || typeof bc.data.weightG !== 'number' || Math.abs(bc.data.weightG - expectedWeight) > 0.000001) throw new Error('转换前后组成重量不一致');
          cost = sumUnitCents([cost, multiplyUnitCents(expectedCost, Number(old.quantity))]); weight += expectedWeight * Number(old.quantity);
          parts.push(`${line.data.role}:${bc.id}:${bc.data.signature}:${line.data.qty}:${unitText}:${line.data.includeInJst === true ? 1 : 0}:${line.data.lossRate ?? 0}:${String(line.data.costTreatment ?? '')}`);
        }
        const oldTotalCost = yuanToPreciseCents(Number(before.cost_price).toFixed(6), 4), expectedWeight = Number(before.weighing_weight) * 1000;
        if (Math.abs(oldCostSum - oldTotalCost) > 0.00001) throw new Error('旧组合组成成本之和与原汇总不一致');
        const expectedCost = rebased ? cost : oldTotalCost;
        const actualWeight = b.data.weightMode === 'manual' ? Number(b.data.manualWeightG) : weight;
        const priced = costs.row(data, b);
        if (Math.abs(cost - expectedCost) > 0.00001 || priced.preShipCostCents == null || Math.abs(priced.preShipCostCents - expectedCost) > 0.00001) throw new Error('转换前后组合总成本或成本表结果不一致');
        if (!Number.isFinite(actualWeight) || Math.abs(actualWeight - expectedWeight) > 0.000001 || priced.weightG == null || Math.abs(priced.weightG - expectedWeight) > 0.000001) throw new Error('转换前后组合总重量或成本表结果不一致');
        b.status = 'verified';
        if (rebased && Math.abs(expectedCost - oldTotalCost) > 0.00001) {
          b.data._legacyCostChange = { fromCents: oldTotalCost, toCents: expectedCost, policy: COST_BASIS };
          b.data.migrationCostNote = `按已确认的旧成本记录口径，随已核对的基础编码重新汇总；原组合缓存成本${oldTotalCost / 100}元，迁入成本${expectedCost / 100}元。原验证和组成证据均已保留。`;
          ctx.count('created', 'bundle-verification-cost-rebased');
        }
        b.data = { ...b.data, signature: sigOf(...parts.sort()), snapshot: await bundleSnapshotJson(ctx.em, ctx.companyId, b.data, lines.map(l => l.data)), verifiedAt: String(report.verifiedAt).slice(0, 10), _legacyVerifiedAt: report.verifiedAt, _legacyVerifiedBy: confirmation.verified_by, _legacyVerificationHash: sourceRowHash(row), _legacyVerificationSignature: confirmation.composition_signature };
        await ctx.em.save(ResourceRecord, b); ctx.count('created', 'bundle-verification');
      });
    } catch (e) { ctx.fail('bundle-verification', String(row.id), e instanceof Error ? e.message : '旧组合验证恢复失败'); }
  }
}
/** Preserve an existing human decision only after checking the converted live
 * values. Never invoke verify(), which would falsely stamp migration time and
 * the migration administrator as the approver, or enqueue an external sync. */
export async function restoreBaseVerifications(ctx: Context, source: LegacyArchive) {
  if (!ctx.em.queryRunner?.isTransactionActive || ctx.em.queryRunner.data.legacyImport !== true) throw new Error('旧验证恢复必须位于迁移事务');
  const proofs = (source.sourceRows ?? []).filter(r => r.table === 'legacy_verification_reports' && r.row.kind === 'base');
  for (const proof of proofs) {
    const row = proof.row as Row, report = row.report as Row;
    try {
      await ctx.savepoint(async () => {
        if (String(row.company_id) !== String(ctx.sourceCompanyId) || proof.key !== `base:${row.id}`) throw new Error('旧验证来源公司或身份不一致');
        const id = ctx.lookup('finance-base-codes', row.id);
        if (!id) throw new Error('旧验证对应的基础编码未迁入');
        const bc = await ctx.em.findOneByOrFail(ResourceRecord, { id, companyId: ctx.companyId, type: 'finance-base-codes' });
        if (!ctx.createdIds.has(id)) { ctx.count('reused', 'base-verification'); return; }
        if (report.status === 'pending') return;
        if (report.status !== 'verified' || !Array.isArray(report.issues) || report.issues.length || !report.verifiedAt) throw new Error('旧验证为待复核或带问题，尚需保留原差异基线');
        const confirmation = source.sourceRows?.find(r => r.table === 'finance_product_data_verifications' && String(r.row.base_code_id) === String(row.id))?.row as Row | undefined;
        if (!confirmation || confirmation.verified_at !== report.verifiedAt || typeof confirmation.composition_signature !== 'string' || confirmation.composition_signature !== report.signature) throw new Error('旧人工验证确认记录与核对事实不一致');
        if (confirmation.verified_by != null) {
          const by = ctx.lookup('user', confirmation.verified_by);
          if (!by || !await ctx.em.findOneBy(User, { id: by, companyId: ctx.companyId })) throw new Error('旧验证人员未迁入本公司');
        }
        const live = await buildSnapshot(ctx.em, ctx.companyId, bc);
        if (live.issues.length) throw new Error(`转换后存在${live.issues.length}项核对问题：${live.issues.slice(0, 3).map(i => i.message).join('；')}`);
        const oldProducts = Object.keys(report.snapshot?.archives ?? {}).map(old => ctx.lookup('finance-products', old));
        if (!oldProducts.length || oldProducts.some(id => !id) || JSON.stringify([...new Set(oldProducts)].sort()) !== JSON.stringify([...new Set(live.snapshot.archives.map(a => a.productId))].sort())) throw new Error('转换前后基础编码引用的商品档案集合不一致');
        const before = report.snapshot.canonical ?? report.snapshot.profile;
        const oldWeightG = Number(before.weighing_weight) * 1000;
        const oldCost = before.cost_price == null ? null : yuanToPreciseCents(Number(before.cost_price).toFixed(6), 4);
        const basisCost = referenceCost(row, source), expectedCost = basisCost ?? oldCost;
        if (!Number.isFinite(oldWeightG) || typeof bc.data.weightG !== 'number' || !Number.isFinite(bc.data.weightG) || Math.abs(bc.data.weightG - oldWeightG) > 0.000001) throw new Error('转换前后基础编码重量不一致');
        if (expectedCost == null || typeof bc.data.cost !== 'number' || Math.abs(bc.data.cost - expectedCost) > 0.00001) throw new Error(`转换前后基础编码成本不一致：旧编码${oldCost}分，成本记录口径${basisCost}分，档案现算${bc.data.cost}分`);
        const outbound = await baseCodeOutbound(ctx.em, ctx.companyId, bc);
        if (outbound.sku_id !== String(report.snapshot.profile.final_code) || outbound.name !== String(report.snapshot.profile.product_name)) throw new Error('转换前后基础编码编码或名称不一致');
        if (outbound.weight == null || Math.abs(outbound.weight * 1000 - oldWeightG) > 0.000001 || outbound.cost_price == null || Math.abs(outbound.cost_price * 100 - expectedCost) > 0.00001) throw new Error('转换后的基础编码上传重量或成本与旧值不一致');
        if (basisCost != null && oldCost != null && Math.abs(basisCost - oldCost) > 0.00001) {
          bc.data._legacyCostChange = { fromCents: oldCost, toCents: basisCost, policy: COST_BASIS };
          bc.data.migrationCostNote = `按已确认的旧成本记录口径重新汇总；原编码缓存成本${oldCost / 100}元，迁入成本${basisCost / 100}元。原验证记录、缓存与成本来源均已保留。`;
          ctx.count('created', 'base-verification-cost-rebased');
        }
        bc.status = 'verified';
        bc.data = { ...bc.data, signature: live.signature, snapshot: JSON.stringify(live.snapshot), verifiedAt: String(report.verifiedAt).slice(0, 10), _legacyVerifiedAt: report.verifiedAt, _legacyVerifiedBy: confirmation.verified_by, _legacyVerificationHash: sourceRowHash(row), _legacyVerificationSignature: confirmation.composition_signature };
        await ctx.em.save(ResourceRecord, bc);
        ctx.count('created', 'base-verification');
      });
    } catch (e) { ctx.fail('base-verification', String(row.id), e instanceof Error ? e.message : '旧验证恢复失败'); }
  }
}
