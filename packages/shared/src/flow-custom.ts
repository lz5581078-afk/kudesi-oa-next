/**
 * 公司自建流程模板：表单结构校验、节点模板目录、超时与处罚规则。前后端共用。
 * 自建模板的“表单结构”随流程版本（flow_definitions.schema_json）一起保存，已发布版本不可改，所以在途流程不受影响。
 */
import type { FieldDef, Option } from './resources';
import { RESOURCE_DEFS } from './resources';
import { validatePostingDecl, validateSteps, type FlowPostingDecl, type FlowTemplate, type StepDef, type StepType } from './flow';

export interface CustomSchema {
  fields: FieldDef[];
  stepFields: Record<string, FieldDef[]>;
  posting?: FlowPostingDecl | null;
}

const FIELD_KEY = /^[a-z][A-Za-z0-9]{0,30}$/;
export const CUSTOM_FIELD_TYPES = ['text', 'textarea', 'number', 'money', 'date', 'bool', 'select', 'ref', 'files'] as const;
export const CUSTOM_FIELD_TYPE_LABEL: Record<(typeof CUSTOM_FIELD_TYPES)[number], string> = {
  text: '单行文字', textarea: '多行文字', number: '数字', money: '金额（元）', date: '日期', bool: '是/否', select: '下拉选择', ref: '选择资料/员工', files: '附件',
};
/** 自建模板里“选择资料”可选的目标：员工，和几个常用资料 */
export const CUSTOM_REF_TARGETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'user', label: '员工' }, { value: 'bank-accounts', label: '银行账户' }, { value: 'finance-fee-items', label: '费用项目' },
  { value: 'finance-suppliers', label: '供应商' }, { value: 'finance-customers', label: '客户' }, { value: 'finance-base-codes', label: '基础商品' },
  { value: 'licenses', label: '营业执照' }, { value: 'stores', label: '店铺' }, { value: 'phones', label: '手机号' }, { value: 'fixed-assets', label: '固定资产' },
];

/** 字段目录（旧系统“业务字段”的通用部分）：设计器里一键加入，也可以自己建字段 */
export const FLOW_FIELD_CATALOG: ReadonlyArray<FieldDef> = [
  { key: 'supplierName', label: '供应商', type: 'text', group: '业务' },
  { key: 'goodsName', label: '商品名称', type: 'text', group: '业务' },
  { key: 'quantity', label: '数量', type: 'number', group: '业务' },
  { key: 'unit', label: '单位', type: 'text', group: '业务' },
  { key: 'unitPrice', label: '单价', type: 'money', group: '业务' },
  { key: 'amount', label: '金额', type: 'money', group: '业务' },
  { key: 'expectedDate', label: '预计日期', type: 'date', group: '业务' },
  { key: 'attachment', label: '附件', type: 'files', group: '业务' },
  { key: 'remark', label: '备注', type: 'textarea', group: '业务', maxLength: 500 },
  { key: 'reason', label: '事由', type: 'textarea', group: '业务', maxLength: 500 },
  { key: 'payee', label: '收款方', type: 'text', group: '付款' },
  { key: 'payeeAccount', label: '收款账户', type: 'text', group: '付款' },
  { key: 'bankAccountId', label: '付款账户', type: 'ref', ref: 'bank-accounts', group: '付款' },
  { key: 'paidAt', label: '付款日期', type: 'date', group: '付款' },
  { key: 'voucher', label: '付款凭证号', type: 'text', group: '付款' },
  { key: 'feeItemId', label: '费用项目', type: 'ref', ref: 'finance-fee-items', group: '付款' },
  { key: 'receivedQuantity', label: '实收数量', type: 'number', group: '入库' },
  { key: 'packageCount', label: '件数', type: 'number', group: '入库' },
  { key: 'difference', label: '差异说明', type: 'textarea', group: '入库', maxLength: 500 },
  { key: 'photo', label: '现场照片', type: 'files', group: '入库' },
  { key: 'checkResult', label: '核对结果', type: 'select', group: '核对', options: [{ value: 'ok', label: '通过' }, { value: 'bad', label: '有问题' }] as Option[] },
  { key: 'comment', label: '办理意见', type: 'textarea', group: '核对', maxLength: 500 },
  { key: 'storeId', label: '店铺', type: 'ref', ref: 'stores', group: '资料' },
  { key: 'licenseId', label: '营业执照', type: 'ref', ref: 'licenses', group: '资料' },
];

export function validateCustomFields(fields: readonly FieldDef[], where: string): string[] {
  const errors: string[] = [];
  const refTargets = new Set(['user', ...RESOURCE_DEFS.map((d) => d.key)]);
  if (fields.length > 40) errors.push(`${where}最多 40 个字段`);
  const seen = new Set<string>();
  for (const f of fields) {
    const label = `${where}字段「${f.label || f.key}」`;
    if (!FIELD_KEY.test(f.key ?? '')) errors.push(`${label}的编号不合法（小写字母开头，字母数字）`);
    if (seen.has(f.key)) errors.push(`${label}的编号重复`);
    seen.add(f.key);
    if (!f.label || f.label.trim().length === 0 || f.label.length > 30) errors.push(`${label}要有名称（不超过 30 字）`);
    if (!(CUSTOM_FIELD_TYPES as readonly string[]).includes(f.type)) errors.push(`${label}的类型不支持`);
    if (f.type === 'select' && (!f.options || f.options.length === 0 || f.options.length > 30 || f.options.some((o) => !o.value || !o.label) || new Set(f.options.map((o) => o.value)).size !== f.options.length)) errors.push(`${label}要给出 1 到 30 个不重复的选项`);
    if (f.type === 'ref' && (!f.ref || !refTargets.has(f.ref))) errors.push(`${label}要选择资料类型`);
  }
  return errors;
}

/** 自建模板的表单结构与步骤整体校验；返回错误列表（空 = 合法）。 */
export function validateCustomTemplate(t: FlowTemplate, steps: readonly StepDef[], escalateUserIds: readonly number[] = []): string[] {
  const errors = [...validateCustomFields(t.fields, '发起表单'), ...validateSteps({ ...t, custom: true }, steps, escalateUserIds)];
  for (const [key, fields] of Object.entries(t.stepFields)) {
    const step = steps.find((s) => s.key === key);
    if (!step || step.type === 'submit' || step.type === 'end') { errors.push(`办理表单对应的步骤「${key}」不存在或不能办理`); continue; }
    errors.push(...validateCustomFields(fields, `步骤「${step.name}」办理表单`));
  }
  if (t.posting) errors.push(...validatePostingDecl({ ...t, steps }));
  return errors;
}

// ================= 节点模板 =================

export interface NodeTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  type: StepType;
  /** 默认时限（分钟） */
  dueMinutes: number | null;
  /** 节点默认页面：办理这一步时要填的字段 */
  fields: FieldDef[];
  builtin?: boolean;
  /** false=只能查看，不能加入自建流程（发起/汇合/结束/业务专用表单节点） */
  insertable?: boolean;
  /** 办理这一步时能看到、但不用填的内容（字段名称） */
  context?: string[];
  /** 对应的新系统业务流程步骤 */
  binding?: { flowKey: string; stepKey: string };
  note?: string;
}
export const NODE_TEMPLATE_CATEGORIES = ['通用节点', '财务与费用', '采购与仓库', '店铺与资料'] as const;
const cat = (key: string) => FLOW_FIELD_CATALOG.find((f) => f.key === key)!;
const req = (f: FieldDef): FieldDef => ({ ...f, required: true });

export const BUILTIN_NODE_TEMPLATES: readonly NodeTemplate[] = [
  { key: 'approval', name: '审批确认', description: '看申请内容，通过、退回或拒绝；可写办理意见。', category: '通用节点', type: 'approval', dueMinutes: 1440, fields: [cat('comment')] },
  { key: 'supervisor_approval', name: '主管审批', description: '直属主管审批；办理人建议选“发起人的上级”。', category: '通用节点', type: 'approval', dueMinutes: 1440, fields: [cat('comment')] },
  { key: 'boss_approval', name: '老板审批', description: '大额或重要事项由老板审批。', category: '通用节点', type: 'approval', dueMinutes: 2880, fields: [cat('comment')] },
  { key: 'upload', name: '上传资料', description: '办理人上传附件并写备注。', category: '通用节点', type: 'execute', dueMinutes: 1440, fields: [req(cat('attachment')), cat('remark')] },
  { key: 'confirm', name: '办理确认', description: '线下办完后在这里确认并留说明。', category: '通用节点', type: 'execute', dueMinutes: 1440, fields: [cat('remark')] },
  { key: 'finance_approval', name: '财务审批', description: '财务核对金额与收款信息后通过。', category: '财务与费用', type: 'finance', dueMinutes: 1440, fields: [cat('checkResult'), cat('comment')] },
  { key: 'payment', name: '付款记账', description: '填付款账户、日期、凭证号；配合模板的自动记账声明可自动生成费用单。', category: '财务与费用', type: 'finance', dueMinutes: 1440, fields: [req(cat('bankAccountId')), req(cat('paidAt')), cat('voucher')] },
  { key: 'finance_review', name: '财务复核', description: '财务复核金额、成本与差异。', category: '财务与费用', type: 'finance', dueMinutes: 2880, fields: [cat('checkResult'), cat('difference'), cat('remark')] },
  { key: 'reimbursement', name: '费用报销', description: '填实际运费、装卸费等费用说明与凭证。', category: '财务与费用', type: 'finance', dueMinutes: 2880, fields: [cat('amount'), cat('voucher'), cat('remark')] },
  { key: 'inbound', name: '仓库入库', description: '核对实收数量、件数，拍照留证，写差异说明。', category: '采购与仓库', type: 'execute', dueMinutes: 1440, fields: [req(cat('receivedQuantity')), cat('packageCount'), cat('difference'), cat('photo')] },
  { key: 'quality', name: '质检确认', description: '质检结果与备注。', category: '采购与仓库', type: 'execute', dueMinutes: 1440, fields: [req(cat('checkResult')), cat('remark')] },
  { key: 'license_photo_upload', name: '营业执照照片上传', description: '上传执照照片并关联营业执照。', category: '店铺与资料', type: 'execute', dueMinutes: 2880, fields: [cat('licenseId'), req(cat('attachment')), cat('remark')] },
  { key: 'store_check', name: '店铺资料核对', description: '核对店铺信息，写核对结论。', category: '店铺与资料', type: 'execute', dueMinutes: 2880, fields: [cat('storeId'), cat('checkResult'), cat('remark')] },
].map((t) => ({ ...t, builtin: true }) as NodeTemplate);

export function validateNodeTemplate(t: Pick<NodeTemplate, 'name' | 'description' | 'type' | 'dueMinutes' | 'fields' | 'category'>): string[] {
  const errors: string[] = [];
  if (!t.name?.trim() || t.name.length > 40) errors.push('模板名称必填，最多 40 字');
  if ((t.description ?? '').length > 500) errors.push('用途最多 500 字');
  if (!['approval', 'execute', 'finance'].includes(t.type)) errors.push('节点类型只能是审批、办理或财务');
  if (t.dueMinutes != null && (!Number.isInteger(t.dueMinutes) || t.dueMinutes < 1 || t.dueMinutes > 100_800)) errors.push('默认时限必须是 1 到 100800 分钟');
  if (!NODE_TEMPLATE_CATEGORIES.includes(t.category as never)) errors.push('分类不支持');
  errors.push(...validateCustomFields(t.fields, '默认页面'));
  return errors;
}

// ================= 超时规则与处罚 =================

export interface TimeoutNotifications {
  enabled: boolean;
  supervisorAfterMinutes: number;
  bossAfterMinutes: number;
  /** manager=办理人的上级（没有就取部门主管）；employee=指定员工 */
  supervisorReceiver: 'manager' | 'employee';
  supervisorUserId: number | null;
  /** admins=公司管理员；employee=指定员工 */
  bossReceiver: 'admins' | 'employee';
  bossUserId: number | null;
}
export interface TimeoutPenalty {
  enabled: boolean;
  /** 超时多少分钟后开始计 */
  afterMinutes: number;
  mode: 'fixed' | 'repeat' | 'tiers';
  /** 按任务（每条待办一次）还是按节点（同一流程同一步骤同一办理人一次） */
  unit: 'task' | 'node';
  amountCents: number;
  repeatMinutes: number;
  repeatAmountCents: number;
  capCents: number | null;
  tiers: Array<{ afterMinutes: number; amountCents: number }>;
}
export interface TimeoutPolicy { notifications: TimeoutNotifications | null; penalties: TimeoutPenalty | null }
export const PENALTY_MODE_LABEL: Record<TimeoutPenalty['mode'], string> = { fixed: '固定金额', repeat: '首次 + 按间隔累计', tiers: '按超时时长分档' };
export const MAX_PENALTY_CENTS = 10_000_000;

export function defaultTimeoutPolicy(): { notifications: TimeoutNotifications; penalties: TimeoutPenalty } {
  return {
    notifications: { enabled: false, supervisorAfterMinutes: 15, bossAfterMinutes: 30, supervisorReceiver: 'manager', supervisorUserId: null, bossReceiver: 'admins', bossUserId: null },
    penalties: { enabled: false, afterMinutes: 60, mode: 'fixed', unit: 'task', amountCents: 0, repeatMinutes: 60, repeatAmountCents: 0, capCents: null, tiers: [] },
  };
}

const mins = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100_800 ? (v as number) : null);
const cents = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_PENALTY_CENTS ? (v as number) : null);

/** 规范化并校验超时规则。公司默认（isDefault）两段都必须有；流程/节点独立规则某段为 null 表示沿用上一层。 */
export function normalizeTimeoutPolicy(input: unknown, isDefault: boolean): { policy: TimeoutPolicy; errors: string[] } {
  const errors: string[] = [];
  const out: TimeoutPolicy = { notifications: null, penalties: null };
  const v = (input ?? {}) as Record<string, unknown>;
  const d = defaultTimeoutPolicy();
  for (const section of ['notifications', 'penalties'] as const) {
    const raw = v[section] as Record<string, unknown> | null | undefined;
    if (raw == null) { if (isDefault) out[section] = d[section] as never; continue; }
    if (typeof raw !== 'object' || typeof raw.enabled !== 'boolean') { errors.push('请确认规则启用状态'); continue; }
    if (section === 'notifications') {
      const sup = mins(raw.supervisorAfterMinutes), boss = mins(raw.bossAfterMinutes);
      if (sup === null) errors.push('主管通知阈值须为 1 到 100800 分钟');
      if (boss === null) errors.push('老板通知阈值须为 1 到 100800 分钟');
      if (sup !== null && boss !== null && boss < sup) errors.push('老板通知阈值不能早于主管通知');
      const sr = raw.supervisorReceiver === 'employee' ? 'employee' : 'manager';
      const br = raw.bossReceiver === 'employee' ? 'employee' : 'admins';
      const su = sr === 'employee' ? Number(raw.supervisorUserId) : null, bu = br === 'employee' ? Number(raw.bossUserId) : null;
      if (sr === 'employee' && !(Number.isInteger(su) && (su as number) > 0)) errors.push('请选择主管通知接收人');
      if (br === 'employee' && !(Number.isInteger(bu) && (bu as number) > 0)) errors.push('请选择老板通知接收人');
      out.notifications = { enabled: raw.enabled, supervisorAfterMinutes: sup ?? 15, bossAfterMinutes: boss ?? 30, supervisorReceiver: sr, supervisorUserId: su, bossReceiver: br, bossUserId: bu };
    } else {
      const mode = raw.mode as TimeoutPenalty['mode'], unit = raw.unit as TimeoutPenalty['unit'];
      if (!['fixed', 'repeat', 'tiers'].includes(mode) || !['task', 'node'].includes(unit)) { errors.push('处罚方式或计次单位无效'); continue; }
      const after = mins(raw.afterMinutes), amount = cents(raw.amountCents), rm = mins(raw.repeatMinutes), ra = cents(raw.repeatAmountCents);
      if (after === null) errors.push('处罚起算阈值须为 1 到 100800 分钟');
      if (amount === null) errors.push(`首次金额须为 0 到 ${MAX_PENALTY_CENTS / 100} 元，最多两位小数`);
      if (rm === null) errors.push('累计间隔须为 1 到 100800 分钟');
      if (ra === null) errors.push('累计金额金额无效');
      const cap = raw.capCents == null ? null : cents(raw.capCents);
      if (raw.capCents != null && cap === null) errors.push('封顶金额无效');
      const tiers = Array.isArray(raw.tiers) ? raw.tiers.map((r: { afterMinutes?: unknown; amountCents?: unknown }) => ({ afterMinutes: mins(r.afterMinutes) ?? 0, amountCents: cents(r.amountCents) ?? -1 })).sort((a, b) => a.afterMinutes - b.afterMinutes) : [];
      if (tiers.some((t) => t.afterMinutes === 0 || t.amountCents < 0)) errors.push('分档阈值和金额无效');
      if (mode === 'tiers') {
        if (!tiers.length || tiers.length > 10 || new Set(tiers.map((t) => t.afterMinutes)).size !== tiers.length) errors.push('分档规则须为 1 到 10 档，阈值不能重复');
        if (tiers.some((t, i) => i > 0 && t.amountCents < tiers[i - 1].amountCents)) errors.push('分档处罚金额不能随超时增加而减少');
      }
      out.penalties = { enabled: raw.enabled, afterMinutes: after ?? 60, mode, unit, amountCents: amount ?? 0, repeatMinutes: rm ?? 60, repeatAmountCents: ra ?? 0, capCents: cap, tiers };
    }
  }
  return { policy: out, errors };
}

/** 按超时分钟数计算处罚金额（整数分） */
export function penaltyCents(p: TimeoutPenalty | null | undefined, overdueMinutes: number): number {
  if (!p?.enabled || !Number.isFinite(overdueMinutes) || overdueMinutes < 0) return 0;
  let c = 0;
  if (p.mode === 'tiers') { for (const t of p.tiers) if (overdueMinutes >= t.afterMinutes) c = t.amountCents; }
  else if (overdueMinutes >= p.afterMinutes) {
    c = p.amountCents;
    if (p.mode === 'repeat') c += Math.floor((overdueMinutes - p.afterMinutes) / p.repeatMinutes) * p.repeatAmountCents;
  }
  return p.capCents == null ? c : Math.min(c, p.capCents);
}

export interface PolicyRow { templateKey: string; nodeKey: string; policy: Partial<TimeoutPolicy> }
/** 生效规则：公司默认 → 流程独立 → 节点独立，后者覆盖前者（按段覆盖）。 */
export function resolveTimeoutPolicy(rows: readonly PolicyRow[], templateKey: string, nodeKey: string): { policy: { notifications: TimeoutNotifications; penalties: TimeoutPenalty }; sources: { notifications: string; penalties: string } } {
  const result = defaultTimeoutPolicy();
  const sources = { notifications: '公司默认', penalties: '公司默认' };
  for (const [tk, nk, label] of [['', '', '公司默认'], [templateKey, '', '流程独立'], [templateKey, nodeKey, '节点独立']] as const) {
    if (label !== '公司默认' && (!tk || (label === '节点独立' && !nk))) continue;
    const row = rows.find((r) => r.templateKey === tk && r.nodeKey === nk);
    if (!row) continue;
    for (const s of ['notifications', 'penalties'] as const) {
      if (row.policy[s] != null) { (result as Record<string, unknown>)[s] = row.policy[s]; sources[s] = label; }
    }
  }
  return { policy: result, sources };
}
