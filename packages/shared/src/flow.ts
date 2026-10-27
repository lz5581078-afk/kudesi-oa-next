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
import { AFTER_SALES_TYPES, APPEAL_TYPES } from './service-cases';

export type StepType = 'submit' | 'approval' | 'execute' | 'finance' | 'end';
export const STEP_TYPE_LABEL: Record<StepType, string> = { submit: '发起', approval: '审批', execute: '办理', finance: '财务', end: '结束' };

export type AssigneeSource = 'requester' | 'employee' | 'position' | 'department' | 'requester_manager' | 'previous_handler' | 'position_type' | 'duty_group' | 'related_owner';
export const ASSIGNEE_SOURCE_LABEL: Record<AssigneeSource, string> = {
  requester: '发起人', employee: '指定员工', position: '指定岗位', department: '指定部门', requester_manager: '发起人的上级', previous_handler: '上一步办理人',
  position_type: '按岗位类型', duty_group: '按职责组', related_owner: '关联资料负责人',
};
/** 岗位类型（positions.workspace_type，旧系统的“角色”） */
export const POSITION_TYPE_LABEL: Record<string, string> = { boss: '老板', general: '综合', operations: '运营', finance: '财务', cashier: '出纳', warehouse: '仓库', purchasing: '采购', support: '客服', blank: '空白' };
/** 关联资料负责人：从发起表单里选中的资料，取它上面的负责员工 */
export const RELATED_OWNER_KINDS: Readonly<Record<string, { label: string; type: string; userField: string }>> = {
  store_owner: { label: '关联店铺运营人', type: 'stores', userField: 'operatorUserId' },
  phone_user: { label: '手机号使用人', type: 'phones', userField: 'userId' },
  asset_keeper: { label: '资产保管人', type: 'fixed-assets', userField: 'keeperUserId' },
};
/** 不需要再选具体对象的办理人来源 */
export const ASSIGNEE_NO_TARGET: readonly AssigneeSource[] = ['requester', 'requester_manager', 'previous_handler'];
/** 只能在流程发起后才能找到人的来源（发布时不检查能不能找到） */
export const ASSIGNEE_RUNTIME_ONLY: readonly AssigneeSource[] = ['requester', 'requester_manager', 'previous_handler', 'related_owner'];
/** 办理人来源不需要在“具体对象”里选的（含按岗位类型/关联资料负责人，它们有自己的设置项） */
export const ASSIGNEE_OWN_SETTINGS: readonly AssigneeSource[] = ['position_type', 'related_owner'];

/** 条件：取值来源 'payload.字段' 或 'form.步骤编号.字段'；用于“满足条件才办理这一步”（条件分支） */
export type ConditionOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'empty' | 'notempty';
export const CONDITION_OP_LABEL: Record<ConditionOp, string> = { eq: '等于', ne: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', in: '属于其中之一', empty: '没填', notempty: '已填' };
export interface StepCondition { field: string; op: ConditionOp; value?: string | number | Array<string | number> }

/** 督促时效：到期前提醒几次、超时后每隔多久再提醒（分钟） */
export interface StepRemind { beforeMinutes: number[]; overdueEveryMinutes?: number | null }

export interface Assignee {
  source: AssigneeSource;
  /** 员工/岗位/部门/职责组的编号 */
  id?: number;
  /** position_type 的岗位类型；related_owner 的负责人种类（RELATED_OWNER_KINDS 的键） */
  key?: string;
  /** related_owner：发起表单里哪个资料字段（引用资料）指向关联资料 */
  field?: string;
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
  /** 条件分支：不满足条件就跳过这一步（结束步不能带条件） */
  when?: StepCondition | null;
  /** 退回时回到哪一步（必须是前面的步骤）；不写就回到上一个实际办理过的步骤 */
  returnToKey?: string | null;
  /** 部门办理人的办理方式：any=任一人办理（默认），all=全员会签 */
  mode?: 'any' | 'all';
  /** 督促时效提醒 */
  remind?: StepRemind | null;
  /** 本步办理人看不到的发起字段（服务端过滤） */
  hiddenFields?: string[];
  /** 套用的节点模板（仅记录来源，套用后互不影响） */
  nodeTemplateKey?: string | null;
  /** 并行分支：相邻、分支编号相同的步骤同时办理，全部办完（汇合）才进入后面的步骤 */
  parallel?: string | null;
  /** 异常连线：办理人可以“上报异常”，流程转到这个步骤（必须是仅异常步骤）；不写则不能上报异常 */
  exceptionToKey?: string | null;
  /** 仅异常步骤：正常流转时自动跳过，只有被异常连线指到才办理 */
  onlyOnException?: boolean;
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
  /** 有专门的业务页面来发起（如售后表格、订单申诉）：申请中心只引导过去，接口也不允许绕过业务页面直接发起 */
  entry?: { path: string; label: string };
  /** 公司自建模板（表单结构存数据库）；内置模板没有这个标记 */
  custom?: boolean;
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
export type StepStatus = 'active' | 'done' | 'returned' | 'cancelled' | 'rejected' | 'transferred' | 'skipped';
export type FlowAction = 'submit' | 'pass' | 'return' | 'cancel' | 'reject' | 'withdraw' | 'resubmit' | 'transfer' | 'abnormal';
export const FLOW_ACTION_LABEL: Record<FlowAction, string> = {
  submit: '发起', pass: '通过', return: '退回', cancel: '废除', reject: '拒绝', withdraw: '撤回', resubmit: '重新提交', transfer: '转交', abnormal: '上报异常',
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
        { key: 'periodDays', label: '专属有效期（天）', type: 'number', group: '审批', required: true, help: '1 到 3650 天，从审批通过时起算' },
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
  {
    key: 'after-sales',
    label: '售后工单',
    description: '客服处理买家的退款、退货、换货、补发和补偿：客服登记 → 客服处理（默认 72 小时内办结）→ 主管复核。高金额或有争议的由主管把关；超时进入“兜底监督”。',
    entry: { path: '/after-sales/table', label: '在“售后表格”里登记' },
    fields: [
      ref('storeId', '店铺', '工单', 'stores', { required: true }),
      text('orderNo', '订单号', '工单', { required: true, maxLength: 80 }),
      text('buyerName', '买家', '工单', { maxLength: 80 }),
      select('caseType', '售后类型', '工单', [...AFTER_SALES_TYPES], { required: true }),
      money('amountCents', '申请金额', '工单', { required: true, help: '买家申请的退款/补偿金额，没有金额填 0' }),
      textarea('reason', '原因', '工单', { required: true, maxLength: 500 }),
      date('dueDate', '要求办结日期', '工单', { help: '不填就按流程配置里“客服处理”的时限' }),
    ],
    stepFields: {
      handle: [
        textarea('resolution', '处理结果', '处理', { required: true, maxLength: 500, help: '例如：已同意退货退款，快递单号……' }),
        money('refundCents', '实际退款/补偿金额', '处理', { help: '没有实际付出就不填' }),
      ],
    },
    steps: [
      { key: 'apply', name: '客服登记', type: 'submit', assignee: { source: 'requester' }, locked: true },
      { key: 'handle', name: '客服处理', type: 'execute', dueMinutes: 4320, locked: true },
      { key: 'review', name: '主管复核', type: 'approval', dueMinutes: 1440, locked: true },
      { key: 'end', name: '结束', type: 'end', locked: true },
    ],
  },
  {
    key: 'order-appeal',
    label: '订单申诉',
    description: '对平台订单的申诉与举证：登记 → 主管复核举证 → 提交平台 → 登记平台结果。失败可对该申诉发起复议。申诉失败次数不限，但提交平台前必须有有效凭证。',
    entry: { path: '/after-sales/appeals', label: '在“订单申诉”里登记' },
    fields: [
      ref('storeId', '店铺', '申诉', 'stores', { required: true }),
      select('appealType', '申诉类型', '申诉', APPEAL_TYPES.map((t) => ({ value: t.value, label: t.label })), { required: true }),
      text('orderNo', '订单号', '申诉', { required: true, maxLength: 80 }),
      money('amountCents', '涉及金额', '申诉', { required: true, help: '没有金额填 0' }),
      textarea('reason', '申诉理由', '申诉', { required: true, maxLength: 1000 }),
      date('deadlineDate', '平台申诉截止日', '申诉', { help: '平台页面上的倒计时截止日；填了会按这一天提醒和监督' }),
      { key: 'parentId', label: '复议的原申诉', type: 'number', group: '申诉', help: '只有“申诉复议”需要' },
    ],
    stepFields: {
      submit: [
        text('platformAppealNo', '平台申诉单号', '提交平台', { required: true, maxLength: 80 }),
        date('submittedAt', '提交平台日期', '提交平台', { required: true }),
      ],
      result: [
        select('result', '平台结果', '结果', o('approved:申诉通过', 'rejected:申诉驳回'), { required: true }),
        textarea('resultNote', '结果说明', '结果', { maxLength: 500, help: '驳回时写明平台给的理由，方便决定要不要复议' }),
      ],
    },
    steps: [
      { key: 'apply', name: '登记申诉', type: 'submit', assignee: { source: 'requester' }, locked: true },
      { key: 'review', name: '举证复核', type: 'approval', dueMinutes: 1440, locked: true },
      { key: 'submit', name: '提交平台', type: 'execute', dueMinutes: 1440, locked: true },
      { key: 'result', name: '登记结果', type: 'execute', dueMinutes: 10080, locked: true },
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
      else if (!ASSIGNEE_SOURCE_LABEL[a.source]) errors.push(`${label}的办理人类型不支持`);
      else if (a.source === 'position_type') { if (!a.key || !POSITION_TYPE_LABEL[a.key]) errors.push(`${label}要选择岗位类型`); }
      else if (a.source === 'related_owner') {
        const kind = a.key ? RELATED_OWNER_KINDS[a.key] : undefined;
        const f = template.fields.find((x) => x.key === a.field);
        if (!kind) errors.push(`${label}要选择关联资料负责人的种类`);
        else if (!f || f.type !== 'ref' || f.ref !== kind.type) errors.push(`${label}要选择发起表单里指向${kind.label.replace('关联', '').replace('负责人', '')}资料的字段`);
      }
      else if (!ASSIGNEE_NO_TARGET.includes(a.source) && !(Number.isInteger(a.id) && (a.id as number) > 0)) errors.push(`${label}要选择具体的${ASSIGNEE_SOURCE_LABEL[a.source].replace('指定', '').replace('按', '')}`);
      if (s.mode === 'all' && a?.source !== 'department') errors.push(`${label}只有指定部门才能设置全员会签`);
      if (a?.source === 'previous_handler' && i === 1) errors.push(`${label}不能选“上一步办理人”（上一步是发起人）`);
    }
    if (s.mode && s.mode !== 'any' && s.mode !== 'all') errors.push(`${label}的办理方式不支持`);
    if (s.when) {
      if (s.type === 'submit' || s.type === 'end') errors.push(`${label}不能带条件`);
      else errors.push(...validateCondition(template, steps, i, s.when).map((m) => `${label}${m}`));
    }
    if (s.returnToKey) {
      const target = steps.findIndex((x) => x.key === s.returnToKey);
      if (target < 0 || target >= i || steps[target].type === 'end') errors.push(`${label}的退回目标必须是前面的步骤`);
    }
    if (s.parallel != null && s.parallel !== '' && !/^[a-z][a-z0-9_]{0,30}$/.test(s.parallel)) errors.push(`${label}的并行分支编号不合法`);
    if (s.remind) errors.push(...validateRemind(s.remind, s.dueMinutes).map((m) => `${label}${m}`));
    if (s.hiddenFields && (!Array.isArray(s.hiddenFields) || s.hiddenFields.some((k) => !template.fields.some((f) => f.key === k)))) errors.push(`${label}的隐藏字段不存在`);
  });
  // 模板要求保留的步骤必须都在，且相对顺序不变；admin 只能增删没有 locked 的审批步骤
  const locked = template.custom ? [] : template.steps.filter((s) => s.locked);
  const actualLocked = steps.filter((s) => locked.some((l) => l.key === s.key));
  if (actualLocked.length !== locked.length) errors.push(`缺少业务必须的步骤：${locked.filter((l) => !steps.some((s) => s.key === l.key)).map((l) => l.name).join('、')}`);
  else if (!locked.every((l, i) => actualLocked[i].key === l.key)) errors.push('业务必须的步骤顺序不能改');
  for (const l of locked) {
    const s = steps.find((x) => x.key === l.key);
    if (s && s.type !== l.type) errors.push(`步骤「${l.name}」的类型不能改`);
    if (s && (s.when || s.returnToKey || s.mode === 'all' || s.hiddenFields?.length)) errors.push(`业务必须的步骤「${l.name}」不能设置条件、退回目标、会签或隐藏字段`);
  }
  for (const s of steps) {
    if (template.custom) {
      if (s.type !== 'submit' && s.type !== 'end' && !['approval', 'execute', 'finance'].includes(s.type)) errors.push(`步骤「${s.name}」的类型不支持`);
    } else if (!locked.some((l) => l.key === s.key) && s.type !== 'approval') errors.push(`新增的步骤「${s.name}」只能是审批类型`);
  }
  errors.push(...validateGraph(steps));
  if (escalateUserIds.length > 5) errors.push('超时升级最多通知 5 人');
  return errors;
}

/** 并行分支与异常连线的结构校验 */
export function validateGraph(steps: readonly StepDef[]): string[] {
  const errors: string[] = [];
  const groups = new Map<string, number[]>();
  steps.forEach((s, i) => { if (s.parallel) groups.set(s.parallel, [...(groups.get(s.parallel) ?? []), i]); });
  for (const [g, idx] of groups) {
    const name = `并行分支「${g}」`;
    if (idx.length < 2) errors.push(`${name}至少要有 2 个步骤`);
    else if (idx[idx.length - 1] - idx[0] !== idx.length - 1) errors.push(`${name}的步骤必须相邻`);
    for (const i of idx) {
      const s = steps[i];
      if (s.type === 'submit' || s.type === 'end') errors.push(`${name}里不能放${STEP_TYPE_LABEL[s.type]}步骤`);
      if (s.locked) errors.push(`业务必须的步骤「${s.name}」不能放进并行分支`);
      if (s.onlyOnException) errors.push(`仅异常步骤「${s.name}」不能放进并行分支`);
      if (s.exceptionToKey) errors.push(`并行分支里的步骤「${s.name}」不能设置异常连线`);
      if (s.returnToKey) {
        const t = steps.findIndex((x) => x.key === s.returnToKey);
        if (t >= idx[0] && t <= idx[idx.length - 1]) errors.push(`步骤「${s.name}」的退回目标不能是同一并行分支里的步骤`);
      }
      if (s.assignee?.source === 'previous_handler') errors.push(`并行分支里的步骤「${s.name}」不能选“上一步办理人”`);
    }
  }
  steps.forEach((s, i) => {
    if (s.exceptionToKey) {
      const t = steps.findIndex((x) => x.key === s.exceptionToKey);
      if (t < 0 || !steps[t].onlyOnException) errors.push(`步骤「${s.name}」的异常连线必须指向一个“仅异常”步骤`);
      if (s.onlyOnException) errors.push(`仅异常步骤「${s.name}」不能再设置异常连线`);
    }
    if (s.onlyOnException) {
      if (s.type === 'submit' || s.type === 'end') errors.push(`${STEP_TYPE_LABEL[s.type]}步骤不能设为仅异常`);
      else if (!steps.some((x) => x.exceptionToKey === s.key)) errors.push(`仅异常步骤「${s.name}」没有任何步骤的异常连线指向它`);
      if (s.when) errors.push(`仅异常步骤「${s.name}」不能带条件`);
    }
    void i;
  });
  return errors;
}

/** 步骤时限的人话 */
export function formatMinutes(m: number | null | undefined): string {
  if (!m) return '不限时';
  if (m % 1440 === 0) return `${m / 1440} 天`;
  if (m % 60 === 0) return `${m / 60} 小时`;
  return `${m} 分钟`;
}


// ================= 条件分支与督促时效 =================

const CONDITION_REF = /^(payload\.([A-Za-z][A-Za-z0-9]*)|form\.([a-z][a-z0-9_]*)\.([A-Za-z][A-Za-z0-9]*))$/;

/** 校验第 index 步的条件：引用的字段必须真实存在（发起字段，或前面步骤的办理字段） */
export function validateCondition(template: FlowTemplate, steps: readonly StepDef[], index: number, c: StepCondition): string[] {
  if (!c || typeof c !== 'object') return ['的条件写法不对'];
  const m = typeof c.field === 'string' ? CONDITION_REF.exec(c.field) : null;
  if (!m) return ['的条件没有选择取值字段'];
  if (!CONDITION_OP_LABEL[c.op]) return ['的条件运算不支持'];
  if (m[2]) {
    if (!template.fields.some((f) => f.key === m[2])) return [`的条件引用的字段「${m[2]}」不存在`];
  } else {
    const at = steps.findIndex((x) => x.key === m[3]);
    if (at < 0 || at >= index) return [`的条件引用的步骤「${m[3]}」必须在它前面`];
    if (!(template.stepFields[m[3]] ?? []).some((f) => f.key === m[4])) return [`的条件引用的办理字段「${m[4]}」不存在`];
  }
  if (c.op === 'empty' || c.op === 'notempty') return [];
  if (c.op === 'in') return Array.isArray(c.value) && c.value.length > 0 && c.value.length <= 20 ? [] : ['的条件要给出至少一个候选值'];
  if (typeof c.value !== 'number' && typeof c.value !== 'string') return ['的条件要填比较值'];
  if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && !Number.isFinite(Number(c.value))) return ['的条件比较值必须是数字'];
  return [];
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** 判断条件是否满足。ctx.forms：已办理步骤的表单（按步骤编号）。取不到值时：大小比较为否，“不等于”为真。 */
export function evalCondition(c: StepCondition, ctx: { payload: Record<string, unknown>; forms: Record<string, Record<string, unknown> | null | undefined> }): boolean {
  const m = CONDITION_REF.exec(c.field);
  if (!m) return false;
  const v = m[2] ? ctx.payload[m[2]] : ctx.forms[m[3]]?.[m[4]];
  if (c.op === 'empty') return isEmpty(v);
  if (c.op === 'notempty') return !isEmpty(v);
  if (c.op === 'in') return Array.isArray(c.value) && !isEmpty(v) && c.value.some((x) => String(x) === String(v));
  if (c.op === 'eq') return !isEmpty(v) && String(v) === String(c.value);
  if (c.op === 'ne') return isEmpty(v) || String(v) !== String(c.value);
  if (isEmpty(v)) return false;
  const a = Number(v), b = Number(c.value);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return c.op === 'gt' ? a > b : c.op === 'gte' ? a >= b : c.op === 'lt' ? a < b : a <= b;
}

/** 督促时效：提前提醒最多 3 次，必须比时限小；超时重复间隔 1 到 1440 分钟 */
export function validateRemind(r: StepRemind, dueMinutes?: number | null): string[] {
  const errors: string[] = [];
  if (!r || !Array.isArray(r.beforeMinutes) || r.beforeMinutes.length > 3) return ['的督促提醒最多提前提醒 3 次'];
  if (r.beforeMinutes.length > 0 && !dueMinutes) errors.push('要设了处理时限才能提前提醒');
  for (const m of r.beforeMinutes) {
    if (!Number.isInteger(m) || m < 1 || (dueMinutes && m >= dueMinutes)) errors.push('的提前提醒必须是小于处理时限的整数分钟');
  }
  if (new Set(r.beforeMinutes).size !== r.beforeMinutes.length) errors.push('的提前提醒时间不能重复');
  if (r.overdueEveryMinutes != null && (!Number.isInteger(r.overdueEveryMinutes) || r.overdueEveryMinutes < 1 || r.overdueEveryMinutes > 1440)) errors.push('的超时提醒间隔必须是 1 到 1440 分钟');
  return errors;
}
