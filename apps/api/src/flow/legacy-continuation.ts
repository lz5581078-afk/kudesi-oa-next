import { sourceRowHash } from '../migration/source-rows';
import { BadRequestException } from '@nestjs/common';
import { todayShanghai, yuanToPreciseCents, type FlowTemplate } from '@kudesi/shared';
import { FlowRun, ResourceRecord, User } from '../entities';
import type { FlowAdapter, StepContext } from './flow-adapters';
import { appendLedgerHistory } from '../resources/ledger-history';

/** A source identity in the immutable import ledger, not client payload, selects
 * the encrypted original and determines whether completion records an expense. */
async function completeLegacy(ctx: StepContext, model: 'early' | 'linear') {
  const { em, user, run, resources } = ctx;
  const targetType = model === 'early' ? 'early_flow_run' : 'flow_run';
  const [link] = await em.query('SELECT source_company_id,source_key,source_hash FROM legacy_import_links WHERE company_id=? AND source_system=? AND target_type=? AND target_id=?', [run.companyId, 'legacy-oa', targetType, run.id]);
  if (!link || !String(link.source_key).startsWith(targetType + ':')) throw new BadRequestException('旧流程缺少已核对的来源关联，不能记账');
  const sourceId = String(link.source_key).slice(targetType.length + 1), sourceCompanyId = Number(link.source_company_id);
  const table = model === 'early' ? 'workflows' : 'workflow_instances';
  const original = await resources.legacySourceRow(em, user, sourceCompanyId, table, sourceId);
  if (!original || String(original.company_id) !== String(sourceCompanyId) || String(original.id) !== sourceId) throw new BadRequestException('旧流程原始证据缺失，不能记账');
  if (sourceRowHash(original) !== link.source_hash) throw new BadRequestException('旧流程来源指纹不一致');
  if (model === 'linear' && ['batch', 'business', 'graph'].includes(String(original.graph_status))) throw new BadRequestException('旧流程来源模型不匹配');
  run.payload.legacyResult = model === 'early' ? 'approved' : 'completed';
  const amountCents = original.amount == null ? 0 : yuanToPreciseCents(String(original.amount), 0);
  if (amountCents > 0 && (model === 'linear' || original.type === 'expense')) {
    const originalExpense = model === 'early' ? (await em.find(ResourceRecord, { where: { companyId: run.companyId, type: 'finance-ledger-history' } })).filter(r => r.data._sourceType === 'workflow' && String(r.data._sourceWorkflowId) === sourceId && (r.data._sourceCompanyId == null ? r.uniqueKey?.startsWith(`legacy-oa:${sourceCompanyId}:finance_entries:`) : Number(r.data._sourceCompanyId) === sourceCompanyId)) : [];
    if (originalExpense.length) {
      if (originalExpense.length !== 1 || originalExpense[0].data.amountCents !== amountCents || originalExpense[0].data.direction !== 'expense') throw new BadRequestException('旧流程已有金额或方向不同的收支记录，请先核对，未重复记账');
      const prefix = `legacy-oa:${sourceCompanyId}:finance_entries:`;
      const entryKey = originalExpense[0].uniqueKey?.startsWith(prefix) ? originalExpense[0].uniqueKey.slice(prefix.length) : null;
      const entryProof = entryKey ? await resources.legacySourceRow(em, user, sourceCompanyId, 'finance_entries', entryKey) : null;
      if (!entryProof || entryProof.source_type !== 'workflow' || String(entryProof.workflow_id) !== sourceId || entryProof.direction !== 'expense' || yuanToPreciseCents(String(entryProof.amount), 0) !== amountCents || sourceRowHash(entryProof) !== originalExpense[0].data._sourceHash) throw new BadRequestException('旧收支关联缺少一致的原始证据');
      run.payload._ledgerHistoryId = originalExpense[0].id; // Preserve its original description/date.
    } else {
      const ref = async (type: string, old: unknown) => {
        if (old == null) return undefined;
        const [row] = await em.query('SELECT target_id FROM legacy_import_links WHERE company_id=? AND source_system=? AND source_company_id=? AND source_key=? AND target_type=?', [run.companyId, 'legacy-oa', sourceCompanyId, `${type}:${old}`, type]);
        if (!row) throw new BadRequestException('旧流程的关联资料未迁入');
        return Number(row.target_id);
      };
      const result = await appendLedgerHistory(em, resources, user, { key: `legacy-flow:${run.id}`, sourceHash: String(link.source_hash),
        data: { caption: String(original.title).slice(0, 200), entryDate: todayShanghai(), category: '流程费用', direction: 'expense', amountCents, description: original.title, sourceLabel: '旧流程续办', storeId: await ref('stores', original.store_id), licenseId: await ref('licenses', original.license_id) },
        detail: { _sourceCompanyId: sourceCompanyId, _sourceType: model === 'early' ? 'workflow' : 'workflow_instance', _sourceWorkflowId: sourceId, _nativeRunId: run.id },
      });
      run.payload._ledgerHistoryId = result.id;
    }
  }
  await em.save(FlowRun, run);
}
export function legacyContinuationAdapter(t: FlowTemplate): FlowAdapter {
  return {
    key: t.key,
    async title() { return t.label; },
    async validateStart() { throw new BadRequestException('旧流程仅供续办，请从新流程入口发起'); },
    returnBlocked() { return '此流程按原顺序办理，不支持退回。'; },
    canHandleWithoutTodo({ run, stepKey }) {
      return t.legacySource === 'linear' && (run.payload._legacySteps as Record<string, { createsTask: boolean }> | undefined)?.[stepKey]?.createsTask === false;
    },
    async stepWorkItem({ em, run, stepKey }) {
      if (t.legacySource !== 'linear') return {};
      const policy = (run.payload._legacySteps as Record<string, { createsTask: boolean; supervisorId: number }> | undefined)?.[stepKey];
      if (!policy) throw new BadRequestException('旧流程下一步任务规则缺失');
      if (!policy.createsTask) return false;
      if (!await em.findOneBy(User, { id: policy.supervisorId, companyId: run.companyId })) throw new BadRequestException('旧流程监督人不属于本公司');
      const storeId = run.payload.storeId as number | undefined;
      if (storeId && !await em.findOneBy(ResourceRecord, { id: storeId, companyId: run.companyId, type: 'stores' })) throw new BadRequestException('旧流程关联店铺不属于本公司');
      return { supervisorId: policy.supervisorId, ...(storeId ? { storeId } : {}) };
    },
    async onFinish(ctx, outcome) { if (outcome === 'completed') await completeLegacy(ctx, t.legacySource!); },
  };
}
