/**
 * 统一流程引擎的共享部分：步骤、流程模板、校验。前后端共用。
 *
 * 一条流程 = 一个“模板”（业务字段 + 步骤顺序 + 每步的表单，由业务定义）+ 一个“流程定义”（每一步由谁办、多久办完、抄送谁，由管理员配置并发布）。
 * 发布后的定义不可改，要改就出新版本；已经在跑的流程用启动时的快照，不受后来修改影响。
 * 办理人规则（沿用旧系统，已确认要保留）：
 *   - 指定员工 / 岗位：必须恰好对应 1 名在职员工，0 个或多个都不行，绝不兜底给管理员或发起人
 *   - 部门：部门里全部在职员工共享，任何一人办理即可，进入步骤时冻结名单
 */
import type { FieldDef } from './resources';
import { date, money, o, ref, refs, select, text, textarea } from './resource-kit';

export type StepType = 'submit' | 'approval' | 'execute' | 'finance' | 'end';
export const STEP_TYPE_LABEL: Record<StepType, string> = { submit: '发起', approval: '审批', execute: '办理', finance: '财务', end: '结束' };

export type AssigneeSource = 'requester' | 'employee' | 'position' | 'department';
export const ASSIGNEE_SOURCE_LABEL: Record<AssigneeSource, string> = { requester: '发起人', employee: '指定员工', position: '指定岗位', department: '指定部门（任一人办理）' };

export interface Assignee {
  source: AssigneeSource;
  id?: number;
}

export interface StepDef {
  key: string;
  name: string;
  type: StepType;
  assignee?: Assignee;
  /** 本步时限（分钟）；空表示不限时。从进入本步算起，自然时间 */
  dueMinutes?: number | null;
  /** 进入本步时抄送的员工（≤20），只能看不能办 */
  ccUserIds?: number[];
  /** 业务要求保留的步骤（不能删、不能改顺序）；没有 locked 的审批步骤可由管理员增删 */
  locked?: boolean;
}

/** 取值来源：'payload.xxx' = 发起表单里的字段，'form.xxx' = 办理该步时填的字段 */
export type FlowValueRef = string;

/**
 * 流程自动记账的声明：哪一步办理通过（或整条流程完成）时，按这里写的对应关系生成一张财务单据。
 * 引擎只认声明，不再有“某某流程办完就记一笔费用”这种写死的规则；声明要随模板一起写、一起测。
 */
export interface FlowPostingDecl {
  /** 步骤编号；写 'complete' 表示整条流程完成时 */
  at: string;
  /** 只支持按“费用行”生成的单据：费用单 / 其他收入单 */
  docType: 'expense' | 'other-income';
  /** 生成后是否直接过账；false 则停在草稿，由财务到草稿中心处理 */
  post: boolean;
  date: FlowValueRef;
  bankAccountId: FlowValueRef;
  feeItemId: FlowValueRef;
  amountCents: FlowValueRef;
  memo?: FlowValueRef;
  /** 银行流水号/付款凭证号：填了就按“全公司不能重复登记”校验 */
  refNo?: FlowValueRef;
}

export interface FlowTemplate {
  key: string;
  label: string;
  description: string;
  /** 发起时填写的字段 */
  fields: readonly FieldDef[];
  /** 某一步办理时要填写的字段 */
  stepFields: Readonly<Record<string, readonly FieldDef[]>>;
  /** 默认步骤（办理人要管理员配置后才能发布） */
  steps: readonly StepDef[];
  /** 自动记账声明；没有就是这条流程不产生财务单据 */
  posting?: FlowPostingDecl;
}

/** 校验模板里的自动记账声明：步骤、字段都必须真实存在，类型要对得上。返回错误列表（空 = 合法）。 */
export function validatePostingDecl(t: FlowTemplate): string[] {
  const d = t.posting;
  if (!d) return [];
  const errors: string[] = [];
  if (d.at !== 'complete' && !t.steps.some((s) => s.key === d.at && s.type !== 'submit' && s.type !== 'end')) errors.push(`记账步骤「${d.at}」不存在或不是办理步骤`);
  const check = (name: string, ref: string | undefined, kind: FieldDef['type'][], required: boolean) => {
    if (!ref) { if (required) errors.push(`记账声明缺少「${name}」`); return; }
    const m = /^(payload|form)\.([A-Za-z][A-Za-z0-9]*)$/.exec(ref);
    if (!m) { errors.push(`记账声明「${name}」的来源「${ref}」写法不对`); return; }
    if (m[1] === 'form' && d.at === 'complete') { errors.push(`整条流程完成时没有办理表单，「${name}」不能取 form`); return; }
    const fields = m[1] === 'payload' ? t.fields : (t.stepFields[d.at] ?? []);
    const f = fields.find((x) => x.key === m[2]);
    if (!f) errors.push(`记账声明「${name}」引用的字段「${ref}」不存在`);
    else if (!kind.includes(f.type)) errors.push(`记账声明「${name}」引用的字段「${ref}」类型不对`);
    else if (required && m[1] === 'form' && !f.required) errors.push(`记账声明「${name}」引用的办理字段「${ref}」必须设为必填`);
  };
  check('日期', d.date, ['date'], true);
  check('付款账户', d.bankAccountId, ['ref'], true);
  check('费用项目', d.feeItemId, ['ref'], true);
  check('金额', d.amountCents, ['money'], true);
  check('说明', d.memo, ['text', 'textarea'], false);
  check('流水号', d.refNo, ['text'], false);
  return errors;
}

export type RunStatus = 'running' | 'completed' | 'cancelled' | 'rejected';
export const RUN_STATUS_LABEL: Record<RunStatus, string> = { running: '办理中', completed: '已完成', cancelled: '已废除', rejected: '已拒绝' };
export type StepStatus = 'active' | 'done' | 'returned' | 'cancelled' | 'rejected' | 'transferred';
export type FlowAction = 'submit' | 'pass' | 'return' | 'cancel' | 'reject' | 'withdraw' | 'resubmit' | 'transfer';
export const FLOW_ACTION_LABEL: Record<FlowAction, string> = {
  submit: '发起', pass: '通过', return: '退回', cancel: '废除', reject: '拒绝', withdraw: '撤回', resubmit: '重新提交', transfer: '转交',
};

const LICENSE_ITEMS = o('original:正本', 'copy:副本', 'official:公章', 'finance:财务章', 'legal:法人章', 'invoice:发票章');

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [
  {
    key: 'license-borrow',
    label: '借用营业执照/印章',
    description: '借用营业执照正本副本或公章。审批通过后由保管人交接，交接时自动登记借用记录，归还确认后自动改为已归还。',
    fields: [
      ref('licenseId', '营业执照', '借用', 'licenses', { required: true }),
      select('item', '借用物品', '借用', LICENSE_ITEMS, { required: true }),
      text('borrower', '借用人', '借用', { required: true, help: '实际拿去用的人' }),
      textarea('purpose', '用途', '借用', { required: true, maxLength: 500 }),
      date('borrowedAt', '借用日期', '借用', { required: true }),
      date('expectedReturnAt', '预计归还', '借用', { required: true, help: '到这天还没确认归还，会提醒办理人' }),
    ],
    stepFields: {
      handover: [textarea('note', '交接说明', '交接', { maxLength: 500, help: '例如交给谁、封存方式' })],
      receive_back: [
        date('returnedAt', '实际归还日期', '归还', { required: true }),
        textarea('note', '归还说明', '归还', { maxLength: 500, help: '例如物品是否完好' }),
      ],
    },
    steps: [
      { key: 'apply', name: '提交申请', type: 'submit', assignee: { source: 'requester' }, locked: true },
      { key: 'approve', name: '审批', type: 'approval', dueMinutes: 1440, locked: true },
      { key: 'handover', name: '交接执照', type: 'execute', dueMinutes: 1440, locked: true },
      { key: 'receive_back', name: '确认归还', type: 'execute', locked: true },
      { key: 'end', name: '结束', type: 'end', locked: true },
    ],
  },
  {
    key: 'expense-request',
    label: '费用申请',
    description: '申请支出一笔费用。审批通过后由财务付款，付款时自动生成并过账一张费用单，银行余额和费用同步记账。',
    fields: [
      ref('feeItemId', '费用项目', '费用', 'finance-fee-items', { required: true, help: '只能选“支出”方向的费用项目' }),
      money('amountCents', '金额', '费用', { required: true }),
      date('occurredAt', '费用发生日期', '费用', { required: true }),
      text('payee', '收款方', '费用'),
      textarea('reason', '事由', '费用', { required: true, maxLength: 500 }),
    ],
    stepFields: {
      pay: [
        ref('bankAccountId', '付款账户', '付款', 'bank-accounts', { required: true }),
        date('paidAt', '付款日期', '付款', { required: true }),
        text('voucher', '付款凭证号', '付款'),
      ],
    },
    steps: [
      { key: 'apply', name: '提交申请', type: 'submit', assignee: { source: 'requester' }, locked: true },
      { key: 'approve', name: '审批', type: 'approval', dueMinutes: 1440, locked: true },
      { key: 'pay', name: '财务付款', type: 'finance', dueMinutes: 1440, locked: true },
      { key: 'end', name: '结束', type: 'end', locked: true },
    ],
    // 付款这一步办理通过 → 生成并过账一张费用单；付款凭证号当作银行流水号防重复
    posting: { at: 'pay', docType: 'expense', post: true, date: 'form.paidAt', bankAccountId: 'form.bankAccountId', feeItemId: 'payload.feeItemId', amountCents: 'payload.amountCents', memo: 'payload.reason', refNo: 'form.voucher' },
  },
  {
    key: 'product-exclusive',
    label: '专属品领取',
    description: '运营领取一个基础商品的专属归属：同分类、同品牌、同品种的基础商品共享归属，其不同规格、平台和带赠品组合都算在内。审批人通过时定专属有效期（1 到 3650 天），通过后专属立即生效；到期自动解除，期间其他人不能再领取。',
    fields: [
      ref('baseCodeId', '基础商品', '领取', 'finance-base-codes', { required: true, help: '已有有效专属或正在申请的商品不能再申请' }),
      textarea('reason', '领取原因', '领取', { required: true, maxLength: 500, help: '说明为什么领取、计划如何经营（审批人会看到）' }),
    ],
    stepFields: {
      approve: [
        { key: 'periodDays', label: '专属有效期（天）', type: 'number', group: '审批', help: '1 到 3650 天，从审批通过时起算；和“指定到期日”二选一' },
        { key: 'endsAt', label: '指定到期日', type: 'date', group: '审批', help: '填了就到这一天 23:59:59（北京时间）为止；和“有效期（天）”二选一' },
      ],
    },
    steps: [
      { key: 'apply', name: '提交申请', type: 'submit', assignee: { source: 'requester' }, locked: true },
      { key: 'approve', name: '审批', type: 'approval', dueMinutes: 1440, locked: true },
      { key: 'end', name: '结束', type: 'end', locked: true },
    ],
  },
  {
    key: 'sku-batch-apply',
    label: 'SKU 批量申请',
    description: '运营一次申请多个新商品组合编码：运营填规格（主商品、赠品）→ 仓库补包装、标签、人工 → 财务核对后自动生成商品组合编码。财务通过后可选择加入聚水潭同步队列（只入队，总开关打开后才会发送）。',
    fields: [
      text('batchName', '申请名称', '申请', { required: true, maxLength: 140, help: '例如“10 月新品组合”' }),
      ref('scenarioId', '销售场景', '申请', 'finance-scenarios', { required: true, help: '整张申请的所有规格都用这个场景' }),
      refs('platformIds', '销售平台', '申请', 'finance-platforms', { required: true, help: '每个规格在每个平台各生成一个组合编码' }),
      ref('bundleCategoryId', '组合分类', '申请', 'finance-categories', { required: true, help: '组合分类树里的最末级分类；生成的组合都归到这个分类' }),
      { key: 'specs', label: '规格清单', type: 'json', group: '规格', required: true, help: '每个规格选主商品和赠品及数量；主商品必填' },
      textarea('note', '备注', '申请', { maxLength: 500 }),
    ],
    stepFields: {
      warehouse: [
        { key: 'config', label: '仓库配置', type: 'json', group: '仓库', required: true, help: '每个规格的包装、标签/说明书、其他打包材料、人工：每类要么选好，要么写明不需要的原因' },
        textarea('note', '仓库说明', '仓库', { maxLength: 500 }),
      ],
      review: [
        { key: 'confirmed', label: '我已核对规格、成本和编码', type: 'bool', group: '财务', required: true, help: '必须勾选才能通过' },
        { key: 'syncToJst', label: '通过后加入聚水潭同步队列', type: 'bool', group: '财务', help: '只是排队，总开关打开并接入聚水潭后才会真正发送；需要有“聚水潭同步”权限' },
      ],
    },
    steps: [
      { key: 'apply', name: '运营申请', type: 'submit', assignee: { source: 'requester' }, locked: true },
      { key: 'warehouse', name: '仓库完善', type: 'execute', dueMinutes: 3600, locked: true },
      { key: 'review', name: '财务审核', type: 'finance', dueMinutes: 3600, locked: true },
      { key: 'end', name: '结束', type: 'end', locked: true },
    ],
  },
];

export const getFlowTemplate = (key: string): FlowTemplate | undefined => FLOW_TEMPLATES.find((t) => t.key === key);

const KEY_RE = /^[a-z][a-z0-9_]{0,30}$/;

/** 管理员保存的步骤要满足模板和引擎规则；返回错误列表（空 = 合法）。 */
export function validateSteps(template: FlowTemplate, steps: readonly StepDef[], escalateUserIds: readonly number[] = []): string[] {
  const errors: string[] = [];
  if (steps.length < 2) return ['至少要有发起和结束两个步骤'];
  const first = steps[0], last = steps[steps.length - 1];
  if (first.type !== 'submit') errors.push('第一步必须是发起');
  if (last.type !== 'end') errors.push('最后一步必须是结束');
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    const label = `第 ${i + 1} 步「${s.name || s.key}」`;
    if (!KEY_RE.test(s.key)) errors.push(`${label}的编号不合法（小写字母开头，只能含小写字母、数字、下划线）`);
    if (seen.has(s.key)) errors.push(`${label}的编号重复`);
    seen.add(s.key);
    if (!s.name || s.name.trim().length === 0 || s.name.length > 40) errors.push(`${label}要有名称（不超过 40 字）`);
    if (i > 0 && i < steps.length - 1 && (s.type === 'submit' || s.type === 'end')) errors.push(`${label}不能是${STEP_TYPE_LABEL[s.type]}类型`);
    if (s.dueMinutes != null && (!Number.isInteger(s.dueMinutes) || s.dueMinutes < 1 || s.dueMinutes > 100_800)) errors.push(`${label}的时限必须是 1 到 100800 分钟`);
    if ((s.ccUserIds?.length ?? 0) > 20) errors.push(`${label}最多抄送 20 人`);
    if (s.type !== 'submit' && s.type !== 'end') {
      const a = s.assignee;
      if (!a || a.source === 'requester') errors.push(`${label}要指定办理人`);
      else if (!(Number.isInteger(a.id) && (a.id as number) > 0)) errors.push(`${label}要选择具体的${ASSIGNEE_SOURCE_LABEL[a.source].replace('指定', '')}`);
    }
  });
  // 模板要求保留的步骤必须都在，且相对顺序不变；admin 只能增删没有 locked 的审批步骤
  const locked = template.steps.filter((s) => s.locked);
  const actualLocked = steps.filter((s) => locked.some((l) => l.key === s.key));
  if (actualLocked.length !== locked.length) errors.push(`缺少业务必须的步骤：${locked.filter((l) => !steps.some((s) => s.key === l.key)).map((l) => l.name).join('、')}`);
  else if (!locked.every((l, i) => actualLocked[i].key === l.key)) errors.push('业务必须的步骤顺序不能改');
  for (const l of locked) {
    const s = steps.find((x) => x.key === l.key);
    if (s && s.type !== l.type) errors.push(`步骤「${l.name}」的类型不能改`);
  }
  for (const s of steps) {
    if (!locked.some((l) => l.key === s.key) && s.type !== 'approval') errors.push(`新增的步骤「${s.name}」只能是审批类型`);
  }
  if (escalateUserIds.length > 5) errors.push('超时升级最多通知 5 人');
  return errors;
}

/** 步骤时限的人话 */
export function formatMinutes(m: number | null | undefined): string {
  if (!m) return '不限时';
  if (m % 1440 === 0) return `${m / 1440} 天`;
  if (m % 60 === 0) return `${m / 60} 小时`;
  return `${m} 分钟`;
}
