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
  /** type=files：电脑上可以点“手机上传”，扫码用手机拍照/选图传到这个字段（只收图片） */
  phoneUpload?: boolean;
  /**
   * 选项（select）或建议（text）来自公司自己维护的“商品单位与规格”列表（旧系统的单位、包装分类、尺寸单位管理）：
   * 下拉的值是列表项的编码，显示名称。kindBy：列表种类随另一个字段的值变（如发货物料用自己的单位表）。
   * 公司还没有维护该种类时，退回 options 里的默认选项。
   */
  optionsFrom?: { resource: string; kind: string; kindBy?: { field: string; map: Record<string, string> } };
  /** 仅当另一个字段（或 status）取这些值时才显示/保存，不满足时服务端清空 */
  showWhen?: { field: string; in: readonly string[] };
  help?: string;
  /** type=ref 且目标是树形资料：表单里用“一级一级点选”的分栏选择器（资产分类、位置），而不是平铺下拉 */
  cascade?: boolean;
  /** secret：允许从导入表格写入（旧系统资质导入可带平台登录密码）；导出始终不含密码 */
  importable?: boolean;
  /** text/sensitive：格式校验（正则源码 + 不通过时的提示） */
  pattern?: { source: string; message: string };
}

export interface StatusDef extends Option {
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  /** 切换到该状态必须填写原因（停用/注销/解除合作等） */
  requiresReason?: boolean;
  /** 默认在列表中隐藏（可通过“显示停用”打开） */
  hidden?: boolean;
}

/**
 * 声明式条件（快捷页签、计算筛选、派生列共用；服务端翻译成带公司隔离的 SQL，字段和资料类型都按配置白名单校验）。
 * field 写字段 key；写 '$status' 表示记录状态。
 * - eq/ne/in/notIn：字段值等于/不等于/属于；empty/notEmpty：字段没填/已填（引用、多选为空数组也算没填）
 * - rel：别的资料里有（exists）/没有（none）指向本记录的记录（rel.field 是对方的引用字段；可再加 where 限定对方的条件）
 * - viaRef：本记录的引用字段 viaRef 指向的那条记录满足 where（没填引用则不满足）
 */
export type Cond =
  | { field: string; op: 'eq' | 'ne'; value: string | number | boolean }
  | { field: string; op: 'in' | 'notIn'; value: ReadonlyArray<string | number> }
  | { field: string; op: 'empty' | 'notEmpty' }
  /** 日期字段（YYYY-MM-DD）：今天（北京时间）起 days 天内（含今天、含第 days 天）；已过期 = 早于今天（没填的不算） */
  | { field: string; op: 'dateWithin'; days: number }
  | { field: string; op: 'expired' }
  /** 日期字段（YYYY-MM-DD）晚于今天（北京时间）：还没到的开始日期（没填的不算） */
  | { field: string; op: 'future' }
  /** 本记录的员工字段指向的员工没有主岗位（用于“没有岗位”页签） */
  | { viaUserNoPosition: string }
  /** 本记录的员工字段 viaUserDept 指向的员工，所在部门等于 dept（'$value' = 计算筛选下拉选中的部门）；includeChildren 连下级部门 */
  | { viaUserDept: string; dept: number | '$value'; includeChildren?: boolean }
  /** 本记录的部门字段 deptField（ref 到 department）等于 dept（'$value' = 计算筛选下拉选中的部门）；includeChildren 连下级部门 */
  | { deptField: string; dept: number | '$value'; includeChildren?: boolean }
  | { rel: { type: string; field: string; where?: Cond }; op: 'exists' | 'none' }
  | { viaRef: string; where: Cond }
  | { all: readonly Cond[] }
  | { any: readonly Cond[] }
  | { not: Cond };

/** 列表快捷页签：和 tabsBy 页签放在同一排，条件满足的记录才算；各自带数量 */
export interface QuickTab {
  key: string;
  label: string;
  when: Cond;
  /** 条件里要看停用/注销的记录（如“已注销”）：这个页签下不套“默认隐藏停用状态” */
  includeHidden?: boolean;
}

/** 计算筛选：列表上方的下拉，每个选项是一个条件（如 执照情况：没有绑定 / 已停用） */
export interface ComputedFilter {
  key: string;
  label: string;
  options?: ReadonlyArray<{ value: string; label: string; when: Cond }>;
  /** 选项由服务端按公司现有数据生成（departments=部门），选中的值代入 when 里的 '$value' */
  optionsFrom?: 'departments';
  when?: Cond;
}

/**
 * 派生列：列表里按页现算的数字（不存库），如“店铺数”“本月营业额”“成员数”。
 * 统计 type 资料里 field 等于“本记录 match 字段值（默认本记录 id）”的记录：count=条数，sum=sumField 求和（money 为分）。
 * via：先找 via.type 里 via.field 等于本记录值的记录，再统计 type 里 field 指向这些记录的记录（两跳，如 执照→店铺→经营数据）。
 * month：只统计这个日期字段落在本月（按北京时间）的记录。where 限定被统计的记录（如只算正常状态的）。
 */
export interface DerivedColumn {
  key: string;
  label: string;
  kind: 'count' | 'sum';
  type: string;
  field: string;
  match?: string;
  via?: { type: string; field: string };
  sumField?: string;
  month?: string;
  where?: Cond;
  /** sum 的显示：money（元）或 number；count 总是 number */
  format?: 'money' | 'number';
  /** 默认在列表里显示（否则只在“列”菜单里可选） */
  list?: boolean;
}

/** 带原因的批量动作：勾选后让用户选一个值（pick）、填原因，然后对每条走一遍正常的保存流程 */
export interface BatchAction {
  key: string;
  label: string;
  /** 要用户选的字段（ref/select），选到的值写进这个字段 */
  pick?: string;
  /** 固定写入的字段值 */
  set?: Record<string, unknown>;
  /** 原因写进这个字段（如 assignReason）；不填则只进操作日志 */
  reasonField?: string;
  reasonRequired?: boolean;
  reasonLabel?: string;
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
  /** 页签再拆开：tabsBy 的某个取值（如外购成品 purchased）按另一个字段拆成几个页签（旧系统“原装采购成品 / 供应商 OEM 成品”两个入口）。拆出的页签值就是 options 的 value；字段没填的记录算 default */
  tabSplit?: { tab: string; field: string; default: string; options: readonly Option[] };
  /** 列表勾选后可批量做的事：status=批量停用/启用（要填原因），其余是批量修改这个字段（如移动分类） */
  batch?: readonly string[];
  /** 列表按这个字段的取值分组显示（可折叠的分组条，没填的归“未分类”）；字段必须是引用字段，分组顺序由 groupOrder 决定 */
  listGroupBy?: { field: string; emptyLabel: string; order: 'department' };
  /** 快捷页签（条件页签，不依赖 tabsBy）；页签值为 q:<key> */
  quickTabs?: readonly QuickTab[];
  /** 左侧目录里可以就地管理（新增下级、改名、排序、删除）的树形字段 key；需要对方资料的编辑/删除权限 */
  treeManage?: readonly string[];
  /** 左侧目录里不显示的节点：树形字段 key → 对方资料某字段取这些值的节点（如固定资产的位置目录不列“储物空间”，只列房间和柜子所在位置）；这些节点下的资料仍归到上级里算 */
  treeExclude?: Record<string, { field: string; values: readonly string[] }>;
  /** 计算筛选下拉（条件在服务端按今天实时算） */
  computedFilters?: readonly ComputedFilter[];
  /** 派生列（按页现算的统计数字） */
  derivedColumns?: readonly DerivedColumn[];
  /** 带原因的批量动作（如批量指派运营并写指派原因） */
  batchActions?: readonly BatchAction[];
  /** 预警：状态异常，或某日期字段在 N 天内到期 */
  alerts?: Array<{ field: string; withinDays: number; label: string }>;
  /** 详情里多一个只读“适用店铺”页签：按本记录的这个执照字段，列出该执照下的店铺 */
  derivedStores?: string;
  /** 复制新建时不带过去的字段（旧页面的“复制”规则：编号、名称、照片等） */
  copyOmit?: readonly string[];
  /** 详情页展示这些子资源 */
  children?: readonly string[];
  /** 详情页额外展示的相关资料页签：别的资料里指向本资料的记录（按它自己的权限显示） */
  related?: ReadonlyArray<{ type: string; field: string }>;
  /** 列表按这个日期字段倒序（不设则按新建先后） */
  sortField?: string;
  /** 导入时没有唯一字段的资料，这些字段值都相同就视为同一条（有则更新，无则新建），如店铺按 店铺编号+店铺名 */
  importMatch?: readonly string[];
}

import { FINANCE_RESOURCE_DEFS } from './finance-resources';
import { ABNORMAL, CANCELLED, INACTIVE, NORMAL, NOTE, attrs, date, files, money, o, ref, refs, secret, select, sensitive, text, textarea } from './resource-kit';

/** 改为异常必须说明原因（旧系统的“标记异常”对话框必填） */
const ABNORMAL_R = { ...ABNORMAL, requiresReason: true };

const PLATFORMS = o('pdd:拼多多', 'taobao:淘宝', 'tmall:天猫', 'douyin:抖音', 'jd:京东', 'kuaishou:快手', 'xhs:小红书', 'other:其他');
const RECONCILE = o('monthly:按月', 'quarterly:按季', 'yearly:按年');
const SEAL_STATE = o('kept:在位', 'ordinary_kept:普通章在位', 'missing:缺失');
const SEAL_KIND = o('anti_fake:防伪章', 'self_carved:自刻章');
const MATERIAL = o('kept:在位', 'missing:缺失');
/** 档案可以挂接的资料类型（旧系统 8 种）；选了类型，就只出现对应的那个关联字段 */
const ARCHIVE_RELATED_TYPES = o('license:营业执照', 'store:店铺', 'bank_account:银行开户档案', 'fixed_asset:固定资产', 'partner_profile:合作人档案', 'trademark:商标', 'qualification:资质', 'tax_profile:税务档案');

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
    batch: ['status'],
    copyOmit: ['licenseNo', 'companyName', 'creditCode', 'originalPhoto', 'copyPhoto'],
    filterBy: ['annualAuditMonth', 'publicAccountFlag', 'sealFlag', 'locationFlag', 'photoFlag'],
    related: [
      { type: 'stores', field: 'licenseId' },
      { type: 'bank-accounts', field: 'licenseId' },
      { type: 'qualifications', field: 'licenseId' },
      { type: 'tax-profiles', field: 'licenseId' },
      { type: 'partners', field: 'licenseId' },
      { type: 'trademarks', field: 'licenseId' },
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
      date('expiresAt', '营业期限至', '基础', { list: true, help: '长期经营的不用填；到期前会在资料总览的“即将到期”里提醒' }),
      text('registrar', '登记机关', '基础'),
      { key: 'annualAuditDay', label: '年审日期(月-日)', type: 'monthday', group: '基础', list: true, help: '每年这一天前 30 天起出现在“资料总览”的需要关注里' },
      select('annualAuditMonth', '年审月份', '基础', o('01:1 月', '02:2 月', '03:3 月', '04:4 月', '05:5 月', '06:6 月', '07:7 月', '08:8 月', '09:9 月', '10:10 月', '11:11 月', '12:12 月'), { readonly: true }),
      select('publicAccountFlag', '公户情况', '银行', o('yes:有公户', 'no:未开通'), { readonly: true }),
      select('sealFlag', '印章情况', '印章', o('lost:有印章遗失', 'ok:印章齐全'), { readonly: true }),
      select('locationFlag', '存放位置情况', '实物', o('none:没有存放位置'), { readonly: true }),
      select('photoFlag', '照片情况', '照片', o('gap:照片缺项'), { readonly: true }),
      textarea('abnormalReason', '异常原因', '基础', { showWhen: { field: 'status', in: ['abnormal'] } }),
      text('legalPhone', '法人预留手机', '基础', { search: true }),
      ref('locationId', '存放总位置', '实物', 'locations', { list: true, help: '改总位置时，位置为空或和旧总位置相同的正本、副本位置会跟着改' }),
      files('originalPhoto', '正本照片', '照片', { accept: 'image', maxFiles: 1 }),
      { key: 'originalPhotoMissing', label: '正本照片缺失', type: 'bool', group: '照片', help: '只表示没有照片，不代表实物缺失' },
      files('copyPhoto', '副本照片', '照片', { accept: 'image', maxFiles: 1 }),
      { key: 'copyPhotoMissing', label: '副本照片缺失', type: 'bool', group: '照片', help: '只表示没有照片，不代表实物缺失' },
      text('borrowedSummary', '借出情况', '实物', { readonly: true, list: true, maxLength: 500 }),
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
      text('reconcileDay', '对账提醒日', '银行', { help: '月：几号；季：季度末月（3/6/9/12 月）的第几天；年：MM-DD', maxLength: 8 }),
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
      ref('borrowerUserId', '借用人（员工）', '基础', 'user', { help: '公司员工选这里；外部人员填下面的姓名，二选一' }),
      text('borrowerName', '借用人（外部人员）', '基础'),
      text('borrower', '借用人', '基础', { readonly: true, list: true }),
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
      { value: 'done', label: '已完成', tone: 'ok' },
      { value: 'pending', label: '处理中', tone: 'warn' },
      { value: 'abnormal', label: '异常', tone: 'bad' },
    ],
    defaultStatus: 'done',
    fields: [
      ref('licenseId', '营业执照', '基础', 'licenses', { required: true }),
      select('item', '使用物品', '基础', o('original:正本', 'copy:副本', 'official:公章', 'finance:财务章', 'legal:法人章', 'invoice:发票章', 'other:其他'), { required: true, list: true }),
      ref('userId', '使用人', '基础', 'user', { list: true }),
      text('usageType', '使用类型', '基础', { list: true, help: '不填按“业务办理”' }),
      text('purpose', '用途', '基础', { required: true, list: true }),
      text('relatedObject', '关联对象', '基础', { list: true, maxLength: 160, help: '如某店铺入驻、某份合同' }),
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
    statuses: [NORMAL, ABNORMAL_R, CANCELLED, INACTIVE],
    filterBy: ['claimStatus', 'operatorUserId', 'jushuitan', 'operatingStatus'],
    quickTabs: [
      { key: 'operating', label: '在运营', when: { all: [{ field: 'operatorUserId', op: 'notEmpty' }, { field: '$status', op: 'in', value: ['normal', 'abnormal'] }] } },
      { key: 'legacy-owner', label: '历史负责人未指派', when: { all: [{ field: 'legacyOwnerName', op: 'notEmpty' }, { field: 'operatorUserId', op: 'empty' }, { field: '$status', op: 'notIn', value: ['inactive', 'cancelled'] }] } },
      { key: 'public', label: '公共待领取', when: { all: [{ field: 'claimStatus', op: 'eq', value: 'public' }, { field: 'operatorUserId', op: 'empty' }, { field: '$status', op: 'notIn', value: ['inactive', 'cancelled'] }] } },
      { key: 'abnormal', label: '异常', when: { field: '$status', op: 'eq', value: 'abnormal' } },
      { key: 'cancelled', label: '已注销', includeHidden: true, when: { field: '$status', op: 'eq', value: 'cancelled' } },
    ],
    batchActions: [
      { key: 'assign', label: '批量指派运营', pick: 'operatorUserId', set: { claimStatus: 'claimed' }, reasonRequired: true, reasonLabel: '指派原因' },
      { key: 'release', label: '批量收回为公共店铺', set: { claimStatus: 'public', operatorUserId: null }, reasonRequired: true, reasonLabel: '收回原因' },
    ],
    batch: ['operatorUserId', 'claimStatus', 'status'],
    importMatch: ['storeNo', 'name'],
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
      text('abnormalReasonText', '新的异常原因', '基础', { maxLength: 100, showWhen: { field: 'status', in: ['abnormal'] }, help: '库里没有合适的就直接填，保存后自动记入异常原因库' }),
      select('claimStatus', '领取状态', '领取', o('public:公共店铺', 'claimed:已领取', 'reserved:预留店铺', 'promotion_limited:推广限制店铺'), { list: true, help: '领用规则（提示）：主营平台每人 3 个、其他平台各 1 个；预留店铺每人 5 个，3 个月未启用收回公共库；推广限制店铺解除日后第 3 天释放到公共库' }),
      text('legacyOwnerName', '历史负责人（未指派）', '领取', { maxLength: 100, help: '旧资料里记着的负责人，不算当前运营；没有运营人时在列表里提示“未指派”，确认后用“指派运营”处理' }),
      ref('operatorUserId', '运营人', '领取', 'user', { list: true, help: '只能选在职员工；选了运营人的公共店铺自动变为已领取，预留/领取/推广限制必须有运营人' }),
      date('promotionReleaseAt', '推广限制解除日', '领取', { showWhen: { field: 'claimStatus', in: ['promotion_limited'] } }),
      text('account', '店铺账号', '账号', { search: true }),
      secret('storePassword', '店铺密码', '账号'),
      secret('withdrawPassword', '提现支付密码', '账号'),
      text('phoneNumber', '绑定手机号', '账号', { help: '必须是已建档的手机号', search: true }),
      ref('phoneId', '手机号档案', '账号', 'phones', { help: '只选档案也可以，号码文本会自动带出' }),
      refs('phoneIds', '更多绑定手机号', '账号', 'phones', { help: '一店可绑多个手机号，同一手机号在同一平台只能绑一个店铺' }),
      select('jushuitan', '聚水潭', '授权与资质', o('connected:已连接', 'not_connected:未连接')),
      date('jushuitanExpireAt', '聚水潭到期日', '授权与资质'),
      text('jushuitanShopId', '聚水潭店铺编号', '授权与资质', { maxLength: 64, search: true, help: '聚水潭里这个店铺的编号；直播管理按它只读核对本场订单和退款，没有就不能报下播' }),
      refs('trademarkIds', '授权商标档案', '授权与资质', 'trademarks', { help: '关联商标档案；到期日仍以下面“商标授权到期日”为准' }),
      text('trademark', '授权商标', '授权与资质'),
      date('trademarkExpireAt', '商标授权到期日', '授权与资质'),
      select('qualification', '资质上传', '授权与资质', o('not_uploaded:未上传', 'uploaded:已上传', 'reviewing:审核中', 'approved:已通过', 'rejected:被驳回', 'not_required:无需上传')),
      text('qualificationNote', '资质备注', '授权与资质'),
      files('qualificationFiles', '资质文件', '授权与资质', { maxFiles: 9 }),
      // 资金口径以“店铺资金”快照为准：这四项只读，由服务端取最新一条快照派生，不存在手填
      money('deposit', '保证金', '资金', { readonly: true, help: '最新店铺资金快照的值（在“店铺经营数据 > 店铺资金”里录入）' }),
      money('frozen', '冻结资金', '资金', { readonly: true, help: '最新店铺资金快照的值' }),
      money('goodsFund', '货款', '资金', { readonly: true, help: '最新店铺资金快照的“可提现”' }),
      money('promotionBalance', '推广费余额', '资金', { readonly: true, help: '最新店铺资金快照的值' }),
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
      { key: 'productViews', label: '商品浏览量', type: 'number', group: '经营' },
      { key: 'productReviews', label: '商品评价数', type: 'number', group: '经营' },
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
      { key: 'conversionRate', label: '转化率(%)', type: 'decimal', scale: 2, group: '数据' },
      text('itemUrl', '推广商品链接', '数据'),
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
      select('source', '数据来源', '基础', o('manual:手工录入', 'import:导入', 'api:接口同步', 'legacy:旧系统档案登记')),
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
    filterBy: ['feeCycle'],
    statuses: [NORMAL, ABNORMAL_R, { ...INACTIVE, label: '停止使用' }],
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
      text('carrier', '运营商', '基础', { list: true, help: '新建时默认中国移动' }),
      { key: 'cardKind', label: '主子卡', type: 'text', group: '基础', readonly: true, list: true, help: '由“主卡”字段决定：没有主卡就是主卡，选了主卡就是子卡' },
      { key: 'boundStores', label: '绑定店铺', type: 'text', group: '基础', readonly: true, list: true, help: '店铺档案里绑了这个手机号的店铺，在店铺里维护' },
      { key: 'boundStoreNos', label: '店铺编号', type: 'text', group: '基础', readonly: true },
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
      text('forwardAppName', '转发 App 名称', '使用', { showWhen: { field: 'forwardApp', in: ['yes'] } }),
      ref('partnerId', '合作人', '使用', 'partners', { showWhen: { field: 'usageType', in: ['partner_used'] } }),
      ref('keeperUserId', '保管人', '使用', 'user'),
      text('keeperName', '保管人(手填)', '使用'),
      money('monthlyFee', '月费', '费用'),
      select('feeCycle', '费用周期', '费用', o('monthly:月付', 'quarterly:季付', 'yearly:年付')),
      date('lastRechargeAt', '最近充值日', '费用'),
      { key: 'rechargeCycleDays', label: '充值周期(天)', type: 'number', group: '费用' },
      date('nextRechargeAt', '下次充值日', '费用', { list: true, help: '由最近充值日 + 充值周期自动计算' }),
      ref('abnormalReason', '异常原因', '状态', 'phone-abnormal-reasons', { showWhen: { field: 'status', in: ['abnormal'] } }),
      text('abnormalReasonText', '新的异常原因', '状态', { maxLength: 100, showWhen: { field: 'status', in: ['abnormal'] }, help: '库里没有合适的就直接填，保存后自动记入异常原因库' }),
      NOTE(),
    ],
  },
  {
    key: 'tax-profiles',
    label: '税务资料',
    nav: { group: '经营资料' },
    titleField: 'taxpayerName',
    tabsBy: 'taxCategory',
    // 一张执照可以同时有经营、电商两份税务资料，同类别只能一份
    uniqueTogether: [{ fields: ['licenseId', 'taxCategory'], message: '这个营业执照已经有同类别的税务资料了' }],
    derivedStores: 'licenseId',
    computedFilters: [
      { key: 'licenseState', label: '执照情况', options: [
        { value: 'none', label: '没有绑定营业执照', when: { field: 'licenseId', op: 'empty' } },
        { value: 'closed', label: '执照已停用或注销', when: { viaRef: 'licenseId', where: { field: '$status', op: 'in', value: ['inactive', 'cancelled'] } } },
      ] },
    ],
    derivedColumns: [
      { key: 'storeCount', label: '店铺数', kind: 'count', type: 'stores', field: 'licenseId', match: 'licenseId', list: true },
      { key: 'monthSales', label: '执照本月营业额', kind: 'sum', type: 'store-daily-metrics', field: 'storeId', via: { type: 'stores', field: 'licenseId' }, match: 'licenseId', sumField: 'sales', month: 'day', format: 'money', list: true },
    ],
    batch: ['status'],
    filterBy: ['taxType', 'licenseId'],
    statuses: [NORMAL, ABNORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      select('taxCategory', '类别', '基础', o('operation:经营税务', 'ecommerce:电商税务'), { list: true, help: '不选时跟随所属执照的类别' }),
      ref('licenseId', '所属执照', '基础', 'licenses', { required: true, list: true }),
      text('taxpayerName', '纳税人名称', '基础', { list: true, search: true, help: '不填时取所属执照的主体名称' }),
      text('taxpayerNo', '纳税人识别号', '基础', { list: true, search: true, maxLength: 32 }),
      select('taxType', '税种类型', '基础', o('pending:待确认', 'general:一般纳税人', 'small:小规模纳税人', 'ordinary:普通纳税人'), { list: true }),
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
    batch: ['status'],
    copyOmit: ['partnerNo', 'name', 'phone'],
    filterBy: ['cardFlag'],
    statuses: [
      { value: 'active', label: '合作中', tone: 'ok' },
      { value: 'abnormal', label: '异常', tone: 'warn' },
      { value: 'terminated', label: '解除合作', tone: 'muted', requiresReason: true, hidden: true },
    ],
    defaultStatus: 'active',
    fields: [
      select('partnerType', '类型', '基础', o('partner:合作人', 'legal:法人', 'business:合作商', 'other:其他'), { list: true, help: '不选按合作人处理；执照自动建的法人档案是“法人”' }),
      text('partnerNo', '编号', '基础', { list: true, search: true }),
      text('name', '姓名', '基础', { required: true, list: true, search: true }),
      { key: 'phone', label: '联系电话', type: 'phone', group: '基础', list: true, search: true },
      sensitive('idNumber', '身份证号', '基础'),
      ref('licenseId', '所属执照', '关联', 'licenses', { list: true }),
      ref('storeId', '店铺', '关联', 'stores'),
      text('cooperationScope', '合作范围', '合作', { list: true, maxLength: 240 }),
      date('startedAt', '开始时间', '合作', { list: true }),
      date('endedAt', '结束时间', '合作'),
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
      text('cardPhoneHolder', '预留手机号姓名', '银行卡'),
      ref('cardPhoneId', '预留手机号档案', '银行卡', 'phones', { help: '填了预留手机且档案里有这个号码时自动关联' }),
      select('cardFlag', '银行卡登记', '银行卡', o('yes:已登记', 'no:未登记'), { readonly: true }),
      textarea('abnormalReason', '异常原因', '状态', { showWhen: { field: 'status', in: ['abnormal'] } }),
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
    children: ['u-shields', 'bank-store-links'],
    batch: ['status'],
    copyOmit: ['reservedPhoneNumber', 'phoneId', 'customerNo'],
    filterBy: ['licenseId', 'storeId', 'storeFlag', 'phoneFlag', 'shieldFlag'],
    fields: [
      select('kind', '账户类型', '基础', o('company_public:公司公户', 'company_card:公司银行卡', 'cashier_account:出纳账户', 'store_public:店铺公户', 'store_personal_card:店铺个人银行卡'), { required: true, list: true }),
      text('accountName', '户名', '基础', { required: true, list: true, search: true }),
      text('bank', '开户行', '基础', { required: true, list: true, search: true }),
      sensitive('accountNo', '账号/卡号', '基础', { required: true, list: true, pattern: { source: '^[0-9 \\-]{6,40}$', message: '账号只能是数字、空格、横线，6 到 40 位' } }),
      text('ownerName', '所属人', '基础', { list: true }),
      ref('licenseId', '所属执照', '关联', 'licenses', { list: true }),
      ref('storeId', '关联店铺', '关联', 'stores', { help: '主要关联的店铺；一个账户对应多个店铺、区分用途的，在详情的“账户店铺”里登记' }),
      select('storeFlag', '店铺关联', '关联', o('yes:已关联店铺', 'no:未关联店铺'), { readonly: true }),
      select('phoneFlag', '预留手机号', '关联', o('linked:已关联档案', 'unlinked:有号码未关联', 'none:未填写'), { readonly: true }),
      { key: 'shieldCount', label: 'U 盾个数', type: 'number', group: '关联', list: true, readonly: true },
      select('shieldFlag', 'U 盾', '关联', o('has:有 U 盾', 'none:没有 U 盾'), { readonly: true }),
      ref('keeperUserId', '保管人', '关联', 'user'),
      text('reservedPhoneNumber', '预留手机', '关联'),
      text('reservedPhoneHolder', '预留手机持有人', '关联'),
      ref('phoneId', '关联手机号档案', '关联', 'phones'),
      text('customerNo', '客户号', '公户信息', { showWhen: { field: 'kind', in: ['company_public', 'store_public'] } }),
      ref('openingArchiveLocationId', '开户档案位置', '公户信息', 'locations', { showWhen: { field: 'kind', in: ['company_public', 'store_public'] } }),
      files('attachments', '开户附件', '公户信息', { maxFiles: 4, showWhen: { field: 'kind', in: ['company_public', 'store_public'] } }),
      money('balance', '期初余额', '对账', { help: '建账时登记的期初金额；当前余额由财务“现金银行”按单据过账实时计算' }),
      select('reconcileCycle', '对账周期', '对账', RECONCILE),
      text('reconcileDay', '对账提醒日', '对账', { maxLength: 8, help: '月：几号；季：季度末月（3/6/9/12 月）的第几天；年：MM-DD' }),
      textarea('abnormalReason', '异常原因', '状态', { showWhen: { field: 'status', in: ['abnormal'] } }),
      NOTE(),
    ],
  },
  {
    // 兼职与临时工（旧系统资料导航“组织与人员”里的“兼职与临时工 / 期限与计薪”）：
    // 每人一条档案，登录账号、岗位、直属上级仍在“人员档案”里维护，这里管合作期限、计薪、联系人和附件；
    // 合作期外账号自动不能登录，计时工资同步给直播主播工资。
    key: 'workforce',
    label: '兼职与临时工',
    nav: { group: '组织与人员' },
    titleField: 'name',
    uniqueField: 'userId',
    statuses: [{ value: 'active', label: '合作中', tone: 'ok' }, { value: 'inactive', label: '已停用', tone: 'muted', requiresReason: true, hidden: true }],
    defaultStatus: 'active',
    batch: ['status'],
    filterBy: ['employmentType', 'payMethod'],
    sortField: 'contractStartDate',
    quickTabs: [
      { key: 'working', label: '合作中', when: { all: [{ field: '$status', op: 'eq', value: 'active' }, { not: { field: 'contractStartDate', op: 'future' } }, { not: { field: 'contractEndDate', op: 'expired' } }] } },
      { key: 'pending', label: '待开始', when: { all: [{ field: '$status', op: 'eq', value: 'active' }, { field: 'contractStartDate', op: 'future' }] } },
      { key: 'ended', label: '已到期', when: { all: [{ field: '$status', op: 'eq', value: 'active' }, { field: 'contractEndDate', op: 'expired' }] } },
      { key: 'no-position', label: '没有岗位', when: { all: [{ field: '$status', op: 'eq', value: 'active' }, { viaUserNoPosition: 'userId' }] } },
      { key: 'ending', label: '7 天内结束', when: { all: [{ field: '$status', op: 'eq', value: 'active' }, { field: 'contractEndDate', op: 'dateWithin', days: 7 }] } },
    ],
    computedFilters: [
      { key: 'dept', label: '部门', optionsFrom: 'departments', when: { viaUserDept: 'userId', dept: '$value', includeChildren: true } },
    ],
    alerts: [{ field: 'contractEndDate', withinDays: 7, label: '7 天内合作结束' }],
    fields: [
      ref('userId', '登录账号（员工）', '基本信息', 'user', { required: true, list: true, help: '先在“人员档案”新增账号（用工类型选兼职/临时工），或点页头“新增账号并建档”一步完成；保存后该员工的用工类型自动变为这里选的类型' }),
      text('name', '姓名', '基本信息', { readonly: true, list: true, search: true, maxLength: 80 }),
      select('employmentType', '用工类型', '基本信息', o('part_time:兼职', 'temp:临时工'), { required: true, list: true, help: '临时工必须填写合作结束日期；兼职可以不限期' }),
      select('cooperation', '合作状态', '基本信息', o('working:合作中', 'pending:待开始', 'ended:合作已到期', 'inactive:已停用'), { readonly: true, list: true }),
      text('account', '登录账号', '账号与岗位', { readonly: true, search: true, maxLength: 64 }),
      text('departmentName', '部门', '账号与岗位', { readonly: true, list: true, search: true, maxLength: 100 }),
      text('positionName', '岗位', '账号与岗位', { readonly: true, list: true, search: true, maxLength: 100 }),
      text('managerName', '直属上级', '账号与岗位', { readonly: true, maxLength: 100 }),
      select('accountStatus', '账号状态', '账号与岗位', o('active:启用', 'disabled:已停用'), { readonly: true }),
      text('lastLoginAt', '最近登录', '账号与岗位', { readonly: true, maxLength: 32 }),
      date('contractStartDate', '合作开始日期', '合作与计薪', { required: true, list: true }),
      date('contractEndDate', '合作结束日期', '合作与计薪', { list: true, help: '到这一天（含）之后的第二天起，账号自动不能登录；临时工必填，兼职可不限期' }),
      select('payMethod', '计薪方式', '合作与计薪', o('hourly:计时', 'daily:计天', 'monthly:计月', 'piece:计件'), { list: true, permission: 'org.staff.salary', help: '计时且单价大于 0 时，同步为该员工的时薪（直播主播工资默认取它）' }),
      money('payRate', '单价（元）', '合作与计薪', { list: true, permission: 'org.staff.salary', help: '按所选计薪方式的单价，如计天 200 元/天；0 表示还没定价' }),
      text('workLocation', '工作地点', '合作与计薪', { maxLength: 160, search: true, help: '例如：仓库A区' }),
      textarea('shiftNote', '班次 / 排班说明', '合作与计薪', { maxLength: 255, help: '例如：周一至周五 9:00-18:00' }),
      { key: 'phone', label: '手机号', type: 'phone', group: '联系方式', search: true, list: true },
      text('emergencyContactName', '紧急联系人', '联系方式', { maxLength: 80 }),
      { key: 'emergencyContactPhone', label: '紧急联系人电话', type: 'phone', group: '联系方式' },
      files('contractFiles', '合同', '附件材料', { accept: 'any', maxFiles: 20 }),
      files('identityFiles', '身份证明', '附件材料', { accept: 'any', maxFiles: 20 }),
      files('paymentFiles', '银行卡/收款码', '附件材料', { accept: 'any', maxFiles: 20 }),
      files('qualificationFiles', '体检/资质', '附件材料', { accept: 'any', maxFiles: 20 }),
      files('otherFiles', '其他附件', '附件材料', { accept: 'any', maxFiles: 20, help: '五类附件合计每人最多 20 个，支持图片和 PDF' }),
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
    quickTabs: [
      { key: 'empty', label: '没有成员', when: { all: [{ field: '$status', op: 'ne', value: 'inactive' }, { rel: { type: 'duty-group-members', field: 'groupId', where: { field: '$status', op: 'eq', value: 'normal' } }, op: 'none' }] } },
      { key: 'uncat', label: '未分类', when: { all: [{ field: '$status', op: 'ne', value: 'inactive' }, { field: 'departmentId', op: 'empty' }] } },
    ],
    // 按部门分类：列表按部门分组（可折叠），可按部门（含下级）筛选；没有部门的归“未分类”
    listGroupBy: { field: 'departmentId', emptyLabel: '未分类', order: 'department' },
    computedFilters: [
      { key: 'dutyDept', label: '所属部门', optionsFrom: 'departments', when: { deptField: 'departmentId', dept: '$value', includeChildren: true } },
    ],
    derivedColumns: [
      { key: 'memberCount', label: '成员数', kind: 'count', type: 'duty-group-members', field: 'groupId', where: { field: '$status', op: 'eq', value: 'normal' }, list: true },
      { key: 'itemCount', label: '职责数', kind: 'count', type: 'duty-group-items', field: 'groupId', where: { field: '$status', op: 'ne', value: 'inactive' }, list: true },
    ],
    fields: [
      text('groupKey', '职责组编码', '基础', { required: true, list: true, search: true, help: '流程和任务按编码引用，建好后不能修改' }),
      text('name', '职责组名称', '基础', { required: true, list: true, search: true }),
      ref('departmentId', '所属部门', '基础', 'department', { list: true, help: '职责组按部门分类；不选则归“未分类”' }),
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
    uniqueTogether: [{ fields: ['groupId', 'userId'], message: '这个员工已经在该职责组里了；退出过的请直接改回“在组”' }],
    statuses: [NORMAL, { value: 'exited', label: '已退出', tone: 'muted', requiresReason: true }],
    defaultStatus: 'normal',
    fields: [
      ref('groupId', '职责组', '基础', 'duty-groups', { required: true }),
      ref('userId', '成员', '基础', 'user', { required: true, list: true }),
      text('role', '组内角色', '基础', { list: true }),
      select('source', '来源', '基础', o('manual:手动加入', 'position:岗位自动', 'import:导入'), { list: true, help: '默认手动加入' }),
      date('startedAt', '加入日期', '基础', { list: true }),
      date('endedAt', '退出日期', '基础', { help: '退出时填写；晚于加入日期' }),
    ],
  },
  {
    key: 'u-shields',
    label: 'U 盾',
    parent: { type: 'bank-accounts', field: 'bankAccountId' },
    titleField: 'name',
    statuses: [NORMAL, { value: 'borrowed', label: '借出', tone: 'warn' }, { value: 'lost', label: '遗失', tone: 'bad' }, ABNORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      ref('bankAccountId', '银行账户', '基础', 'bank-accounts', { required: true }),
      text('name', '名称', '基础', { required: true, list: true, search: true }),
      text('shieldNo', 'U 盾编号', '基础', { list: true, search: true, maxLength: 120 }),
      ref('keeperUserId', '保管人', '基础', 'user', { list: true }),
      ref('locationId', '存放位置', '基础', 'locations', { list: true }),
      secret('loginPassword', '登录密码', '密码'),
      secret('tradePassword', '交易密码', '密码'),
      NOTE(),
    ],
  },
  {
    // 银行账户 ⇄ 店铺（一个账户可对应多个店铺，并区分用途）
    key: 'bank-store-links',
    label: '账户店铺',
    parent: { type: 'bank-accounts', field: 'bankAccountId' },
    titleField: 'label',
    uniqueTogether: [{ fields: ['bankAccountId', 'storeId', 'purpose'], message: '这个账户已经登记过该店铺的同一用途' }],
    statuses: [NORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      ref('bankAccountId', '银行账户', '基础', 'bank-accounts', { required: true }),
      ref('storeId', '店铺', '基础', 'stores', { required: true, list: true }),
      text('purpose', '用途', '基础', { required: true, list: true, maxLength: 120, help: '如：店铺收款、提现、保证金、推广充值' }),
      text('label', '名称', '基础', { readonly: true, maxLength: 200 }),
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
    statuses: [NORMAL, ABNORMAL, { value: 'renewing', label: '续期中', tone: 'warn' }, { value: 'expired', label: '已过期', tone: 'bad' }, INACTIVE],
    defaultStatus: 'normal',
    derivedStores: 'licenseId',
    batch: ['status'],
    filterBy: ['licenseId'],
    alerts: [{ field: 'expiresAt', withinDays: 30, label: '30 天内到期' }],
    fields: [
      select('type', '类型', '基础', o('seed_business_filing:种子生产经营备案', 'brand_authorization:品牌授权', 'platform_operation:平台经营资质', 'general:其他资质'), { list: true, help: '不选按“其他资质”' }),
      text('name', '名称', '基础', { required: true, list: true, search: true }),
      text('certNo', '证书号', '基础', { list: true, search: true }),
      ref('licenseId', '所属执照', '基础', 'licenses', { list: true }),
      date('filedAt', '备案日期', '基础'),
      date('expiresAt', '到期日', '基础', { list: true }),
      text('filedProducts', '备案商品', '基础'),
      text('reviewContact', '审核联系人', '基础'),
      text('platformAccount', '平台登录账号', '平台账号'),
      { ...secret('platformPassword', '平台登录密码', '平台账号'), importable: true },
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
    children: ['trademark-authorizations'],
    batch: ['status'],
    copyOmit: ['name', 'applicationNo', 'registrationNo'],
    alerts: [{ field: 'validUntil', withinDays: 90, label: '90 天内到期' }],
    fields: [
      select('source', '来源', '基础', o('owned:自有', 'cooperative:合作'), { required: true, list: true }),
      text('name', '商标名称', '基础', { required: true, list: true, search: true }),
      text('classNo', '类别', '基础', { list: true }),
      text('applicant', '申请人', '基础', { list: true }),
      ref('licenseId', '申请人执照', '基础', 'licenses'),
      text('cooperativeContact', '合作商标所属方（授权方）', '基础', { showWhen: { field: 'source', in: ['cooperative'] } }),
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
    // 商标 → 店铺授权（多对多，带授权期）；保存后回写店铺的“授权商标/授权商标到期”
    key: 'trademark-authorizations',
    label: '店铺授权',
    parent: { type: 'trademarks', field: 'trademarkId' },
    titleField: 'label',
    uniqueTogether: [{ fields: ['trademarkId', 'storeId'], message: '这个商标已经授权给该店铺了' }],
    sortField: 'validTo',
    alerts: [{ field: 'validTo', withinDays: 90, label: '商标授权到期' }],
    statuses: [NORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      ref('trademarkId', '商标', '基础', 'trademarks', { required: true }),
      ref('storeId', '店铺', '基础', 'stores', { required: true, list: true }),
      date('validFrom', '授权开始', '基础', { list: true }),
      date('validTo', '授权到期', '基础', { list: true }),
      text('label', '名称', '基础', { readonly: true, maxLength: 200 }),
      NOTE(),
    ],
  },
  {
    key: 'self-media',
    label: '自媒体账号',
    nav: { group: '经营资料' },
    titleField: 'name',
    tabsBy: 'platform',
    statuses: [NORMAL, ABNORMAL_R, INACTIVE],
    filterBy: 'operatorUserId',
    importMatch: ['platform', 'name'],
    computedFilters: [
      { key: 'operatorDept', label: '运营部门', optionsFrom: 'departments', when: { viaUserDept: 'operatorUserId', dept: '$value', includeChildren: true } },
    ],
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
      refs('storeIds', '更多关联店铺', '关联', 'stores', { help: '一个自媒体账号可关联多个店铺' }),
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
    computedFilters: [
      { key: 'phoneArchive', label: '手机号档案', options: [
        { value: 'linked', label: '已关联手机号档案', when: { field: 'phoneId', op: 'notEmpty' } },
        { value: 'unlinked', label: '未关联手机号档案', when: { field: 'phoneId', op: 'empty' } },
      ] },
    ],
    statuses: [NORMAL, ABNORMAL_R, INACTIVE],
    filterBy: 'userId',
    defaultStatus: 'normal',
    fields: [
      text('name', '名称', '基础', { required: true, list: true, search: true }),
      text('wechatNo', '微信号', '基础', { required: true, list: true, search: true, maxLength: 64 }),
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
    statuses: [NORMAL, { value: 'suspended', label: '停机', tone: 'warn', requiresReason: true }, CANCELLED],
    filterBy: ['locationId'],
    defaultStatus: 'normal',
    fields: [
      text('account', '宽带账号', '基础', { required: true, list: true, search: true }),
      ref('locationId', '安装位置', '基础', 'locations', { list: true }),
      text('locationNote', '位置说明', '基础', { help: '位置档案里没有的地点可在这里写明' }),
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
    statuses: [NORMAL, ABNORMAL, { value: 'expiring', label: '即将到期', tone: 'warn' }, { value: 'expired', label: '已过期', tone: 'bad' }, { value: 'renewing', label: '续费中', tone: 'warn' }, { value: 'needs_recharge', label: '需充值', tone: 'warn' }, { value: 'paused', label: '暂停', tone: 'muted' }, INACTIVE],
    filterBy: ['ownerUserId'],
    importMatch: ['provider', 'title'],
    quickTabs: [
      { key: 'due-soon', label: '即将到期', when: { all: [{ field: '$status', op: 'notIn', value: ['inactive'] }, { field: 'endAt', op: 'dateWithin', days: 30 }] } },
      { key: 'expired', label: '已过期', when: { all: [{ field: '$status', op: 'notIn', value: ['inactive'] }, { field: 'endAt', op: 'expired' }] } },
      { key: 'domain', label: '域名', when: { all: [{ field: 'kind', op: 'eq', value: 'service' }, { any: [{ field: 'serviceType', op: 'in', value: ['域名', 'domain', 'Domain'] }] }] } },
    ],
    defaultStatus: 'normal',
    alerts: [{ field: 'endAt', withinDays: 30, label: '30 天内到期' }],
    fields: [
      select('kind', '类型', '基础', o('account:账号', 'service:服务'), { required: true, list: true }),
      text('title', '名称', '基础', { required: true, list: true, search: true }),
      text('provider', '服务商', '基础', { required: true, list: true, search: true }),
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
    label: '软件订阅',
    nav: { group: '账号与资质', hidden: true },
    titleField: 'name',
    statuses: [NORMAL, { value: 'renewing', label: '续费中', tone: 'warn' }, { value: 'expired', label: '已过期', tone: 'bad' }, INACTIVE],
    defaultStatus: 'normal',
    uniqueTogether: [{ fields: ['name', 'account'], message: '同名软件的这个账号已经登记过了' }],
    importMatch: ['name', 'account'],
    alerts: [{ field: 'renewAt', withinDays: 30, label: '30 天内需续费' }],
    fields: [
      text('name', '软件名称', '基础', { required: true, list: true, search: true }),
      ref('storeId', '关联店铺', '基础', 'stores', { list: true }),
      text('account', '账号', '基础', { required: true, list: true, search: true }),
      secret('password', '密码', '基础'),
      date('renewAt', '续费日期', '费用', { list: true }),
      money('annualFee', '年费', '费用'),
      NOTE(),
    ],
  },
  {
    key: 'fixed-assets',
    label: '固定资产',
    filterBy: ['categoryId', 'locationId', 'userId', 'departmentId'],
    treeManage: ['categoryId'],
    treeExclude: { locationId: { field: 'scope', values: ['asset_space'] } },
    quickTabs: [
      { key: 'in-use', label: '使用中', when: { field: '$status', op: 'eq', value: 'in_use' } },
      { key: 'idle', label: '闲置', when: { field: '$status', op: 'eq', value: 'idle' } },
      { key: 'repairing', label: '维修中', when: { field: '$status', op: 'eq', value: 'repairing' } },
      { key: 'lost', label: '丢失', when: { field: '$status', op: 'eq', value: 'lost' } },
      { key: 'warranty', label: '保修将到期', when: { all: [{ field: '$status', op: 'notIn', value: ['retired', 'lost'] }, { field: 'warrantyUntil', op: 'dateWithin', days: 30 }] } },
      { key: 'no-location', label: '没填位置', when: { all: [{ field: '$status', op: 'ne', value: 'retired' }, { field: 'locationId', op: 'empty' }] } },
    ],
    nav: { group: '公司资产' },
    titleField: 'name',
    uniqueField: 'assetNo',
    statuses: [
      { value: 'idle', label: '闲置', tone: 'muted' },
      { value: 'in_use', label: '使用中', tone: 'ok' },
      { value: 'repairing', label: '维修中', tone: 'warn' },
      { value: 'retired', label: '已报废', tone: 'muted', requiresReason: true, hidden: true },
      { value: 'lost', label: '丢失', tone: 'bad', requiresReason: true },
    ],
    defaultStatus: 'idle',
    alerts: [{ field: 'warrantyUntil', withinDays: 30, label: '保修即将到期' }],
    fields: [
      text('assetNo', '系统编号', '基础', { list: true, search: true, maxLength: 64, help: '不填则自动生成 ASSET-xxxxxx' }),
      text('customAssetNo', '自定义编号', '基础', { list: true, search: true, maxLength: 64 }),
      text('name', '名称', '基础', { required: true, list: true, search: true }),
      ref('categoryId', '分类', '基础', 'asset-categories', { list: true, cascade: true }),
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
      ref('userId', '使用人', '使用', 'user', { list: true, help: '新建时选了使用人就直接记为使用中；之后通过「领用、转交、归还」变更' }),
      ref('keeperUserId', '保管人', '使用', 'user', { list: true }),
      ref('departmentId', '所属部门', '使用', 'department', { list: true }),
      ref('locationId', '位置', '使用', 'locations', { list: true, cascade: true, help: '按房间一级一级选；点位置可以看这个位置还存放了什么' }),
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
    tabsBy: 'scope',
    statuses: [NORMAL, INACTIVE],
    defaultStatus: 'normal',
    fields: [
      text('name', '位置名称', '基础', { required: true, list: true, search: true }),
      select('scope', '位置板块', '基础', o('area:区域位置', 'asset_space:固定资产储物空间'), { required: true, list: true }),
      select('locationType', '类型', '基础', o('building:办公楼/区域', 'floor:楼层', 'room:房间', 'cabinet:柜子', 'asset_slot:资产内部位置', 'shelf:层', 'drawer:抽屉', 'box:格/盒'), { list: true }),
      ref('parentId', '上级位置', '基础', 'locations', { list: true, cascade: true, help: '按楼、层、房间、柜子一级一级选' }),
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
      { value: 'stored', label: '在库', tone: 'ok' },
      { value: 'borrowed', label: '借出', tone: 'warn', requiresReason: true },
      { value: 'missing', label: '遗失', tone: 'bad', requiresReason: true },
      { value: 'archived', label: '已归档', tone: 'muted' },
    ],
    defaultStatus: 'stored',
    filterBy: ['locationId', 'keeperUserId'],
    quickTabs: [
      { key: 'stored', label: '在库', when: { field: '$status', op: 'eq', value: 'stored' } },
      { key: 'borrowed', label: '借出', when: { field: '$status', op: 'eq', value: 'borrowed' } },
      { key: 'missing', label: '遗失', when: { field: '$status', op: 'eq', value: 'missing' } },
      { key: 'no-location', label: '没填位置', when: { all: [{ field: '$status', op: 'ne', value: 'archived' }, { field: 'locationId', op: 'empty' }] } },
    ],
    fields: [
      text('archiveNo', '档案编号', '基础', { list: true, search: true, help: '不填则自动生成 ARCH-xxxxxx' }),
      text('name', '档案名称', '基础', { required: true, list: true, search: true }),
      text('archiveType', '类型', '基础', { list: true, search: true }),
      select('relatedType', '关联资料类型', '基础', ARCHIVE_RELATED_TYPES, { help: '这份档案属于哪类资料；不选则不关联' }),
      ref('licenseId', '关联营业执照', '基础', 'licenses', { list: true, showWhen: { field: 'relatedType', in: ['license'] } }),
      ref('storeId', '关联店铺', '基础', 'stores', { list: true, showWhen: { field: 'relatedType', in: ['store'] } }),
      ref('bankAccountId', '关联银行账户', '基础', 'bank-accounts', { list: true, showWhen: { field: 'relatedType', in: ['bank_account'] } }),
      ref('fixedAssetId', '关联固定资产', '基础', 'fixed-assets', { list: true, showWhen: { field: 'relatedType', in: ['fixed_asset'] } }),
      ref('partnerId', '关联合作人', '基础', 'partners', { list: true, showWhen: { field: 'relatedType', in: ['partner_profile'] } }),
      ref('trademarkId', '关联商标', '基础', 'trademarks', { list: true, showWhen: { field: 'relatedType', in: ['trademark'] } }),
      ref('qualificationId', '关联资质', '基础', 'qualifications', { list: true, showWhen: { field: 'relatedType', in: ['qualification'] } }),
      ref('taxProfileId', '关联税务档案', '基础', 'tax-profiles', { list: true, showWhen: { field: 'relatedType', in: ['tax_profile'] } }),
      ref('locationId', '存放位置', '基础', 'locations', { list: true, cascade: true, help: '房间、柜子、层位一级一级选，档案的位置就是它所在的柜层' }),
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

/** 列表上方的页签：tabsBy 字段的选项，其中被 tabSplit 拆开的那一项换成拆出的几个页签 */
export function resourceTabOptions(def: ResourceDef): readonly Option[] {
  const field = def.tabsBy ? def.fields.find((f) => f.key === def.tabsBy) : undefined;
  const options = field?.options ?? [];
  const split = def.tabSplit;
  if (!split) return options;
  return options.flatMap((o) => (o.value === split.tab ? split.options : [o]));
}

/** 页签值 → 查询条件：tabsBy 字段等于 value；拆出的页签还要求拆分字段等于某值（default 页签把没填的也算上） */
export function resourceTabCondition(def: ResourceDef, tab: string): { field: string; value: string; split?: { field: string; value: string; orMissing: boolean } } | null {
  if (!tab || !def.tabsBy || tab.startsWith('q:')) return null;
  const split = def.tabSplit;
  if (split && split.options.some((o) => o.value === tab)) return { field: def.tabsBy, value: split.tab, split: { field: split.field, value: tab, orMissing: tab === split.default } };
  return { field: def.tabsBy, value: tab };
}

/** 在某个页签下新建时，表单里要预先填好的值（拆出的页签同时带上 tabsBy 字段和拆分字段） */
export function resourceTabInitial(def: ResourceDef, tab: string): Record<string, unknown> {
  const c = resourceTabCondition(def, tab);
  if (!c) return {};
  return { [c.field]: c.value, ...(c.split ? { [c.split.field]: c.split.value } : {}) };
}

/** 一条记录属于哪个页签（拆出的页签按拆分字段，没填算 default） */
export function resourceTabOf(def: ResourceDef, data: Record<string, unknown>): string {
  const v = String(data[def.tabsBy ?? ''] ?? '');
  const split = def.tabSplit;
  if (split && v === split.tab) {
    const m = String(data[split.field] ?? '');
    return split.options.some((o) => o.value === m) ? m : split.default;
  }
  return v;
}

/** 这种资料自己是一棵树（有指向自己的“上级”字段），如商品分类、供应商分类 */
export function isTreeResource(key: string): boolean {
  return !!BY_KEY.get(key)?.fields.some((f) => f.key === 'parentId' && f.type === 'ref' && f.ref === key);
}

/** 列表左侧目录可以按哪些维度浏览：filterBy 里指向“树形资料”的字段（分类、位置），以及指向员工/部门的字段（使用人、所属部门） */
export function browseFilterFields(def: ResourceDef): FieldDef[] {
  const keys = def.filterBy ? ([] as string[]).concat(def.filterBy as string | string[]) : [];
  return keys
    .map((k) => def.fields.find((f) => f.key === k))
    .filter((f): f is FieldDef => !!f && (f.type === 'ref' || f.type === 'refs') && !!f.ref && (isTreeResource(f.ref) || ((f.ref === 'user' || f.ref === 'department') && f.type === 'ref')));
}

/** 列表左侧要显示分类目录的字段：filterBy 里第一个指向“树形资料”的关联字段 */
export function treeFilterField(def: ResourceDef): FieldDef | undefined {
  const keys = def.filterBy ? ([] as string[]).concat(def.filterBy as string | string[]) : [];
  return keys.map((k) => def.fields.find((f) => f.key === k)).find((f) => !!f && (f.type === 'ref' || f.type === 'refs') && !!f.ref && isTreeResource(f.ref));
}

/** optionsFrom 字段当前要用哪一种列表（kindBy 按另一个字段的值切换） */
export function optionsKindOf(field: FieldDef, values: Record<string, unknown>): string | null {
  const from = field.optionsFrom;
  if (!from) return null;
  if (from.kindBy) return from.kindBy.map[String(values[from.kindBy.field] ?? '')] ?? from.kind;
  return from.kind;
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
  context: { status: string; existing?: Record<string, unknown>; /** optionsFrom 字段当前允许的取值（公司维护的列表）；没有列出的字段退回静态 options */ dynamicOptions?: Record<string, readonly string[]> },
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
        else if (field.pattern && !new RegExp(field.pattern.source).test(s)) errors.push(field.pattern.message);
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
        {
          const dyn = context.dynamicOptions?.[field.key];
          // 公司维护了列表：只能选列表里的；记录原来的值不动也算合法（历史数据、已停用的项）
          const ok = dyn ? dyn.includes(String(raw)) || context.existing?.[field.key] === raw : field.options?.some((opt) => opt.value === raw);
          if (!ok) errors.push(`${label}的取值不合法`);
          else values[field.key] = raw;
        }
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
