import { validUnitCents } from './unit-price';
/**
 * 资料（基础资源）定义：前后端共用的唯一来源。
 * 一个资源 = 一份配置（字段、状态、规则），列表/详情/表单/校验/导入导出都从它生成，
 * 不再像旧系统那样每个资料页各写 2000~3000 行。
 *
 * 字段类型：
 * - text / textarea / number / date(YYYY-MM-DD) / monthday(MM-DD) / bool / select
 * - money：整数分（界面按元输入）
 * - phone：号码，规范化为纯数字
 * - ref：引用另一条资料（ref=资源 key）或员工（ref='user'），写入时同步 resource_links
 * - secret：密码类，加密存储，任何接口都不返回，只返回“已设置”；查看明文要 secret 权限并写审计
 * - sensitive：证件号/银行卡号，加密存储（防止数据库泄露），但对有查看权限的人明文显示，不做脱敏
 */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'decimal'
  | 'money'
  | 'date'
  | 'monthday'
  | 'bool'
  | 'select'
  | 'phone'
  | 'ref'
  | 'refs'
  | 'files'
  | 'attrs'
  /** 流程表单里的结构化清单（如 SKU 申请的规格）：整体当 JSON 存取，具体内容由对应流程的校验函数检查 */
  | 'json'
  | 'secret'
  | 'sensitive';

export interface Option {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  group: string;
  required?: boolean;
  options?: readonly Option[];
  /** 下拉可多选：保存为用顿号连接的选项值（按选项顺序、去重） */
  multi?: boolean;
  /** type=ref：目标资源 key，或 'user'（员工） */
  ref?: string;
  /** 在列表中显示的默认列 */
  list?: boolean;
  /** 参与关键词搜索 */
  search?: boolean;
  maxLength?: number;
  /** 由系统计算，表单里不显示、提交的值会被忽略（如利润） */
  readonly?: boolean;
  /** type=decimal：小数位数上限（默认 4） */
  scale?: number;
  /** 要有这个权限键才看得到/改得了这个字段（如成本字段需要 product.cost.view）；服务端强制，不只是前端隐藏 */
  permission?: string;
  /** 要有这个权限才能修改（不设则同 permission）；没有时提交的值被丢弃 */
  writePermission?: string;
  /** type=attrs：属性名来自所选分类（本记录里这个引用字段指向的记录）的 customFields（逗号分隔）；值是 名称→内容 */
  attrsFrom?: string;
  /** type=files：最多几个文件（默认 9） */
  maxFiles?: number;
  /** type=files：只收图片，还是图片和 PDF 都收（默认都收） */
  accept?: 'image' | 'any';
  /** 仅当另一个字段（或 status）取这些值时才显示/保存，不满足时服务端清空 */
  showWhen?: { field: string; in: readonly string[] };
  help?: string;
}

export interface StatusDef extends Option {
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  /** 切换到该状态必须填写原因（停用/注销/解除合作等） */
  requiresReason?: boolean;
  /** 默认在列表中隐藏（可通过“显示停用”打开） */
  hidden?: boolean;
}

export interface ResourceDef {
  key: string;
  label: string;
  /** 资料左侧菜单分组；没有则不出现在菜单（子资源，在父资源详情里管理） */
  /** hidden：不单独出现在资料菜单里（如银行卡按类型拆成多个入口、店铺经营数据挂在店铺详情里），但仍有自己的权限 */
  nav?: { group: string; section?: 'finance'; hidden?: boolean };
  /** 子资源：属于哪个父资源（引用字段 key），只在父详情里展示 */
  parent?: { type: string; field: string };
  /** 用作标题的字段 */
  titleField: string;
  /** 公司内唯一的字段（重复返回 409）；phone 类型会先规范化 */
  uniqueField?: string;
  /** 组合唯一：这些字段值同时相同则拒绝 */
  uniqueTogether?: Array<{ fields: string[]; message: string }>;
  statuses: readonly StatusDef[];
  defaultStatus: string;
  fields: readonly FieldDef[];
  /** 列表上方的分类页签（按某个选项字段分组） */
  tabsBy?: string;
  /** 列表上方的下拉筛选：关联字段（按所选节点及其所有下级筛）或选项字段（如固定资产按分类、商品按分类和采购方式） */
  filterBy?: string | readonly string[];
  /** 分类目录随页签显示哪些“所属类型”的分类（页签值与分类的所属类型不一一对应时用，如外购成品含原装采购和供应商 OEM 两棵树） */
  treeTabMap?: Record<string, readonly string[]>;
  /** 列表勾选后可批量做的事：status=批量停用/启用（要填原因），其余是批量修改这个字段（如移动分类） */
  batch?: readonly string[];
  /** 预警：状态异常，或某日期字段在 N 天内到期 */
  alerts?: Array<{ field: string; withinDays: number; label: string }>;
  /** 详情页展示这些子资源 */
  children?: readonly string[];
  /** 详情页额外展示的相关资料页签：别的资料里指向本资料的记录（按它自己的权限显示） */
  related?: ReadonlyArray<{ type: string; field: string }>;
  /** 列表按这个日期字段倒序（不设则按新建先后） */
  sortField?: string;
}

import { FINANCE_RESOURCE_DEFS } from './finance-resources';
import { ABNORMAL, CANCELLED, INACTIVE, NORMAL, NOTE, attrs, date, files, money, o, ref, secret, select, sensitive, text, textarea } from './resource-kit';

const PLATFORMS = o('pdd:拼多多', 'taobao:淘宝', 'tmall:天猫', 'douyin:抖音', 'jd:京东', 'kuaishou:快手', 'xhs:小红书', 'other:其他');
const RECONCILE = o('monthly:按月', 'quarterly:按季', 'yearly:按年');
const SEAL_STATE = o('kept:在位', 'ordinary_kept:普通章在位', 'missing:缺失');
const SEAL_KIND = o('anti_fake:防伪章', 'self_carved:自刻章');
const MATERIAL = o('kept:在位', 'missing:缺失');

function sealFields(prefix: string, label: string): FieldDef[] {
  return [
    select(`${prefix}State`, `${label}状态`, '印章', SEAL_STATE),
    select(`${prefix}Kind`, `${label}种类`, '印章', SEAL_KIND),
    ref(`${prefix}LocationId`, `${label}位置`, '印章', 'locations'),
  ];
}

export const RESOURCE_DEFS: readonly ResourceDef[] = [
  ...FINANCE_RESOURCE_DEFS,
  {
    key: 'licenses',
    label: '营业执照',
    nav: { group: '经营资料' },
    titleField: 'companyName',
    uniqueField: 'creditCode',
    tabsBy: 'category',
    statuses: [NORMAL, ABNORMAL, CANCELLED, INACTIVE],
    defaultStatus: 'normal',
    children: ['license-borrows', 'license-usages'],
    related: [
      { type: 'stores', field: 'licenseId' },
      { type: 'bank-accounts', field: 'licenseId' },
      { type: 'qualifications', field: 'licenseId' },
      { type: 'tax-profiles', field: 'licenseId' },
      { type: 'partners', field: 'licenseId' },
      { type: 'archives', field: 'licenseId' },
    ],
    fields: [
      select('category', '执照类别', '基础', o('operation:经营执照', 'ecommerce:电商执照'), { required: true, list: true }),
      text('licenseNo', '执照编号', '基础', { list: true, search: true }),
      text('companyName', '主体名称', '基础', { required: true, list: true, search: true }),
      text('creditCode', '统一社会信用代码', '基础', { required: true, list: true, search: true, maxLength: 32 }),
      text('legalPerson', '法人', '基础', { required: true, list: true, search: true }),
      text('licenseType', '类型', '基础'),
      text('registeredCapital', '注册资本', '基础'),
      text('address', '地址', '基础'),
      textarea('businessScope', '经营范围', '基础'),
      date('foundedAt', '成立日期', '基础'),
      date('approvedAt', '核准日期', '基础'),
      text('registrar', '登记机关', '基础'),
      { key: 'annualAuditDay', label: '年审日期(月-日)', type: 'monthday', group: '基础', list: true },
      textarea('abnormalReason', '异常原因', '基础', { showWhen: { field: 'status', in: ['abnormal'] } }),
      text('legalPhone', '法人预留手机', '基础', { search: true }),
      ref('locationId', '存放总位置', '实物', 'locations', { list: true, help: '改总位置时，位置为空或和旧总位置相同的正本、副本位置会跟着改' }),
      files('originalPhoto', '正本照片', '照片', { accept: 'image', maxFiles: 1 }),
      files('copyPhoto', '副本照片', '照片', { accept: 'image', maxFiles: 1 }),
      select('originalState', '正本', '实物', MATERIAL),
      ref('originalLocationId', '正本位置', '实物', 'locations'),
      select('copyState', '副本', '实物', MATERIAL),
      ref('copyLocationId', '副本位置', '实物', 'locations'),
      ref('sealLocationId', '印章总位置', '印章', 'locations', { help: '改印章总位置时，位置为空或和旧总位置相同、且未缺失的印章位置会跟着改' }),
      ...sealFields('official', '公章'),
      ...sealFields('finance', '财务章'),
      ...sealFields('legal', '法人章'),
      ...sealFields('invoice', '发票章'),
      textarea('sealNote', '印章备注', '印章'),
      select('ktBoard', 'KT 板', 'KT 板', o('none:无', 'owned:有')),
      ref('ktBoardLocationId', 'KT 板位置', 'KT 板', 'locations'),
      textarea('ktBoardNote', 'KT 板备注', 'KT 板'),
      text('publicAccountName', '对公账户名', '银行', { list: true }),
      text('publicAccountBank', '对公开户行', '银行'),
      sensitive('publicAccountNo', '对公账号', '银行'),
      text('legalCardName', '法人账户名', '银行'),
      text('legalCardBank', '法人开户行', '银行'),
      sensitive('legalCardNo', '法人银行卡号', '银行'),
      text('legalCardPhone', '法人卡预留手机', '银行'),
      select('reconcileCycle', '对账周期', '银行', RECONCILE),
      text('reconcileDay', '对账提醒日', '银行', { help: '月：几号；季/年：MM-DD', maxLength: 8 }),
      NOTE(),
    ],
  },
  {
    key: 'license-borrows',
    label: '借用记录',
    parent: { type: 'licenses', field: 'licenseId' },
    titleField: 'borrower',
    statuses: [
      { value: 'borrowed', label: '借出中', tone: 'warn' },
      { value: 'returned', label: '已归还', tone: 'ok' },
      { value: 'overdue', label: '逾期', tone: 'bad' },
    ],
    defaultStatus: 'borrowed',
    fields: [
      ref('licenseId', '营业执照', '基础', 'licenses', { required: true }),
      select('item', '借用物品', '基础', o('original:正本', 'copy:副本', 'official:公章', 'finance:财务章', 'legal:法人章', 'invoice:发票章'), { required: true, list: true }),
      text('borrower', '借用人', '基础', { required: true, list: true }),
      text('purpose', '用途', '基础', { required: true, list: true }),
      date('borrowedAt', '借用日期', '基础', { required: true, list: true }),
      date('expectedReturnAt', '预计归还', '基础', { list: true }),
      date('returnedAt', '实际归还', '基础'),
      NOTE(),
    ],
  },
  {
    key: 'license-usages',
    label: '使用记录',
    parent: { type: 'licenses', field: 'licenseId' },
    titleField: 'item',
    sortField: 'usedAt',
    statuses: [
      { value: 'done', label: '完成', tone: 'ok' },
      { value: 'pending', label: '待处理', tone: 'warn' },
      { value: 'abnormal', label: '异常', tone: 'bad' },
    ],
    defaultStatus: 'done',
    fields: [
      ref('licenseId', '营业执照', '基础', 'licenses', { required: true }),
      select('item', '使用物品', '基础', o('original:正本', 'copy:副本', 'official:公章', 'finance:财务章', 'legal:法人章', 'invoice:发票章', 'other:其他'), { required: true, list: true }),
      ref('userId', '使用人', '基础', 'user', { required: true, list: true }),
      select('usageType', '使用类型', '基础', o('bank:银行业务', 'tax:税务', 'platform:平台入驻', 'contract:合同', 'other:其他'), { list: true }),
      text('purpose', '用途', '基础', { required: true, list: true }),
      date('usedAt', '使用日期', '基础', { required: true, list: true }),
      NOTE(),
    ],
  },
  {
    key: 'stores',
    label: '店铺档案',
    nav: { group: '经营资料' },
    titleField: 'name',
    tabsBy: 'platform',
    statuses: [NORMAL, ABNORMAL, CANCELLED, INACTIVE],
    defaultStatus: 'normal',
    children: ['store-claims'],
    related: [
      { type: 'store-daily-metrics', field: 'storeId' },
      { type: 'store-promotions', field: 'storeId' },
      { type: 'store-scores', field: 'storeId' },
      { type: 'store-funds', field: 'storeId' },
    ],
    // 同一个手机号在同一平台只能绑一个店铺
    uniqueTogether: [{ fields: ['platform', 'phoneId'], message: '该手机号在这个平台已绑定了其他店铺' }],
    alerts: [
      { field: 'jushuitanExpireAt', withinDays: 30, label: '聚水潭授权即将到期' },
      { field: 'promotionReleaseAt', withinDays: 7, label: '推广限制即将解除' },
    ],
    fields: [
      select('platform', '平台', '基础', PLATFORMS, { required: true, list: true }),
      text('name', '店铺名', '基础', { required: true, list: true, search: true }),
      text('storeNo', '店铺编号', '基础', { list: true, search: true }),
      text('platformStoreId', '平台店铺 ID', '基础', { search: true, maxLength: 255 }),
      ref('licenseId', '所属执照', '基础', 'licenses', { list: true }),
      select('operatingStatus', '经营状态', '基础', o('operating:运营中', 'not_operating:未运营'), { list: true }),
      date('openedAt', '开店日期', '基础'),
      date('lastOrderAt', '最后出单日期', '基础'),
      text('url', '店铺网址', '基础'),
      ref('abnormalReason', '异常原因', '基础', 'store-abnormal-reasons', { showWhen: { field: 'status', in: ['abnormal'] } }),
      select('claimStatus', '领取状态', '领取', o('public:公共店铺', 'claimed:已领取', 'reserved:预留店铺', 'promotion_limited:推广限制店铺'), { list: true }),
      ref('operatorUserId', '运营人', '领取', 'user', { list: true, showWhen: { field: 'claimStatus', in: ['claimed', 'reserved', 'promotion_limited'] }, help: '只能选在职员工' }),
      date('promotionReleaseAt', '推广限制解除日', '领取', { showWhen: { field: 'claimStatus', in: ['promotion_limited'] } }),
      text('account', '店铺账号', '账号', { search: true }),
      secret('storePassword', '店铺密码', '账号'),
      secret('withdrawPassword', '提现支付密码', '账号'),
      text('phoneNumber', '绑定手机号', '账号', { help: '必须是已建档的手机号', search: true }),
      ref('phoneId', '手机号档案', '账号', 'phones'),
      select('jushuitan', '聚水潭', '授权与资质', o('connected:已连接', 'not_connected:未连接')),
      date('jushuitanExpireAt', '聚水潭到期日', '授权与资质'),
      text('trademark', '授权商标', '授权与资质'),
      date('trademarkExpireAt', '商标授权到期日', '授权与资质'),
      select('qualification', '资质上传', '授权与资质', o('not_uploaded:未上传', 'uploaded:已上传', 'reviewing:审核中', 'approved:已通过', 'rejected:被驳回', 'not_required:无需上传')),
      text('qualificationNote', '资质备注', '授权与资质'),
      files('qualificationFiles', '资质文件', '授权与资质', { maxFiles: 9 }),
      money('deposit', '保证金', '资金'),
      money('frozen', '冻结资金', '资金'),
      money('goodsFund', '货款', '资金'),
      money('promotionBalance', '推广费余额', '资金'),
      text('fundNote', '资金备注', '资金'),
      NOTE(),
    ],
  },
  {
    key: 'store-abnormal-reasons',
    label: '店铺异常原因',
    nav: { group: '经营资料', hidden: true },
    titleField: 'reason',
    uniqueField: 'reason',
    statuses: [NORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [text('reason', '异常原因', '基础', { required: true, list: true, search: true, maxLength: 100 })],
  },
  {
    key: 'phone-abnormal-reasons',
    label: '手机号异常原因',
    nav: { group: '账号与资质', hidden: true },
    titleField: 'reason',
    uniqueField: 'reason',
    statuses: [NORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [text('reason', '异常原因', '基础', { required: true, list: true, search: true, maxLength: 100 })],
  },
  {
    key: 'store-claims',
    label: '领退店记录',
    parent: { type: 'stores', field: 'storeId' },
    titleField: 'action',
    statuses: [{ value: 'recorded', label: '已记录', tone: 'ok' }],
    defaultStatus: 'recorded',
    fields: [
      ref('storeId', '店铺', '基础', 'stores', { required: true }),
      select('action', '类型', '基础', o('claim:领取', 'return:退店'), { required: true, list: true }),
      ref('userId', '员工', '基础', 'user', { list: true }),
      date('happenedAt', '日期', '基础', { required: true, list: true }),
      date('lastOrderAt', '最后出单日期', '基础'),
      text('product', '主营商品', '基础', { list: true }),
      NOTE(),
    ],
  },
  {
    key: 'store-daily-metrics',
    label: '店铺经营数据',
    nav: { group: '店铺经营数据', hidden: true },
    titleField: 'label',
    sortField: 'day',
    statuses: [{ value: 'recorded', label: '已记录', tone: 'ok' }],
    defaultStatus: 'recorded',
    uniqueTogether: [{ fields: ['storeId', 'day'], message: '这个店铺这一天已经有经营数据了，请直接修改' }],
    fields: [
      { key: 'label', label: '标题', type: 'text', group: '基础', readonly: true, search: true, maxLength: 200 },
      ref('storeId', '店铺', '基础', 'stores', { required: true, list: true }),
      date('day', '日期', '基础', { required: true, list: true }),
      { key: 'orders', label: '订单数', type: 'number', group: '经营', list: true },
      { key: 'visitors', label: '访客数', type: 'number', group: '经营' },
      money('sales', '销售额', '金额', { list: true }),
      money('refund', '退款', '金额', { list: true }),
      money('adCost', '推广费', '金额', { list: true }),
      money('platformFee', '平台费', '金额', { list: true }),
      money('purchaseCost', '采购成本', '金额', { list: true }),
      money('otherCost', '其他成本', '金额', { list: true }),
      { ...money('profit', '利润', '金额', { list: true, readonly: true }), help: '销售额 − 退款 − 推广费 − 平台费 − 采购成本 − 其他成本，自动计算' },
      select('source', '数据来源', '基础', o('manual:手工录入', 'import:导入', 'api:接口同步')),
      NOTE(),
    ],
  },
  {
    key: 'store-promotions',
    label: '店铺推广',
    nav: { group: '店铺经营数据', hidden: true },
    titleField: 'label',
    sortField: 'day',
    statuses: [{ value: 'recorded', label: '已记录', tone: 'ok' }],
    defaultStatus: 'recorded',
    uniqueTogether: [{ fields: ['storeId', 'day', 'campaign'], message: '这个店铺这一天这个推广计划已经有数据了，请直接修改' }],
    fields: [
      { key: 'label', label: '标题', type: 'text', group: '基础', readonly: true, search: true, maxLength: 200 },
      ref('storeId', '店铺', '基础', 'stores', { required: true, list: true }),
      date('day', '日期', '基础', { required: true, list: true }),
      text('campaign', '推广计划/渠道', '基础', { required: true, list: true, search: true }),
      money('spend', '花费', '数据', { list: true }),
      money('gmv', '成交额', '数据', { list: true }),
      { key: 'orders', label: '成交订单', type: 'number', group: '数据', list: true },
      { key: 'clicks', label: '点击', type: 'number', group: '数据' },
      { key: 'impressions', label: '展现', type: 'number', group: '数据' },
      { key: 'roiPercent', label: '投产比(%)', type: 'number', group: '数据', list: true, readonly: true, help: '成交额 ÷ 花费 × 100，自动计算' },
      select('source', '数据来源', '基础', o('manual:手工录入', 'import:导入', 'api:接口同步')),
      NOTE(),
    ],
  },
  {
    key: 'store-scores',
    label: '店铺评分',
    nav: { group: '店铺经营数据', hidden: true },
    titleField: 'label',
    sortField: 'snapshotDate',
    tabsBy: 'dimension',
    statuses: [{ value: 'recorded', label: '已记录', tone: 'ok' }],
    defaultStatus: 'recorded',
    fields: [
      { key: 'label', label: '标题', type: 'text', group: '基础', readonly: true, search: true, maxLength: 200 },
      ref('storeId', '店铺', '基础', 'stores', { required: true, list: true }),
      date('snapshotDate', '统计日期', '基础', { required: true, list: true }),
      select('dimension', '评分类别', '基础', o('growth:成长层级', 'experience:综合体验星级', 'navigator:商品领航员', 'aftersales:售后数据', 'reviews:评价数据', 'service:客服数据', 'consumer:消费者体验指标'), { required: true, list: true }),
      text('metric', '指标', '基础', { required: true, list: true, search: true }),
      text('value', '数值/等级', '基础', { list: true }),
      text('benchmark', '行业均值/目标', '基础', { list: true }),
      select('source', '数据来源', '基础', o('manual:手工录入', 'import:导入', 'api:接口同步')),
      NOTE(),
    ],
  },
  {
    key: 'store-funds',
    label: '店铺资金',
    nav: { group: '店铺经营数据', hidden: true },
    titleField: 'label',
    sortField: 'snapshotDate',
    statuses: [{ value: 'recorded', label: '已记录', tone: 'ok' }],
    defaultStatus: 'recorded',
    uniqueTogether: [{ fields: ['storeId', 'snapshotDate'], message: '这个店铺这一天已经有资金快照了，请直接修改' }],
    fields: [
      { key: 'label', label: '标题', type: 'text', group: '基础', readonly: true, search: true, maxLength: 200 },
      ref('storeId', '店铺', '基础', 'stores', { required: true, list: true }),
      date('snapshotDate', '统计日期', '基础', { required: true, list: true }),
      money('withdrawable', '可提现', '金额', { list: true }),
      money('deposit', '保证金', '金额', { list: true }),
      money('frozen', '冻结资金', '金额', { list: true }),
      money('promotion', '推广费余额', '金额', { list: true }),
      select('source', '数据来源', '基础', o('manual:手工录入', 'import:导入', 'api:接口同步')),
      NOTE(),
    ],
  },
  {
    key: 'phones',
    label: '手机号',
    nav: { group: '账号与资质' },
    titleField: 'number',
    uniqueField: 'number',
    tabsBy: 'usageType',
    statuses: [NORMAL, ABNORMAL, { ...INACTIVE, label: '停止使用' }],
    defaultStatus: 'normal',
    alerts: [{ field: 'nextRechargeAt', withinDays: 7, label: '7 天内需充值' }],
    related: [
      { type: 'phones', field: 'parentPhoneId' },
      { type: 'stores', field: 'phoneId' },
      { type: 'self-media', field: 'phoneId' },
      { type: 'wechat', field: 'phoneId' },
      { type: 'bank-accounts', field: 'phoneId' },
    ],
    fields: [
      { key: 'number', label: '号码', type: 'phone', group: '基础', required: true, list: true, search: true },
      select('usageType', '使用类型', '基础', o('company_kept:公司保存', 'personal_used:公司在使用', 'external_used:公司外人员使用', 'partner_used:合作手机号'), { required: true, list: true }),
      text('carrier', '运营商', '基础', { list: true }),
      text('plan', '套餐名', '基础'),
      text('region', '归属地', '基础'),
      text('certifiedName', '号码认证人', '基础'),
      ref('parentPhoneId', '主卡', '基础', 'phones', { help: '子卡才填，不能选自己' }),
      ref('assetId', '固定资产', '使用', 'fixed-assets', { showWhen: { field: 'usageType', in: ['company_kept'] } }),
      ref('areaLocationId', '保存区域', '使用', 'locations', { showWhen: { field: 'usageType', in: ['company_kept'] } }),
      ref('assetLocationId', '资产内位置', '使用', 'locations', { showWhen: { field: 'usageType', in: ['company_kept'] } }),
      ref('userId', '使用人', '使用', 'user', { list: true, showWhen: { field: 'usageType', in: ['personal_used'] } }),
      text('externalUser', '外部使用人', '使用', { list: true, showWhen: { field: 'usageType', in: ['external_used'] } }),
      text('deviceType', '手机设备类型', '使用', { showWhen: { field: 'usageType', in: ['external_used'] } }),
      select('forwardApp', '是否转发 App', '使用', o('yes:是', 'no:否'), { showWhen: { field: 'usageType', in: ['external_used'] } }),
      text('forwardAppName', '转发 App 名称', '使用', { showWhen: { field: 'usageType', in: ['external_used'] } }),
      ref('partnerId', '合作人', '使用', 'partners', { showWhen: { field: 'usageType', in: ['partner_used'] } }),
      ref('keeperUserId', '保管人', '使用', 'user'),
      text('keeperName', '保管人(手填)', '使用'),
      money('monthlyFee', '月费', '费用'),
      select('feeCycle', '费用周期', '费用', o('monthly:月付', 'quarterly:季付', 'yearly:年付')),
      date('lastRechargeAt', '最近充值日', '费用'),
      { key: 'rechargeCycleDays', label: '充值周期(天)', type: 'number', group: '费用' },
      date('nextRechargeAt', '下次充值日', '费用', { list: true, help: '由最近充值日 + 充值周期自动计算' }),
      ref('abnormalReason', '异常原因', '状态', 'phone-abnormal-reasons', { showWhen: { field: 'status', in: ['abnormal'] } }),
      NOTE(),
    ],
  },
  {
    key: 'tax-profiles',
    label: '税务资料',
    nav: { group: '经营资料' },
    titleField: 'taxpayerName',
    tabsBy: 'taxCategory',
    uniqueTogether: [{ fields: ['licenseId'], message: '这个营业执照已经有税务资料了' }],
    statuses: [NORMAL, ABNORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      select('taxCategory', '类别', '基础', o('operation:经营税务', 'ecommerce:电商税务'), { required: true, list: true }),
      ref('licenseId', '所属执照', '基础', 'licenses', { required: true, list: true }),
      text('taxpayerName', '纳税人名称', '基础', { required: true, list: true, search: true }),
      text('taxpayerNo', '纳税人识别号', '基础', { list: true, search: true, maxLength: 32 }),
      select('taxType', '税种类型', '基础', o('pending:待确认', 'general:一般纳税人', 'small:小规模纳税人'), { list: true }),
      text('taxAuthority', '主管税务机关', '基础'),
      text('invoiceType', '发票类型', '基础'),
      text('taxDiskNo', '税盘号', '基础'),
      text('bankName', '开户行', '银行'),
      sensitive('bankAccountNo', '银行账号', '银行'),
      text('contactName', '税务联系人', '联系'),
      text('contactPhone', '联系电话', '联系'),
      date('lastFiledAt', '最近申报日期', '联系', { list: true }),
      NOTE(),
    ],
  },
  {
    key: 'partners',
    label: '合作人档案',
    nav: { group: '经营资料' },
    titleField: 'name',
    tabsBy: 'partnerType',
    statuses: [
      { value: 'active', label: '合作中', tone: 'ok' },
      { value: 'terminated', label: '解除合作', tone: 'muted', requiresReason: true, hidden: true },
    ],
    defaultStatus: 'active',
    fields: [
      select('partnerType', '类型', '基础', o('partner:合作人', 'legal:法人'), { list: true, help: '不选按合作人处理；执照自动建的法人档案是“法人”' }),
      text('partnerNo', '编号', '基础', { list: true, search: true }),
      text('name', '姓名', '基础', { required: true, list: true, search: true }),
      { key: 'phone', label: '联系电话', type: 'phone', group: '基础', list: true, search: true },
      sensitive('idNumber', '身份证号', '基础'),
      ref('licenseId', '所属执照', '关联', 'licenses', { list: true }),
      ref('storeId', '店铺', '关联', 'stores'),
      text('contactName', '关系负责人', '关系负责人'),
      text('contactPhone', '负责人电话', '关系负责人'),
      ref('contactUserId', '负责员工', '关系负责人', 'user'),
      text('contactNote', '关系说明', '关系负责人'),
      files('idFront', '身份证正面', '证件照片', { accept: 'image', maxFiles: 1 }),
      files('idBack', '身份证反面', '证件照片', { accept: 'image', maxFiles: 1 }),
      text('cardHolder', '银行卡户名', '银行卡'),
      text('cardBank', '开户行', '银行卡'),
      sensitive('cardNo', '银行卡号', '银行卡'),
      text('cardPhone', '预留手机', '银行卡'),
      NOTE(),
    ],
  },
  {
    key: 'bank-accounts',
    label: '银行账户',
    nav: { group: '银行卡', hidden: true },
    titleField: 'accountName',
    uniqueField: 'accountNo',
    tabsBy: 'kind',
    statuses: [NORMAL, ABNORMAL, INACTIVE],
    defaultStatus: 'normal',
    children: ['u-shields'],
    fields: [
      select('kind', '账户类型', '基础', o('company_public:公司公户', 'company_card:公司银行卡', 'cashier_account:出纳账户', 'store_public:店铺公户', 'store_personal_card:店铺个人银行卡'), { required: true, list: true }),
      text('accountName', '户名', '基础', { required: true, list: true, search: true }),
      text('bank', '开户行', '基础', { required: true, list: true, search: true }),
      sensitive('accountNo', '账号/卡号', '基础', { required: true, list: true }),
      text('ownerName', '所属人', '基础', { list: true }),
      ref('licenseId', '所属执照', '关联', 'licenses', { list: true }),
      ref('storeId', '关联店铺', '关联', 'stores'),
      ref('keeperUserId', '保管人', '关联', 'user'),
      text('reservedPhoneNumber', '预留手机', '关联'),
      text('reservedPhoneHolder', '预留手机持有人', '关联'),
      ref('phoneId', '关联手机号档案', '关联', 'phones'),
      text('customerNo', '客户号', '公户信息', { showWhen: { field: 'kind', in: ['company_public', 'store_public'] } }),
      ref('openingArchiveLocationId', '开户档案位置', '公户信息', 'locations', { showWhen: { field: 'kind', in: ['company_public', 'store_public'] } }),
      files('attachments', '开户附件', '公户信息', { maxFiles: 4, showWhen: { field: 'kind', in: ['company_public', 'store_public'] } }),
      money('balance', '当前余额', '对账', { help: '手工登记；后续接入流水后改为自动' }),
      select('reconcileCycle', '对账周期', '对账', RECONCILE),
      text('reconcileDay', '对账提醒日', '对账', { maxLength: 8 }),
      textarea('abnormalReason', '异常原因', '状态', { showWhen: { field: 'status', in: ['abnormal'] } }),
      NOTE(),
    ],
  },
  {
    key: 'duty-groups',
    label: '职责组',
    nav: { group: '组织与人员' },
    titleField: 'name',
    uniqueField: 'groupKey',
    statuses: [NORMAL, INACTIVE],
    defaultStatus: 'normal',
    children: ['duty-group-items', 'duty-group-members'],
    fields: [
      text('groupKey', '职责组编码', '基础', { required: true, list: true, search: true, help: '流程和任务按编码引用，建好后不要改' }),
      text('name', '职责组名称', '基础', { required: true, list: true, search: true }),
      select('scope', '范围', '基础', o('company:公司级', 'department:部门级'), { list: true }),
      textarea('description', '说明', '基础'),
      ref('leaderUserId', '负责人', '基础', 'user', { list: true }),
      NOTE(),
    ],
  },
  {
    key: 'duty-group-items',
    label: '职责明细',
    parent: { type: 'duty-groups', field: 'groupId' },
    titleField: 'title',
    statuses: [NORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      ref('groupId', '职责组', '基础', 'duty-groups', { required: true }),
      text('title', '职责标题', '基础', { required: true, list: true, search: true }),
      textarea('description', '职责说明', '基础', { list: true }),
      text('module', '关联模块', '基础', { list: true }),
      text('frequency', '频率', '基础', { list: true }),
      { key: 'sortOrder', label: '排序', type: 'number', group: '基础' },
    ],
  },
  {
    key: 'duty-group-members',
    label: '职责组成员',
    parent: { type: 'duty-groups', field: 'groupId' },
    titleField: 'userId',
    uniqueTogether: [{ fields: ['groupId', 'userId'], message: '这个员工已经在该职责组里了' }],
    statuses: [NORMAL],
    defaultStatus: 'normal',
    fields: [
      ref('groupId', '职责组', '基础', 'duty-groups', { required: true }),
      ref('userId', '成员', '基础', 'user', { required: true, list: true }),
      text('role', '组内角色', '基础', { list: true }),
    ],
  },
  {
    key: 'u-shields',
    label: 'U 盾',
    parent: { type: 'bank-accounts', field: 'bankAccountId' },
    titleField: 'name',
    statuses: [NORMAL, ABNORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      ref('bankAccountId', '银行账户', '基础', 'bank-accounts', { required: true }),
      text('name', '名称/编号', '基础', { required: true, list: true, search: true }),
      ref('keeperUserId', '保管人', '基础', 'user', { list: true }),
      ref('locationId', '存放位置', '基础', 'locations', { list: true }),
      secret('loginPassword', '登录密码', '密码'),
      secret('tradePassword', '交易密码', '密码'),
      NOTE(),
    ],
  },
  {
    key: 'qualifications',
    label: '资质证照',
    nav: { group: '账号与资质' },
    uniqueField: 'certNo',
    titleField: 'name',
    tabsBy: 'type',
    statuses: [NORMAL, ABNORMAL, { value: 'expired', label: '已过期', tone: 'bad' }, INACTIVE],
    defaultStatus: 'normal',
    alerts: [{ field: 'expiresAt', withinDays: 30, label: '30 天内到期' }],
    fields: [
      select('type', '类型', '基础', o('seed_business_filing:种子经营备案', 'brand_authorization:品牌授权', 'platform_operation:平台运营资质', 'general:通用'), { required: true, list: true }),
      text('name', '名称', '基础', { required: true, list: true, search: true }),
      text('certNo', '证书号', '基础', { list: true, search: true }),
      ref('licenseId', '所属执照', '基础', 'licenses', { list: true }),
      date('filedAt', '备案日期', '基础'),
      date('expiresAt', '到期日', '基础', { list: true }),
      text('filedProducts', '备案商品', '基础'),
      text('reviewContact', '审核联系人', '基础'),
      text('platformAccount', '平台登录账号', '平台账号'),
      secret('platformPassword', '平台登录密码', '平台账号'),
      files('attachments', '证照附件', '附件', { maxFiles: 9 }),
      textarea('abnormalReason', '异常原因', '状态', { showWhen: { field: 'status', in: ['abnormal'] } }),
      NOTE(),
    ],
  },
  {
    key: 'trademarks',
    label: '商标资料',
    nav: { group: '经营资料' },
    titleField: 'name',
    tabsBy: 'source',
    statuses: [
      { value: 'applying', label: '申请中', tone: 'warn' },
      { value: 'accepted', label: '已受理', tone: 'warn' },
      { value: 'registered', label: '已注册', tone: 'ok' },
      { value: 'partial_passed', label: '部分通过', tone: 'warn' },
      { value: 'rejected', label: '被驳回', tone: 'bad' },
      { value: 'expired', label: '已过期', tone: 'bad' },
      INACTIVE,
    ],
    defaultStatus: 'applying',
    alerts: [{ field: 'validUntil', withinDays: 90, label: '90 天内到期' }],
    fields: [
      select('source', '来源', '基础', o('owned:自有', 'cooperative:合作'), { required: true, list: true }),
      text('name', '商标名称', '基础', { required: true, list: true, search: true }),
      text('classNo', '类别', '基础', { list: true }),
      text('applicant', '申请人', '基础', { list: true }),
      ref('licenseId', '申请人执照', '基础', 'licenses'),
      text('cooperativeContact', '合作负责人', '基础', { showWhen: { field: 'source', in: ['cooperative'] } }),
      text('applicationNo', '申请号', '日期与编号', { search: true }),
      text('registrationNo', '注册号', '日期与编号', { list: true, search: true }),
      date('appliedAt', '申请日期', '日期与编号'),
      date('acceptedAt', '受理日期', '日期与编号'),
      date('registeredAt', '注册日期', '日期与编号'),
      date('validUntil', '有效期至', '日期与编号', { list: true }),
      files('image', '商标图', '附件', { accept: 'image', maxFiles: 1 }),
      files('acceptNotice', '受理通知书', '附件', { maxFiles: 5 }),
      files('certificate', '商标证书', '附件', { maxFiles: 5 }),
      NOTE(),
    ],
  },
  {
    key: 'self-media',
    label: '自媒体账号',
    nav: { group: '经营资料' },
    titleField: 'name',
    tabsBy: 'platform',
    statuses: [NORMAL, ABNORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      select('platform', '平台', '基础', o('douyin:抖音', 'kuaishou:快手', 'channels:视频号', 'xhs:小红书', 'other:其他'), { required: true, list: true }),
      text('name', '账号名称', '基础', { required: true, list: true, search: true }),
      text('accountNo', '账号号', '基础', { list: true, search: true }),
      secret('password', '密码', '基础'),
      text('phoneNumber', '绑定手机号', '基础', { search: true }),
      ref('phoneId', '手机号档案', '基础', 'phones'),
      text('homepage', '主页链接', '基础'),
      { key: 'followers', label: '粉丝数', type: 'number', group: '运营', list: true },
      money('deposit', '保证金', '运营'),
      ref('licenseId', '主体执照', '关联', 'licenses'),
      ref('storeId', '关联店铺', '关联', 'stores'),
      ref('operatorUserId', '运营人', '关联', 'user', { list: true }),
      text('certifiedName', '认证人', '关联'),
      money('promotionFeeBalance', '推广费余额', '运营'),
      text('douyinShopId', '抖店ID', '平台属性', { showWhen: { field: 'platform', in: ['douyin'] } }),
      text('kuaishouShopId', '快手小店ID', '平台属性', { showWhen: { field: 'platform', in: ['kuaishou'] } }),
      text('wechatId', '绑定微信号', '平台属性', { showWhen: { field: 'platform', in: ['channels'] } }),
      text('videoChannelId', '视频号ID', '平台属性', { showWhen: { field: 'platform', in: ['channels'] } }),
      text('subjectType', '认证主体', '平台属性', { showWhen: { field: 'platform', in: ['channels'] } }),
      text('redBookId', '小红书号', '平台属性', { showWhen: { field: 'platform', in: ['xhs'] } }),
      text('contentCategory', '内容方向', '平台属性', { showWhen: { field: 'platform', in: ['douyin', 'kuaishou', 'xhs'] } }),
      text('adAccountId', '广告账号', '平台属性', { help: '抖音：巨量广告账号；快手：磁力金牛账号', showWhen: { field: 'platform', in: ['douyin', 'kuaishou'] } }),
      text('brandCooperationNo', '蒲公英/合作账号', '平台属性', { showWhen: { field: 'platform', in: ['xhs'] } }),
      text('accountType', '账号类型', '平台属性', { showWhen: { field: 'platform', in: ['other'] } }),
      text('platformContact', '平台联系人', '平台属性', { showWhen: { field: 'platform', in: ['other'] } }),
      textarea('extraInfo', '其他属性', '平台属性', { showWhen: { field: 'platform', in: ['other'] } }),
      textarea('abnormalReason', '异常原因', '状态', { showWhen: { field: 'status', in: ['abnormal'] } }),
      NOTE(),
    ],
  },
  {
    key: 'wechat',
    label: '微信号档案',
    nav: { group: '经营资料' },
    titleField: 'name',
    uniqueField: 'wechatNo',
    statuses: [NORMAL, ABNORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      text('name', '名称', '基础', { required: true, list: true, search: true }),
      text('wechatNo', '微信号', '基础', { list: true, search: true, maxLength: 64 }),
      secret('password', '密码', '基础'),
      ref('userId', '使用员工', '使用', 'user', { list: true }),
      text('purpose', '用途', '使用', { list: true }),
      text('phoneNumber', '绑定手机号', '使用', { help: '匹配已建档的手机号', search: true }),
      ref('phoneId', '手机号档案', '使用', 'phones'),
      textarea('abnormalReason', '异常原因', '状态', { showWhen: { field: 'status', in: ['abnormal'] } }),
      NOTE(),
    ],
  },
  {
    key: 'broadband',
    label: '宽带账号',
    nav: { group: '账号与资质' },
    titleField: 'account',
    uniqueField: 'account',
    statuses: [NORMAL, { value: 'suspended', label: '停机', tone: 'warn' }, CANCELLED],
    defaultStatus: 'normal',
    fields: [
      text('account', '宽带账号', '基础', { required: true, list: true, search: true }),
      ref('locationId', '安装位置', '基础', 'locations', { list: true }),
      text('bandwidth', '带宽', '基础', { list: true }),
      select('cycle', '套餐周期', '费用', o('monthly:月付', 'yearly:年付')),
      money('amount', '金额', '费用', { list: true }),
      date('expiresAt', '到期日', '费用', { list: true }),
      ref('phoneId', '绑定手机号', '基础', 'phones'),
      NOTE(),
    ],
    alerts: [{ field: 'expiresAt', withinDays: 30, label: '30 天内到期' }],
  },
  {
    key: 'memos',
    label: '账号与服务备忘',
    nav: { group: '账号与资质' },
    titleField: 'title',
    tabsBy: 'kind',
    statuses: [NORMAL, ABNORMAL, { value: 'expiring', label: '即将到期', tone: 'warn' }, { value: 'expired', label: '已过期', tone: 'bad' }, INACTIVE],
    defaultStatus: 'normal',
    alerts: [{ field: 'endAt', withinDays: 30, label: '30 天内到期' }],
    fields: [
      select('kind', '类型', '基础', o('account:账号', 'service:服务'), { required: true, list: true }),
      text('title', '名称', '基础', { required: true, list: true, search: true }),
      text('provider', '服务商', '基础', { list: true, search: true }),
      text('loginName', '登录名', '基础', { search: true }),
      secret('password', '密码', '基础'),
      text('accountNo', '账号编号', '基础'),
      text('url', '网址', '基础'),
      ref('ownerUserId', '负责人', '基础', 'user', { list: true }),
      ref('parentId', '所属账号', '服务', 'memos', { showWhen: { field: 'kind', in: ['service'] } }),
      text('serviceType', '服务类型', '服务', { showWhen: { field: 'kind', in: ['service'] } }),
      date('startAt', '开始日期', '服务'),
      date('endAt', '结束日期', '服务', { list: true }),
      select('renewCycle', '续费周期', '服务', o('monthly:月', 'quarterly:季', 'yearly:年', 'custom:自定义')),
      money('renewAmount', '续费金额', '服务'),
      NOTE(),
    ],
  },
  {
    key: 'software',
    label: '软件账号',
    nav: { group: '账号与资质', hidden: true },
    titleField: 'name',
    statuses: [NORMAL, { value: 'renewing', label: '续费中', tone: 'warn' }, { value: 'expired', label: '已过期', tone: 'bad' }, INACTIVE],
    defaultStatus: 'normal',
    alerts: [{ field: 'renewAt', withinDays: 30, label: '30 天内需续费' }],
    fields: [
      text('name', '软件名称', '基础', { required: true, list: true, search: true }),
      ref('storeId', '关联店铺', '基础', 'stores', { list: true }),
      text('account', '账号', '基础', { list: true, search: true }),
      secret('password', '密码', '基础'),
      date('renewAt', '续费日期', '费用', { list: true }),
      money('annualFee', '年费', '费用'),
      NOTE(),
    ],
  },
  {
    key: 'fixed-assets',
    label: '固定资产',
    filterBy: 'categoryId',
    nav: { group: '公司资产' },
    titleField: 'name',
    uniqueField: 'assetNo',
    statuses: [
      { value: 'idle', label: '闲置', tone: 'muted' },
      { value: 'in_use', label: '使用中', tone: 'ok' },
      { value: 'repairing', label: '维修中', tone: 'warn' },
      { value: 'retired', label: '已报废', tone: 'muted', requiresReason: true, hidden: true },
      { value: 'lost', label: '遗失', tone: 'bad', requiresReason: true, hidden: true },
    ],
    defaultStatus: 'idle',
    fields: [
      text('assetNo', '系统编号', '基础', { required: true, list: true, search: true, maxLength: 64 }),
      text('customAssetNo', '自定义编号', '基础', { list: true, search: true, maxLength: 64 }),
      text('name', '名称', '基础', { required: true, list: true, search: true }),
      ref('categoryId', '分类', '基础', 'asset-categories', { list: true }),
      attrs('attrs', '分类自定义属性', '基础', 'categoryId'),
      text('brand', '品牌', '基础'),
      text('model', '型号', '基础'),
      text('serialNo', '序列号', '基础', { search: true }),
      textarea('config', '配置', '基础'),
      files('photos', '资产照片', '照片', { accept: 'image', maxFiles: 6 }),
      date('purchasedAt', '购入日期', '购入'),
      money('purchasePrice', '购入金额', '购入'),
      text('supplier', '供应商', '购入'),
      date('warrantyUntil', '保修至', '购入'),
      ref('userId', '使用人', '使用', 'user', { list: true }),
      ref('keeperUserId', '保管人', '使用', 'user'),
      ref('departmentId', '所属部门', '使用', 'department', { list: true }),
      ref('locationId', '位置', '使用', 'locations', { list: true }),
      NOTE(),
    ],
  },
  {
    key: 'asset-categories',
    label: '资产分类',
    nav: { group: '公司资产', hidden: true },
    titleField: 'name',
    statuses: [NORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      text('name', '分类名称', '基础', { required: true, list: true, search: true }),
      ref('parentId', '上级分类', '基础', 'asset-categories', { list: true }),
      { key: 'sort', label: '排序', type: 'number', group: '基础', list: true },
      text('customFields', '自定义字段', '基础', { help: '用逗号分隔，如：颜色,容量；该分类的资产表单里会出现这些输入项', maxLength: 500 }),
      NOTE(),
    ],
  },
  {
    key: 'locations',
    label: '房间与档案位置',
    nav: { group: '公司资产' },
    titleField: 'name',
    statuses: [NORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      text('name', '位置名称', '基础', { required: true, list: true, search: true }),
      select('scope', '位置板块', '基础', o('area:区域位置', 'asset_space:固定资产储物空间'), { required: true, list: true }),
      select('locationType', '类型', '基础', o('building:办公楼/区域', 'floor:楼层', 'room:房间', 'asset_slot:资产内部位置', 'shelf:层', 'drawer:抽屉', 'box:格/盒'), { list: true }),
      ref('parentId', '上级位置', '基础', 'locations', { list: true }),
      ref('fixedAssetId', '对应固定资产', '基础', 'fixed-assets', { showWhen: { field: 'scope', in: ['asset_space'] } }),
      text('code', '位置编号', '基础', { list: true }),
      textarea('description', '说明', '基础'),
      { key: 'sort', label: '排序', type: 'number', group: '基础' },
      NOTE(),
    ],
  },
  {
    key: 'archives',
    label: '档案项',
    nav: { group: '公司资产', hidden: true },
    titleField: 'name',
    uniqueField: 'archiveNo',
    statuses: [
      { value: 'stored', label: '已存放', tone: 'ok' },
      { value: 'borrowed', label: '借出', tone: 'warn' },
      { value: 'missing', label: '缺失', tone: 'bad' },
      { value: 'archived', label: '已归档', tone: 'muted' },
    ],
    defaultStatus: 'stored',
    fields: [
      text('archiveNo', '档案编号', '基础', { required: true, list: true, search: true }),
      text('name', '档案名称', '基础', { required: true, list: true, search: true }),
      text('archiveType', '类型', '基础', { list: true }),
      select('relatedType', '关联对象', '基础', o('license:营业执照', 'store:店铺')),
      ref('licenseId', '关联执照', '基础', 'licenses', { list: true, showWhen: { field: 'relatedType', in: ['license'] } }),
      ref('storeId', '关联店铺', '基础', 'stores', { list: true, showWhen: { field: 'relatedType', in: ['store'] } }),
      ref('locationId', '存放位置', '基础', 'locations', { list: true }),
      ref('keeperUserId', '保管人', '基础', 'user', { list: true }),
      files('photos', '档案照片', '照片', { maxFiles: 6 }),
      NOTE(),
    ],
  },
];

/** 旧程序里一个页面带着几类资料：这些资料不单独占菜单，而是作为该页面的页签（权限仍各自独立）。 */
export const RESOURCE_COMPANIONS: Readonly<Record<string, readonly string[]>> = {
  memos: ['software'],
  'fixed-assets': ['asset-categories'],
  locations: ['archives'],
};

const BY_KEY = new Map(RESOURCE_DEFS.map((d) => [d.key, d]));

export function getResourceDef(key: string): ResourceDef | undefined {
  return BY_KEY.get(key);
}

/** 这种资料自己是一棵树（有指向自己的“上级”字段），如商品分类、供应商分类 */
export function isTreeResource(key: string): boolean {
  return !!BY_KEY.get(key)?.fields.some((f) => f.key === 'parentId' && f.type === 'ref' && f.ref === key);
}

/** 列表左侧要显示分类目录的字段：filterBy 里第一个指向“树形资料”的关联字段 */
export function treeFilterField(def: ResourceDef): FieldDef | undefined {
  const keys = def.filterBy ? ([] as string[]).concat(def.filterBy as string | string[]) : [];
  return keys.map((k) => def.fields.find((f) => f.key === k)).find((f) => !!f && (f.type === 'ref' || f.type === 'refs') && !!f.ref && isTreeResource(f.ref));
}

/** 资源动作权限键：resource.<key>.<action> */
export const RESOURCE_ACTIONS = ['view', 'create', 'edit', 'disable', 'delete', 'import', 'export', 'secret'] as const;
export type ResourceAction = (typeof RESOURCE_ACTIONS)[number];

export function resourcePermission(key: string, action: ResourceAction): string {
  return `resource.${key}.${action}`;
}

/** 当前用户没有权限的字段 key（成本等受限字段）。 */
export function restrictedFieldKeys(def: ResourceDef, can: (permission: string) => boolean): Set<string> {
  return new Set(def.fields.filter((f) => f.permission && !can(f.permission)).map((f) => f.key));
}

/** 当前用户不能修改的字段（看不到的，或缺少修改权限的）。 */
export function readOnlyFieldKeys(def: ResourceDef, can: (permission: string) => boolean): Set<string> {
  return new Set(def.fields.filter((f) => (f.permission && !can(f.permission)) || (f.writePermission && !can(f.writePermission))).map((f) => f.key));
}

export function secretFields(def: ResourceDef): FieldDef[] {
  return def.fields.filter((f) => f.type === 'secret' || f.type === 'sensitive');
}

/** 子资源的权限沿用父资源：能看营业执照的人才能看它的借用记录。 */
export function permissionOwner(key: string): string {
  return getResourceDef(key)?.parent?.type ?? key;
}

export function maskSensitive(value: string): string {
  const v = value.trim();
  if (v.length <= 4) return '****';
  return `${'*'.repeat(Math.min(v.length - 4, 12))}${v.slice(-4)}`;
}

/** 手机号规范化：只留数字，去掉 +86/86 前缀。 */
export function normalizePhone(input: string): string {
  let digits = input.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('86')) digits = digits.slice(2);
  return digits;
}

export interface ValidationResult {
  values: Record<string, unknown>;
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHDAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isShown(field: FieldDef, current: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  return field.showWhen.in.includes(String(current[field.showWhen.field] ?? ''));
}

/**
 * 校验并规范化一份提交的数据（前后端同用，后端为准）。
 * - 未知字段忽略；值为 null/空串 视为清空
 * - showWhen 不满足的字段会被清空
 * - secret/sensitive 的空值表示“不修改”，由调用方决定如何处理，这里只做格式校验
 * `current` 里应含 status（供 showWhen 使用）。
 */
export function validateResourceInput(
  def: ResourceDef,
  input: Record<string, unknown>,
  context: { status: string; existing?: Record<string, unknown> },
): ValidationResult {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  const merged: Record<string, unknown> = { ...(context.existing ?? {}), ...input, status: context.status };

  for (const field of def.fields) {
    if (field.readonly) continue; // 由系统计算，提交的值一律忽略
    if (!isShown(field, merged)) {
      values[field.key] = null;
      continue;
    }
    const raw = input[field.key];
    const provided = raw !== undefined;
    const empty = raw === null || raw === '' || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0);
    const label = field.label;

    if (!provided) {
      // 未提交：沿用已有值；新建时必填项报错
      if (field.required && (context.existing?.[field.key] === undefined || context.existing?.[field.key] === null)) {
        // 密码类字段本身不在 existing 里（不回传），编辑时没提交就是“不修改”
        if (field.type !== 'secret' || !context.existing) errors.push(`${label}不能为空`);
      }
      continue;
    }
    if (empty) {
      if (field.required && field.type !== 'secret') errors.push(`${label}不能为空`);
      values[field.key] = null;
      continue;
    }

    switch (field.type) {
      case 'text':
      case 'textarea':
      case 'secret':
      case 'sensitive': {
        const s = String(raw).trim();
        if (s.length > (field.maxLength ?? 200)) errors.push(`${label}不能超过 ${field.maxLength ?? 200} 个字`);
        else values[field.key] = s;
        break;
      }
      case 'phone': {
        const digits = normalizePhone(String(raw));
        if (digits.length < 7 || digits.length > 15) errors.push(`${label}格式不对`);
        else values[field.key] = digits;
        break;
      }
      case 'number': {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 2_000_000_000) errors.push(`${label}必须是非负整数`);
        else values[field.key] = n;
        break;
      }
      case 'decimal': {
        const n = Number(raw);
        const scale = field.scale ?? 4;
        if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000 || Math.round(n * 10 ** scale) / 10 ** scale !== n) errors.push(`${label}必须是不超过 ${scale} 位小数的非负数`);
        else values[field.key] = n;
        break;
      }
      case 'money': {
        const n = Number(raw);
        if (!validUnitCents(n, field.scale ?? 0)) errors.push(field.scale ? `${label}精度不合法（最多 ${2 + field.scale} 位元小数）` : `${label}必须是以分为单位的整数`);
        else values[field.key] = n;
        break;
      }
      case 'date':
        if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(raw))) errors.push(`${label}日期格式应为 YYYY-MM-DD`);
        else values[field.key] = raw;
        break;
      case 'monthday':
        if (typeof raw !== 'string' || !MONTHDAY_RE.test(raw)) errors.push(`${label}格式应为 MM-DD`);
        else values[field.key] = raw;
        break;
      case 'bool':
        values[field.key] = raw === true || raw === 'true' || raw === 1;
        break;
      case 'select':
        if (field.multi) {
          const picked = new Set(String(raw).split(/[、,，]/).map((x) => x.trim()).filter(Boolean));
          const bad = [...picked].some((x) => !field.options?.some((opt) => opt.value === x));
          if (bad) errors.push(`${label}的取值不合法`);
          else values[field.key] = (field.options ?? []).map((o) => o.value).filter((v) => picked.has(v)).join('、');
          break;
        }
        if (!field.options?.some((opt) => opt.value === raw)) errors.push(`${label}的取值不合法`);
        else values[field.key] = raw;
        break;
      case 'files': {
        const max = field.maxFiles ?? 9;
        const ids = Array.isArray(raw) ? raw.map(Number) : [];
        if (!Array.isArray(raw) || ids.some((n) => !Number.isInteger(n) || n <= 0)) errors.push(`${label}文件列表不合法`);
        else if (new Set(ids).size > max) errors.push(`${label}最多 ${max} 个文件`);
        else values[field.key] = [...new Set(ids)];
        break;
      }
      case 'attrs': {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { errors.push(`${label}格式不对`); break; }
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const val = String(v ?? '').trim();
          if (!val) continue;
          if (k.length > 40 || val.length > 200) { errors.push(`${label}里「${k.slice(0, 10)}」太长`); break; }
          out[k] = val;
        }
        if (Object.keys(out).length > 30) errors.push(`${label}最多 30 项`);
        else values[field.key] = Object.keys(out).length ? out : null;
        break;
      }
      case 'json': {
        if (typeof raw !== 'object' || raw === null || JSON.stringify(raw).length > 200_000) errors.push(`${label}格式不对或太大`);
        else values[field.key] = raw;
        break;
      }
      case 'refs': {
        const arr = Array.isArray(raw) ? raw : [];
        const ids = [...new Set(arr.map((x) => Number(x)))];
        if (ids.some((n) => !Number.isInteger(n) || n <= 0)) errors.push(`${label}引用不合法`);
        else if (ids.length > 10) errors.push(`${label}最多选 10 项`);
        else values[field.key] = ids.length ? ids : null;
        break;
      }
      case 'ref': {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) errors.push(`${label}引用不合法`);
        else values[field.key] = n;
        break;
      }
    }
  }
  return { values, errors };
}

/** 状态切换：返回错误文案，null 表示可以。 */
export function validateStatusChange(def: ResourceDef, status: string, reason: string | undefined): string | null {
  const target = def.statuses.find((s) => s.value === status);
  if (!target) return '状态不合法';
  if (target.requiresReason && !(reason && reason.trim().length >= 2)) return `改为“${target.label}”必须填写原因`;
  return null;
}

/** 资料菜单：按分组把有导航的资源列出来。 */
export function resourceNavGroups(section?: 'finance'): Array<{ group: string; items: ResourceDef[] }> {
  const groups: Array<{ group: string; items: ResourceDef[] }> = [];
  for (const def of RESOURCE_DEFS) {
    if (!def.nav || def.nav.section !== section) continue;
    let g = groups.find((x) => x.group === def.nav!.group);
    if (!g) groups.push((g = { group: def.nav.group, items: [] }));
    g.items.push(def);
  }
  return groups;
}

/** 距今天数；日期无效返回 null。 */
export function daysUntil(dateStr: string, today: Date = new Date()): number | null {
  if (!DATE_RE.test(dateStr)) return null;
  const target = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const base = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - base) / 86_400_000);
}

export function addDays(dateStr: string, days: number): string | null {
  if (!DATE_RE.test(dateStr)) return null;
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** 资料菜单里的「视图」：同一种资料按某个分类拆成独立入口（旧程序的银行卡五个页面）。 */
export const RESOURCE_VIEWS: ReadonlyArray<{ id: string; label: string; type: string; tab: string }> = [
  { id: 'company-public-accounts', label: '公司公户', type: 'bank-accounts', tab: 'company_public' },
  { id: 'company-bank-cards', label: '公司银行卡', type: 'bank-accounts', tab: 'company_card' },
  { id: 'cashier-accounts', label: '公司出纳账户', type: 'bank-accounts', tab: 'cashier_account' },
  { id: 'store-public-accounts', label: '店铺公户', type: 'bank-accounts', tab: 'store_public' },
  { id: 'store-personal-cards', label: '店铺个人银行卡', type: 'bank-accounts', tab: 'store_personal_card' },
];
