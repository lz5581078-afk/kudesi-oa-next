import type { FieldDef, Option } from './resources';
import type { StepType } from './flow';
import { NODE_TEMPLATE_CATEGORIES, type NodeTemplate } from './flow-custom';

// 旧系统节点中心（shared/workflow-node-catalog.json，52 个业务节点模板）的迁移结果。数据放这里，不放迁移。
// 其中 11 个通用节点（审批确认、主管审批、老板审批、财务审批、付款记账、仓库入库、上传资料、营业执照照片上传、财务复核、费用报销、质检确认）
// 已经在 flow-custom.ts 的内置模板里，这里不重复；其余 41 个全部在下面。
/** 旧系统节点模板用到的字段（非业务专用组件部分），迁成新系统字段目录，设计流程时可直接加入 */
export const LEGACY_FIELD_CATALOG: ReadonlyArray<FieldDef> = [
  { key: 'purchaseCompany', label: '采购公司', type: 'text', group: '旧版字段' },
  { key: 'supplierName', label: '供应商', type: 'text', group: '旧版字段' },
  { key: 'goodsName', label: '商品名称', type: 'text', group: '旧版字段' },
  { key: 'quantity', label: '数量', type: 'number', group: '旧版字段' },
  { key: 'unit', label: '单位', type: 'text', group: '旧版字段' },
  { key: 'unitPrice', label: '单价', type: 'money', group: '旧版字段' },
  { key: 'amount', label: '金额', type: 'money', group: '旧版字段' },
  { key: 'expectedArrivalDate', label: '预计到货日', type: 'date', group: '旧版字段' },
  { key: 'attachment', label: '附件', type: 'files', group: '旧版字段' },
  { key: 'remark', label: '备注', type: 'textarea', group: '旧版字段' },
  { key: 'paymentAccount', label: '付款账户', type: 'ref', group: '旧版字段', ref: 'bank-accounts' },
  { key: 'paymentAmount', label: '付款金额', type: 'money', group: '旧版字段' },
  { key: 'paymentVoucher', label: '付款凭证', type: 'files', group: '旧版字段' },
  { key: 'receivedQuantity', label: '实收数量', type: 'number', group: '旧版字段' },
  { key: 'packageCount', label: '件数', type: 'number', group: '旧版字段' },
  { key: 'inboundDifference', label: '差异说明', type: 'textarea', group: '旧版字段' },
  { key: 'inboundPhoto', label: '收货照片', type: 'files', group: '旧版字段' },
  { key: 'qualityResult', label: '质检结果', type: 'select', group: '旧版字段', options: [{ value: 'ok', label: '合格' }, { value: 'abnormal', label: '异常' }] as Option[] },
  { key: 'qualityRemark', label: '质检备注', type: 'textarea', group: '旧版字段' },
  { key: 'freightAmount', label: '运费金额', type: 'money', group: '旧版字段' },
  { key: 'handlingAmount', label: '装卸费金额', type: 'money', group: '旧版字段' },
  { key: 'notRequiredReason', label: '无需处理原因', type: 'textarea', group: '旧版字段' },
  { key: 'financeReviewResult', label: '财务复核结果', type: 'select', group: '旧版字段', options: [{ value: 'ok', label: '通过' }, { value: 'bad', label: '有问题' }] as Option[] },
  { key: 'offsetAmount', label: '冲抵金额', type: 'money', group: '旧版字段' },
  { key: 'costAmount', label: '入库成本', type: 'money', group: '旧版字段' },
  { key: 'approvalComment', label: '审批意见', type: 'textarea', group: '旧版字段' },
  { key: 'applicant', label: '申请人', type: 'text', group: '旧版字段' },
  { key: 'businessReason', label: '业务原因', type: 'textarea', group: '旧版字段' },
  { key: 'feeType', label: '费用类型', type: 'text', group: '旧版字段' },
  { key: 'payeeName', label: '收款人', type: 'text', group: '旧版字段' },
  { key: 'payeeAccount', label: '收款账户', type: 'text', group: '旧版字段' },
  { key: 'storeName', label: '店铺名称', type: 'text', group: '旧版字段' },
  { key: 'platform', label: '平台', type: 'text', group: '旧版字段' },
  { key: 'licenseName', label: '营业执照', type: 'text', group: '旧版字段' },
  { key: 'qualificationName', label: '资质名称', type: 'text', group: '旧版字段' },
  { key: 'renewDueDate', label: '续期到期日', type: 'date', group: '旧版字段' },
  { key: 'phoneNumber', label: '手机号', type: 'text', group: '旧版字段' },
  { key: 'rechargeAmount', label: '充值金额', type: 'money', group: '旧版字段' },
  { key: 'serviceName', label: '服务名称', type: 'text', group: '旧版字段' },
  { key: 'orderNumber', label: '订单号', type: 'text', group: '旧版字段' },
  { key: 'refundAmount', label: '退款金额', type: 'money', group: '旧版字段' },
  { key: 'afterSaleReason', label: '售后原因', type: 'textarea', group: '旧版字段' },
  { key: 'screenshot', label: '截图', type: 'files', group: '旧版字段' },
];

export interface LegacyNode { key: string; name: string; description: string; category: string; type: StepType; dueMinutes: number | null; fields: string[]; context: string[]; insertable: boolean; binding?: { flowKey: string; stepKey: string }; note?: string; legacyKey: string }
/** 旧系统 52 个业务节点模板（workflow-node-catalog）逐个迁入；字段和“能看到的内容”按旧定义；业务专用组件的节点只读，指向新系统对应的业务页面 */
export const LEGACY_NODES: readonly LegacyNode[] = [
  { key: 'exclusive_submit', name: '专属品领取申请', description: '选择基础商品并填写领取原因，覆盖该商品的规格、平台与带赠品组合。', category: '业务专用', type: 'submit', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'exclusive_submit', binding: { flowKey: 'product-exclusive', stepKey: 'apply' }, note: '业务专用表单节点，由对应业务页面办理，此处只读。' },
  { key: 'exclusive_approval', name: '老板审批专属期', description: '审批基础商品专属领取，选择专属有效期；支持退回和驳回。', category: '业务专用', type: 'approval', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'exclusive_approval', binding: { flowKey: 'product-exclusive', stepKey: 'approve' }, note: '业务专用表单节点，由对应业务页面办理，此处只读。' },
  { key: 'live_submit', name: '直播下播提交', description: '主播或中控报完下播后提交本场销售额、勾选订单、投流费用和时长；退回后修改下播报告再提交。', category: '业务专用', type: 'submit', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'live_submit', note: '直播场次/月结流程属于直播管理，由直播模块办理，此处只读。' },
  { key: 'live_review', name: '人事审核直播场次', description: '核对主播、中控所报销售额、订单合计、投流费用和时长，确定本场最终销售额（选其中一个或手填并写原因），通过后同一事务记录主播和中控提成；可退回修改。处理人在流程中心配置。', category: '业务专用', type: 'approval', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'live_review', note: '直播场次/月结流程属于直播管理，由直播模块办理，此处只读。' },
  { key: 'live_settle_submit', name: '提交直播提成结算单', description: '人事在直播管理生成当月提成结算单（按聚水潭退款、按原比例扣减），核对后提交审批；退回后可重新核对再提交。', category: '业务专用', type: 'submit', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'live_settle_submit', note: '直播场次/月结流程属于直播管理，由直播模块办理，此处只读。' },
  { key: 'live_settle_approval', name: '审批直播提成结算单', description: '核对当月每人提成、退款扣减和应发金额，通过后结算单锁定不能再改；可退回人事重新核对。处理人在流程中心配置。', category: '业务专用', type: 'approval', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'live_settle_approval', note: '直播场次/月结流程属于直播管理，由直播模块办理，此处只读。' },
  { key: 'bundle_sales', name: '运营申请SKU', description: '按规格批量申请主商品和赠品，复制规格并查重。', category: '业务专用', type: 'submit', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'bundle_sales', binding: { flowKey: 'sku-batch-apply', stepKey: 'apply' }, note: '业务专用表单节点，由对应业务页面办理，此处只读。' },
  { key: 'bundle_fulfillment', name: '仓库完善发货组成', description: '为规格配置包装、标签、打包材料及人工，支持批量应用和退回。', category: '业务专用', type: 'execute', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'bundle_fulfillment', binding: { flowKey: 'sku-batch-apply', stepKey: 'warehouse' }, note: '业务专用表单节点，由对应业务页面办理，此处只读。' },
  { key: 'bundle_review', name: '财务审核组合品', description: '核对明细、成本和资料版本，按行通过或退回，确认后生成已验证组合品。', category: '业务专用', type: 'finance', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'bundle_review', binding: { flowKey: 'sku-batch-apply', stepKey: 'review' }, note: '业务专用表单节点，由对应业务页面办理，此处只读。' },
  { key: 'form_submit', name: '发起填写', description: '用于发起人填写业务申请、上传附件和提交说明。', category: '通用节点', type: 'submit', dueMinutes: null, fields: ['purchaseCompany', 'supplierName', 'goodsName', 'quantity', 'unit', 'unitPrice', 'amount', 'expectedArrivalDate', 'attachment', 'remark'], context: [], insertable: false, legacyKey: 'form_submit' },
  { key: 'purchase_request_submit', name: '采购申请发起', description: '用于采购申请，默认填写供应商、商品、数量、单价、金额和预计到货日。', category: '通用节点', type: 'submit', dueMinutes: null, fields: ['purchaseCompany', 'supplierName', 'goodsName', 'quantity', 'unit', 'unitPrice', 'amount', 'expectedArrivalDate', 'attachment', 'businessReason', 'remark'], context: [], insertable: false, legacyKey: 'purchase_request_submit' },
  { key: 'expense_request_submit', name: '费用申请发起', description: '用于推广费、软件费、平台费用等费用申请。', category: '财务与费用', type: 'submit', dueMinutes: null, fields: ['feeType', 'amount', 'storeName', 'platform', 'licenseName', 'attachment', 'businessReason', 'remark'], context: [], insertable: false, legacyKey: 'expense_request_submit', binding: { flowKey: 'expense-request', stepKey: 'apply' } },
  { key: 'store_open_submit', name: '店铺申请发起', description: '用于新开店铺、店铺资料补充和平台入驻申请。', category: '店铺与资料', type: 'submit', dueMinutes: null, fields: ['platform', 'storeName', 'licenseName', 'phoneNumber', 'qualificationName', 'attachment', 'remark'], context: [], insertable: false, legacyKey: 'store_open_submit' },
  { key: 'qualification_renew_submit', name: '资质续期发起', description: '用于资质、证照、平台开户资料到期续期申请。', category: '店铺与资料', type: 'submit', dueMinutes: null, fields: ['qualificationName', 'licenseName', 'storeName', 'renewDueDate', 'attachment', 'remark'], context: [], insertable: false, legacyKey: 'qualification_renew_submit' },
  { key: 'aftersale_refund_submit', name: '售后退款发起', description: '用于售后退款、补偿、异常订单处理申请。', category: '店铺与资料', type: 'submit', dueMinutes: null, fields: ['platform', 'storeName', 'orderNumber', 'refundAmount', 'afterSaleReason', 'screenshot', 'remark'], context: [], insertable: false, legacyKey: 'aftersale_refund_submit', binding: { flowKey: 'after-sales', stepKey: 'apply' } },
  { key: 'purchase_prepayment', name: '采购预付款', description: '用于采购流程中出纳付款，并自动生成供应商预付款。', category: '财务与费用', type: 'finance', dueMinutes: null, fields: ['paymentAccount', 'paymentAmount', 'paymentVoucher', 'remark'], context: ['purchaseCompany', 'supplierName', 'goodsName', 'amount', 'payeeName', 'payeeAccount'], insertable: true, legacyKey: 'purchase_prepayment' },
  { key: 'freight_payment', name: '运费付款', description: '用于采购、退货、调拨等产生的运费付款。', category: '财务与费用', type: 'finance', dueMinutes: null, fields: ['paymentAccount', 'paymentAmount', 'paymentVoucher', 'remark'], context: ['supplierName', 'storeName', 'freightAmount', 'payeeName', 'payeeAccount'], insertable: true, legacyKey: 'freight_payment' },
  { key: 'promotion_payment', name: '推广费付款', description: '用于店铺推广费、平台充值、广告费付款。', category: '财务与费用', type: 'finance', dueMinutes: null, fields: ['paymentAccount', 'paymentAmount', 'paymentVoucher', 'remark'], context: ['platform', 'storeName', 'feeType', 'amount'], insertable: true, legacyKey: 'promotion_payment' },
  { key: 'software_renew_payment', name: '软件续费付款', description: '用于聚水潭、云服务、账号服务等续费付款。', category: '财务与费用', type: 'finance', dueMinutes: null, fields: ['paymentAccount', 'paymentAmount', 'paymentVoucher', 'remark'], context: ['serviceName', 'renewDueDate', 'amount'], insertable: true, legacyKey: 'software_renew_payment' },
  { key: 'purchase_inbound', name: '采购收货入库', description: '用于采购到货后仓库收货，只显示数量和收货信息，不显示采购金额。', category: '采购与仓库', type: 'execute', dueMinutes: null, fields: ['receivedQuantity', 'packageCount', 'inboundDifference', 'inboundPhoto', 'remark'], context: ['supplierName', 'goodsName', 'quantity', 'unit', 'expectedArrivalDate'], insertable: true, legacyKey: 'purchase_inbound' },
  { key: 'return_inbound', name: '售后退货收货', description: '用于售后退货、客户退回货物收货和异常件登记。', category: '采购与仓库', type: 'execute', dueMinutes: null, fields: ['receivedQuantity', 'packageCount', 'inboundPhoto', 'inboundDifference', 'remark'], context: ['platform', 'storeName', 'orderNumber', 'goodsName'], insertable: true, legacyKey: 'return_inbound' },
  { key: 'qualification_upload', name: '资质资料上传', description: '用于资质备案、证书、平台开户资料上传。', category: '店铺与资料', type: 'execute', dueMinutes: null, fields: ['attachment', 'renewDueDate', 'remark'], context: ['qualificationName', 'licenseName', 'storeName'], insertable: true, legacyKey: 'qualification_upload' },
  { key: 'purchase_finance_review', name: '采购入库财务复核', description: '用于财务复核采购付款、入库数量、运费装卸费并冲抵预付款。', category: '财务与费用', type: 'finance', dueMinutes: null, fields: ['financeReviewResult', 'offsetAmount', 'costAmount', 'remark'], context: ['purchaseCompany', 'supplierName', 'goodsName', 'quantity', 'unitPrice', 'amount', 'paymentAmount', 'receivedQuantity', 'freightAmount', 'handlingAmount'], insertable: true, legacyKey: 'purchase_finance_review' },
  { key: 'join', name: '汇合检查', description: '用于等待多个分支全部完成，再进入完结或下一步。', category: '通用节点', type: 'execute', dueMinutes: null, fields: [], context: ['remark'], insertable: false, legacyKey: 'join', note: '新系统的并行分支会在所有分支办完后自动汇合，不需要单独的汇合节点。' },
  { key: 'exception', name: '异常处理', description: '用于处理超时、质检异常、入库差异、资料不完整等异常。', category: '采购与仓库', type: 'execute', dueMinutes: null, fields: ['remark'], context: ['inboundDifference', 'qualityResult', 'qualityRemark'], insertable: true, legacyKey: 'exception', note: '配合“异常连线”使用：把这一步设为“仅异常”步骤，再在会出异常的步骤上指向它。' },
  { key: 'end', name: '完结归档', description: '用于流程结束、归档和最终留痕。', category: '通用节点', type: 'end', dueMinutes: null, fields: [], context: ['remark'], insertable: false, legacyKey: 'end', note: '流程最后的“结束”步骤由系统固定提供。' },
  { key: 'purchase_submit', name: '采购申请', description: '发起人只填写需要采购的商品、数量和要求到货日期', category: '业务专用', type: 'submit', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_submit', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_plan', name: '完善采购方案', description: '根据采购需求确认供应商、报价、收货仓库和付款资料，提交老板审核', category: '业务专用', type: 'finance', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_plan', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_approval', name: '采购批准', description: '审核采购内容、金额与付款安排', category: '业务专用', type: 'approval', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_approval', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_payment', name: '采购货款安排', description: '确认新付款或选择已有预付款，挂采购入库草稿', category: '业务专用', type: 'finance', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_payment', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_prepayment_review', name: '预付款使用确认', description: '核对供应商预付款占用及使用金额', category: '业务专用', type: 'finance', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_prepayment_review', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_dispatch', name: '采购发货跟进', description: '登记供应商承诺日期与发货凭证', category: '业务专用', type: 'execute', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_dispatch', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_arrival', name: '采购到货登记', description: '登记实际到货，启动收货时效', category: '业务专用', type: 'execute', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_arrival', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_receive', name: '采购收货核对', description: '分批记录实收数量及差异', category: '业务专用', type: 'execute', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_receive', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_quality', name: '采购质检', description: '核对合格与不合格数量，异常进入配置分支', category: '业务专用', type: 'execute', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_quality', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_exception', name: '采购异常处置', description: '确认换货、折价接收或重新检验', category: '业务专用', type: 'execute', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_exception', note: '采购异常处置属于采购申请中心的业务流程。' },
  { key: 'purchase_expense', name: '采购运费装卸费申报', description: '分收款对象申报采购运费及装卸费', category: '业务专用', type: 'execute', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_expense', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_settlement', name: '采购财务结算', description: '过账到货，冲抵预付款，更新商品及后续成本', category: '业务专用', type: 'finance', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_settlement', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_expense_payment', name: '采购费用付款', description: '实际支付后生成费用单并减少资金', category: '业务专用', type: 'finance', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_expense_payment', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
  { key: 'purchase_close', name: '采购批次结算检查', description: '检查记账及费用支付，进入下一批或归档', category: '业务专用', type: 'execute', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_close', note: '采购批次结算检查由采购申请中心的业务规则自动完成，不是人工节点。' },
  { key: 'purchase_refund', name: '采购预付款退款确认', description: '终止未到货部分后确认实际退款，冲减预付款并增加资金', category: '业务专用', type: 'finance', dueMinutes: null, fields: [], context: [], insertable: false, legacyKey: 'purchase_refund', note: '采购业务节点：由采购申请中心按业务规则办理，此处只读。' },
];

export const LEGACY_CATEGORY = '业务专用';
export const NODE_CENTER_CATEGORIES: readonly string[] = [...NODE_TEMPLATE_CATEGORIES, LEGACY_CATEGORY];
const ALL_LEGACY_FIELDS = new Map(LEGACY_FIELD_CATALOG.map((f) => [f.key, f]));
const labelOf = (k: string) => ALL_LEGACY_FIELDS.get(k)?.label ?? k;

/** 迁入后的内置只读节点模板；insertable=false 的只能查看（发起、汇合、结束、业务专用表单） */
export const LEGACY_NODE_TEMPLATES: readonly NodeTemplate[] = LEGACY_NODES.map((n) => ({
  key: n.key, name: n.name, description: n.description, category: n.category, type: n.type, dueMinutes: n.dueMinutes,
  fields: n.fields.map((k) => ({ ...ALL_LEGACY_FIELDS.get(k)! })), builtin: true, insertable: n.insertable,
  context: n.context.map(labelOf), ...(n.binding ? { binding: n.binding } : {}), ...(n.note ? { note: n.note } : {}),
}));
