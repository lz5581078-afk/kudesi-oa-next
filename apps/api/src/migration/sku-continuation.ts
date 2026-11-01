import { normalizeSpecs, type StepDef, type WarehouseLine } from '@kudesi/shared';

type Row = Record<string, any>;
interface Context {
  sourceCompanyId: number;
  run: Row; batch: Row; item: Row; records: Row[]; recipients: Row[];
  lookup(type: string, id: unknown): number | undefined;
  scenario(code: string): number | undefined;
  brand(dictionaryId: unknown): number | undefined;
}
const json = (v: any, fallback: any) => v == null ? fallback : typeof v === 'string' ? JSON.parse(v) : v;
const id = (v: unknown) => v == null ? '' : String(v);
const processors = ['bundle_sales', 'bundle_fulfillment', 'bundle_review', 'end'];
const keys = ['apply', 'warehouse', 'review', 'end'];
const types = ['submit', 'execute', 'finance', 'end'] as const;

/** Prepare an existing sales-stage application; never call start(), validate it
 * as a newly submitted application, reset its deadline, or create external work.
 * Invalid historical drafts remain editable with the same validation errors. */
export function prepareSkuContinuation(c: Context) {
  for (const r of [c.run, c.batch, c.item]) if (id(r.company_id) !== id(c.sourceCompanyId)) throw new Error('SKU来源公司不一致');
  if (id(c.item.workflow_instance_id) !== id(c.run.id) || id(c.item.batch_id) !== id(c.batch.id) || id(c.run.template_id) !== id(c.batch.template_id) || id(c.run.requester_id) !== id(c.batch.requester_id)) throw new Error('SKU原申请、规格和流程关联不一致');
  if (c.run.status !== 'processing' || c.run.graph_status !== 'batch' || !['draft', 'returned'].includes(c.item.status)) throw new Error('此SKU状态尚未验证可续办，不能假设回到申请节点');
  const nodes: Row[] = json(c.batch.template_snapshot, []);
  if (!Array.isArray(nodes) || nodes.length !== 4) throw new Error('SKU原节点快照不受支持');
  const need = (type: string, value: unknown): number => {
    const target = c.lookup(type, value);
    if (!Number.isSafeInteger(target) || !target || target < 1) throw new Error(`SKU续办缺少映射：${type}`);
    return target;
  };
  const sourceKeyMap = new Map(nodes.map((node, i) => [node.node_key, keys[i]]));
  const steps: StepDef[] = nodes.map((node, i) => {
    const schema = json(node.form_schema, {});
    if ((schema.nodeTemplate || (node.node_type === 'end' ? 'end' : '')) !== processors[i] || node.node_type !== types[i]) throw new Error('SKU原节点业务类型或顺序不同，不能套用新流程');
    const next = json(node.next_node_keys, []);
    const expected = i === 3 ? [] : [nodes[i + 1].node_key];
    if (!Array.isArray(next) || JSON.stringify(next) !== JSON.stringify(expected) || node.exception_to_node_key || json(node.join_required_node_keys, []).length) throw new Error('SKU存在未兼容的分支或汇合');
    if (node.reject_to_node_key && node.reject_to_node_key !== nodes[i - 1]?.node_key) throw new Error('SKU原退回路线不同');
    const minutes = node.due_hours == null ? null : Number(node.due_hours);
    if (minutes != null && (!Number.isSafeInteger(minutes) || minutes < 0)) throw new Error('SKU原时限格式不合法');
    let assignee: StepDef['assignee'];
    if (i === 0) assignee = { source: 'requester' }; // legacy bundle_sales always uses batch.requester_id
    else if (i !== 3) {
      const source = node.handler_source_type;
      if (!['employee', 'department', 'position'].includes(source)) throw new Error('SKU办理人来源尚未兼容');
      assignee = { source, id: need(source === 'employee' ? 'user' : source, node.handler_source_id) };
    }
    if (typeof node.node_name !== 'string' || node.node_name.length > 40) throw new Error('SKU节点名称不能无损写入');
    return { key: keys[i], type: types[i], name: node.node_name, locked: true, ...(assignee ? { assignee } : {}), ...(minutes != null ? { dueMinutes: minutes } : {}), ...(node.reject_to_node_key ? { returnToKey: sourceKeyMap.get(node.reject_to_node_key)! } : {}) };
  });
  const active = c.records.filter(r => id(r.workflow_instance_id) === id(c.run.id) && Number(r.is_active) === 1);
  if (active.length !== 1 || active[0].node_key !== nodes[0].node_key || active[0].status !== 'pending' || id(c.run.current_node_id) !== id(nodes[0].id)) throw new Error('SKU实际进度不在原运营节点');
  const declared = json(c.run.active_node_keys, []);
  if (!Array.isArray(declared) || declared.length !== 1 || declared[0] !== nodes[0].node_key) throw new Error('SKU活跃节点标记不一致');
  const raw = json(c.item.payload_json, {});
  const shared = c.batch.settings_json == null ? raw : json(c.batch.settings_json, {});
  const platformCodes = shared.platformCodes ?? [];
  if (!Array.isArray(platformCodes)) throw new Error('SKU平台原值不合法');
  const platformIds = platformCodes.map((p: Row) => need('finance-platforms', p.platformId));
  if (new Set(platformIds).size !== platformIds.length) throw new Error('SKU平台映射合并了原始平台身份');
  // The legacy page explicitly defaults an absent scenario to standard.
  const scenarioId = c.scenario(String(shared.salesScenario || 'standard'));
  if (!scenarioId) throw new Error('SKU销售场景缺少映射');
  const categoryId = shared.productCategoryDictionaryId ? need('finance-categories', `bundle-dict:${shared.productCategoryDictionaryId}`) : undefined;
  const brandId = raw.brandManual === true ? raw.brandDictionaryId : (c.batch.settings_json == null ? undefined : shared.brandDictionaryId);
  const nativeBrandId = brandId ? c.brand(brandId) : undefined;
  if (brandId && !nativeBrandId) throw new Error('SKU品牌缺少映射');
  if (!Array.isArray(raw.lines ?? [])) throw new Error('SKU草稿行格式无法保留');
  if ((raw.lines ?? []).some((l: Row) => !['main', 'gift', 'package', 'label', 'instruction', 'other'].includes(l.role)) || !Array.isArray(raw.laborLines ?? [])) throw new Error('SKU原草稿存在未兼容的组成类型');
  const lines = (role: string) => (raw.lines ?? []).filter((l: Row) => l.role === role).map((l: Row) => {
    const quantity = typeof l.quantity === 'string' && /^\d+(?:\.\d+)?$/.test(l.quantity) ? Number(l.quantity) : l.quantity;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || Math.abs(quantity) > Number.MAX_SAFE_INTEGER) throw new Error('SKU草稿原数量无法精确保留');
    return { baseCodeId: need('finance-base-codes', l.baseCodeId), qty: quantity };
  });
  const spec = { name: raw.specName ?? '', main: lines('main'), gift: lines('gift'), ...(raw.note != null ? { note: raw.note } : {}) };
  const warehouse: WarehouseLine[] = (raw.lines ?? []).filter((l: Row) => ['package', 'label', 'instruction', 'other'].includes(l.role)).map((l: Row) => ({ role: l.role, baseCodeId: need('finance-base-codes', l.baseCodeId), qty: Number(l.quantity) }));
  for (const l of raw.laborLines ?? []) warehouse.push({ role: 'labor', laborId: need('finance-labor-costs', l.laborItemId), qty: Number(l.quantity) });
  if (warehouse.some((l: Row) => !Number.isFinite(l.qty))) throw new Error('SKU原仓库草稿数量不合法');
  const legacyWarehouseDraft = warehouse.length || Object.keys(raw.notRequired ?? {}).length || raw.warehouseNote ? { config: [{ lines: warehouse, notRequired: raw.notRequired ?? {} }], ...(raw.warehouseNote ? { note: raw.warehouseNote } : {}) } : undefined;
  const payload = { batchName: c.batch.title, scenarioId, platformIds, ...(categoryId ? { bundleCategoryId: categoryId } : {}), ...(nativeBrandId ? { brandId: nativeBrandId } : {}), specs: [spec], _batchKey: `legacy-oa:${c.sourceCompanyId}:${c.batch.id}`, ...(legacyWarehouseDraft ? { _legacyWarehouseDraft: legacyWarehouseDraft } : {}) };
  const recipients = c.recipients.filter(r => id(r.node_record_id) === id(active[0].id)).map(r => need('user', r.employee_id));
  if (!recipients.length && active[0].owner_id) recipients.push(need('user', active[0].owner_id));
  if (!recipients.length) throw new Error('SKU当前冻结办理人缺失');
  return { templateKey: 'sku-batch-apply', payload, steps, requesterId: need('user', c.batch.requester_id),
    activeStep: { sourceRecordId: id(active[0].id), stepKey: 'apply', stepType: 'submit', stepName: nodes[0].node_name, status: 'active', enteredVia: c.item.status === 'returned' ? 'return' : 'normal', recipients, enteredAt: active[0].created_at, dueAt: c.run.due_at ?? null },
    source: { companyId: c.sourceCompanyId, runId: id(c.run.id), batchId: id(c.batch.id), itemId: id(c.item.id), itemStatus: c.item.status },
    draftValidationErrors: normalizeSpecs([spec]).errors, runtimeCompatibilityVerified: false };
}
