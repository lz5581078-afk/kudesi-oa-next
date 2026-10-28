import { addDaysText } from './expiry';
import type { FieldDef, FieldType } from './resources';

/**
 * 表格列筛选：一套定义，前端筛选浮层和后端 GET /api/resources/:type 的 colFilters 参数共用。
 * 每种字段类型允许哪些操作符、值怎么校验，都只在这里写一次。
 */

export type ColFilterKind = 'text' | 'phone' | 'number' | 'date' | 'monthday' | 'select' | 'bool' | 'ref' | 'presence' | 'status';

export type ColFilterOp =
  | 'contains' | 'eq' | 'neq' | 'startsWith'
  | 'gt' | 'lt' | 'between'
  | 'before' | 'after'
  | 'in'
  | 'yes' | 'no'
  | 'empty' | 'notEmpty';

export interface ColFilter {
  /** 字段 key；状态列用 $status */
  key: string;
  op: ColFilterOp;
  /** 文本 / 数字 / 日期的值；区间的起点 */
  value?: string;
  /** 区间的终点 */
  value2?: string;
  /** 多选值（选项值 / 引用 id / 状态值） */
  values?: string[];
}

export const STATUS_COL = '$status';
export const COL_FILTER_MAX = 12;
export const COL_FILTER_PER_COLUMN_MAX = 3;
export const COL_FILTER_VALUES_MAX = 50;
export const COL_FILTER_TEXT_MAX = 100;

/** 每种列类型允许的操作符（顺序即界面里的显示顺序） */
export const COL_FILTER_OPS: Record<ColFilterKind, readonly ColFilterOp[]> = {
  text: ['contains', 'eq', 'neq', 'startsWith', 'empty', 'notEmpty'],
  phone: ['contains', 'eq', 'startsWith', 'empty', 'notEmpty'],
  number: ['eq', 'gt', 'lt', 'between', 'empty', 'notEmpty'],
  date: ['between', 'eq', 'before', 'after', 'empty', 'notEmpty'],
  monthday: ['eq', 'empty', 'notEmpty'],
  select: ['in', 'empty', 'notEmpty'],
  bool: ['yes', 'no'],
  ref: ['in', 'empty', 'notEmpty'],
  // 加密存放的证件号/银行卡/密钥、文件：不比较内容，只能看“已填 / 未填”，没法通过筛选猜出明文
  presence: ['notEmpty', 'empty'],
  status: ['in'],
};

export const COL_FILTER_OP_LABEL: Record<ColFilterOp, string> = {
  contains: '包含', eq: '等于', neq: '不等于', startsWith: '开头是',
  gt: '大于', lt: '小于', between: '区间', before: '早于', after: '晚于',
  in: '是其中之一', yes: '是', no: '否', empty: '为空', notEmpty: '不为空',
};

/** 字段类型 → 列筛选类型；null = 这种字段不提供列筛选（清单、属性、派生统计列等） */
export function colFilterKindOf(type: FieldType): ColFilterKind | null {
  switch (type) {
    case 'text': case 'textarea': return 'text';
    case 'phone': return 'phone';
    case 'number': case 'decimal': case 'money': return 'number';
    case 'date': return 'date';
    case 'monthday': return 'monthday';
    case 'select': return 'select';
    case 'bool': return 'bool';
    case 'ref': case 'refs': return 'ref';
    case 'sensitive': case 'secret': case 'files': return 'presence';
    default: return null;
  }
}

/**
 * 读列表时才算出来、并没有存进记录里的字段（手机号的绑定店铺 / 主子卡，店铺的资金余额等）：
 * 数据库里没有这个值，没法在服务端筛选，所以列头不给入口，传来也拒绝。
 */
export const READ_TIME_FIELDS: Readonly<Record<string, readonly string[]>> = {
  phones: ['cardKind', 'boundStores', 'boundStoreNos'],
  stores: ['deposit', 'frozen', 'goodsFund', 'promotionBalance'],
  // 银行账户的当前余额 = 期初余额 + 现金银行已过账流水；公户详情是否维护过：都是读时现算
  'bank-accounts': ['currentBalance', 'publicInfoFlag'],
  // 兼职与临时工：合作状态按日期实时算，账号/部门/岗位/上级/登录时间取自员工当前资料
  workforce: ['cooperation', 'account', 'departmentName', 'positionName', 'managerName', 'accountStatus', 'lastLoginAt'],
};
export const readTimeKeys = (resourceKey: string): ReadonlySet<string> => new Set(READ_TIME_FIELDS[resourceKey] ?? []);

/** 这一列是否能筛选：字段自身类型支持，且当前用户看得见（没有字段权限的列不出现筛选入口，服务端同样拒绝） */
export function colFilterKindFor(field: FieldDef, restricted: ReadonlySet<string>, computed: ReadonlySet<string> = new Set()): ColFilterKind | null {
  if (restricted.has(field.key) || computed.has(field.key)) return null;
  return colFilterKindOf(field.type);
}

export type ColFilterCheck = { ok: true; filters: ColFilter[] } | { ok: false; error: string };

const NUM = /^-?\d{1,18}(\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHDAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function validDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkValues(kind: ColFilterKind, f: ColFilter, statuses?: ReadonlySet<string>): string | null {
  const needText = () => { const v = (f.value ?? '').trim(); return v.length >= 1 && v.length <= COL_FILTER_TEXT_MAX; };
  switch (f.op) {
    case 'empty': case 'notEmpty': case 'yes': case 'no':
      return f.value !== undefined || f.value2 !== undefined || f.values !== undefined ? '这个筛选方式不需要填写值' : null;
    case 'contains': case 'eq': case 'neq': case 'startsWith': case 'gt': case 'lt': case 'before': case 'after': case 'between': break;
    case 'in': {
      if (!Array.isArray(f.values) || f.values.length < 1 || f.values.length > COL_FILTER_VALUES_MAX) return `请选择 1~${COL_FILTER_VALUES_MAX} 个值`;
      if (f.value !== undefined || f.value2 !== undefined) return '筛选值不合法';
      for (const v of f.values) {
        if (typeof v !== 'string' || v.length < 1 || v.length > 64) return '筛选值不合法';
        if (kind === 'ref' && !/^[1-9]\d{0,9}$/.test(v)) return '引用筛选值必须是编号';
        if (kind === 'status' && statuses && !statuses.has(v)) return '状态不合法';
      }
      return null;
    }
  }
  if (f.values !== undefined) return '筛选值不合法';
  if (f.op !== 'between' && f.value2 !== undefined) return '筛选值不合法';
  if (kind === 'text' || kind === 'phone') {
    if (typeof f.value !== 'string' || !needText()) return `请填写 1~${COL_FILTER_TEXT_MAX} 个字的筛选内容`;
    if (kind === 'phone' && !/\d/.test(f.value)) return '手机号筛选请填写数字';
    if (kind === 'phone' && !/^[\d\s+\-]{1,30}$/.test(f.value)) return '手机号筛选只能填数字';
    return null;
  }
  if (kind === 'number') {
    if (typeof f.value !== 'string' || !NUM.test(f.value)) return '请填写数字';
    if (f.op === 'between') {
      if (typeof f.value2 !== 'string' || !NUM.test(f.value2)) return '请填写区间的两端';
      if (Number(f.value) > Number(f.value2)) return '区间的起点不能大于终点';
    }
    return null;
  }
  if (kind === 'date') {
    if (typeof f.value !== 'string' || !validDate(f.value)) return '日期格式应为 YYYY-MM-DD';
    if (f.op === 'between') {
      if (typeof f.value2 !== 'string' || !validDate(f.value2)) return '请填写区间的两端日期';
      if (f.value > f.value2) return '区间的起点不能晚于终点';
    }
    return null;
  }
  if (kind === 'monthday') return typeof f.value === 'string' && MONTHDAY.test(f.value) ? null : '格式应为 MM-DD';
  return '筛选值不合法';
}

/**
 * 校验并规整列筛选条件（前后端同一份）：
 * 字段必须属于资料定义且当前用户看得见，操作符必须在该字段类型的允许集合里，值的类型/长度合法，条件数有上限。
 * 只保留白名单字段 key / op / value / value2 / values，别的属性一概拒绝。
 */
export function validateColFilters(raw: unknown, ctx: { fields: readonly FieldDef[]; restricted?: ReadonlySet<string>; computed?: ReadonlySet<string>; statuses?: readonly string[]; allowedKeys?: ReadonlySet<string> }): ColFilterCheck {
  if (!Array.isArray(raw)) return { ok: false, error: '列筛选条件不合法' };
  if (raw.length > COL_FILTER_MAX) return { ok: false, error: `列筛选最多 ${COL_FILTER_MAX} 个条件` };
  const restricted = ctx.restricted ?? new Set<string>();
  const statusSet = ctx.statuses ? new Set(ctx.statuses) : undefined;
  const out: ColFilter[] = [];
  const perKey = new Map<string, number>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: '列筛选条件不合法' };
    const o = item as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!['key', 'op', 'value', 'value2', 'values'].includes(k)) return { ok: false, error: `列筛选条件含有不支持的内容：${k.slice(0, 20)}` };
    if (typeof o.key !== 'string' || typeof o.op !== 'string') return { ok: false, error: '列筛选条件不合法' };
    let kind: ColFilterKind | null;
    if (o.key === STATUS_COL) kind = 'status';
    else {
      const field = ctx.fields.find((x) => x.key === o.key);
      if (!field) return { ok: false, error: '列筛选的字段不存在' };
      if (restricted.has(field.key) || (ctx.allowedKeys && !ctx.allowedKeys.has(field.key))) return { ok: false, error: `没有权限按“${field.label}”筛选` };
      if (ctx.computed?.has(field.key)) return { ok: false, error: `“${field.label}”是系统算出来的，不支持列筛选` };
      kind = colFilterKindOf(field.type);
      if (!kind) return { ok: false, error: `“${field.label}”不支持列筛选` };
    }
    if (!(COL_FILTER_OPS[kind] as readonly string[]).includes(o.op)) return { ok: false, error: '这一列不支持这种筛选方式' };
    const f: ColFilter = { key: o.key, op: o.op as ColFilterOp };
    if (o.value !== undefined) { if (typeof o.value !== 'string') return { ok: false, error: '筛选值不合法' }; f.value = o.value; }
    if (o.value2 !== undefined) { if (typeof o.value2 !== 'string') return { ok: false, error: '筛选值不合法' }; f.value2 = o.value2; }
    if (o.values !== undefined) { if (!Array.isArray(o.values)) return { ok: false, error: '筛选值不合法' }; f.values = o.values as string[]; }
    const err = checkValues(kind, f, statusSet);
    if (err) return { ok: false, error: err };
    if (f.value !== undefined && (kind === 'text' || kind === 'phone')) f.value = f.value.trim();
    const n = (perKey.get(f.key) ?? 0) + 1;
    if (n > COL_FILTER_PER_COLUMN_MAX) return { ok: false, error: `同一列最多 ${COL_FILTER_PER_COLUMN_MAX} 个条件` };
    perKey.set(f.key, n);
    out.push(f);
  }
  return { ok: true, filters: out };
}

/** 解析 colFilters 参数（JSON 文本）再校验；空串 = 没有条件 */
export function parseColFilters(text: string | undefined, ctx: Parameters<typeof validateColFilters>[1]): ColFilterCheck {
  if (!text) return { ok: true, filters: [] };
  if (text.length > 6000) return { ok: false, error: '列筛选条件太长' };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: '列筛选条件不合法' }; }
  return validateColFilters(raw, ctx);
}

export type DatePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'thisYear';
export const DATE_PRESETS: ReadonlyArray<{ value: DatePreset; label: string }> = [
  { value: 'today', label: '今天' }, { value: 'yesterday', label: '昨天' }, { value: 'last7', label: '近 7 天' }, { value: 'last30', label: '近 30 天' },
  { value: 'thisMonth', label: '本月' }, { value: 'lastMonth', label: '上月' }, { value: 'thisYear', label: '今年' },
];

/** 日期快捷项 → 区间（含两端）；today 用 YYYY-MM-DD（东八区今天） */
export function datePresetRange(preset: DatePreset, today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const monthEnd = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const d = addDaysText(today, -1); return { from: d, to: d }; }
    case 'last7': return { from: addDaysText(today, -6), to: today };
    case 'last30': return { from: addDaysText(today, -29), to: today };
    case 'thisMonth': return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(monthEnd(y, m))}` };
    case 'lastMonth': { const yy = m === 1 ? y - 1 : y; const mm = m === 1 ? 12 : m - 1; return { from: `${yy}-${pad(mm)}-01`, to: `${yy}-${pad(mm)}-${pad(monthEnd(yy, mm))}` }; }
    case 'thisYear': return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
}

/** 标签条上显示的一句话；optionLabel 把选项值/引用编号换成名称 */
export function describeColFilter(f: ColFilter, label: string, optionLabel: (v: string) => string = (v) => v): string {
  const opText = COL_FILTER_OP_LABEL[f.op];
  switch (f.op) {
    case 'empty': case 'notEmpty': return `${label} ${opText}`;
    case 'yes': case 'no': return `${label}：${opText}`;
    case 'between': return `${label}：${f.value} ~ ${f.value2}`;
    case 'in': {
      const names = (f.values ?? []).map(optionLabel);
      return `${label}：${names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 项` : names.join('、')}`;
    }
    default: return `${label} ${opText} ${f.value ?? ''}`;
  }
}
