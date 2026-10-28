import { normalizePhone, type FieldDef, type Option, type ResourceDef } from './resources';
import { archivePolicyOf } from './archive-policy';
import { unitYuanText, yuanToPreciseCents } from './unit-price';

/**
 * 资料页“表格编辑模式”的共用规则（前端网格和后端批量保存共用，只在这里定义一次）。
 * 网格只是换一种方式提交：每一行都走与单条新建/修改完全相同的服务端校验，这里只决定
 * “哪些资料、哪些字段适合在网格里改”，以及把单元格文本转换成字段值。
 */

/** 一次批量保存最多多少行（前端超出会分批提交） */
export const GRID_SAVE_MAX_ROWS = 200;

/**
 * 不适合网格编辑的资料：记录由系统/流程生成，或有专属面板（组合构成、成本事件、聚水潭同步等），
 * 在详情页里改。后端同样拒绝，不只是前端隐藏。
 */
const GRID_DISABLED: Record<string, string> = {
  'finance-bundles': '组合的构成、命名、验证、同步聚水潭走专属页面和专属接口，不能绕过它们直接改字段',
  'finance-bundle-lines': '组合构成行随组合的专属编辑页一起保存（会重算组合名称），不能单独批量改',
  'finance-bundle-revisions': '组合修订由系统生成，没有可手工修改的字段',
  'finance-base-code-lines': '基础编码的构成行随基础编码的专属表单保存（会重算编码名称），不能单独批量改',
  'finance-product-costs': '成本记录由成本流程生成，没有可手工修改的字段',
  'finance-product-freight-history': '运费历史由系统生成，没有可手工修改的字段',
  'finance-jst-skus': '聚水潭商品镜像由同步生成，没有可手工修改的字段',
  'finance-jst-uploads': '聚水潭上传记录由同步生成，没有可手工修改的字段',
  'finance-freight-estimates': '运费估算快照由系统生成，没有可手工修改的字段',
  'finance-zone-runs': '分区运行记录由系统生成，没有可手工修改的字段',
  'finance-express-recognitions': '快递识别记录由系统生成，没有可手工修改的字段',
};

/** 只能改、不能在网格里新增的资料（新增要走专属表单：编码规则、构成录入等） */
const GRID_NO_CREATE: Record<string, string> = {
  'finance-products': '商品档案的新增要选档案类型并生成编码，请用“＋ 新增”',
  'finance-base-codes': '基础编码的新增要填构成，请用“＋ 新增”',
};

export interface GridPolicy {
  enabled: boolean;
  canCreate: boolean;
  /** 能否把行归档（删除沿用归档语义，只有配置了归档的资料有） */
  canArchive: boolean;
  reason?: string;
}

export function gridPolicyOf(type: string): GridPolicy {
  const off = GRID_DISABLED[type];
  if (off) return { enabled: false, canCreate: false, canArchive: false, reason: off };
  return { enabled: true, canCreate: !GRID_NO_CREATE[type], canArchive: Boolean(archivePolicyOf(type)), reason: GRID_NO_CREATE[type] };
}

/**
 * 新增时可以填、保存后就不能在表格里改的字段（和详情表单一致，服务端也强制）：
 * 固定资产的“使用人”只能通过领用/归还流转改，不能直接改。
 */
const GRID_LOCKED_AFTER_CREATE: Record<string, Record<string, string>> = {
  'fixed-assets': { userId: '使用人要通过“领用/归还”流转修改' },
};
export function gridLockedAfterCreate(type: string, key: string): string | null {
  return GRID_LOCKED_AFTER_CREATE[type]?.[key] ?? null;
}

export type GridCellKind =
  | 'text' | 'textarea' | 'integer' | 'decimal' | 'money' | 'date' | 'monthday' | 'bool' | 'select' | 'phone' | 'ref'
  | 'refs' | 'files' | 'attrs' | 'json' | 'secret' | 'sensitive';

export type GridFieldAccess = { editable: true; kind: GridCellKind } | { editable: false; reason: string };

/**
 * 字段在网格里能不能改：标准 = 详情页/编辑表单里能改的字段，表格里都能改（同一份字段定义、同一套服务端校验）。
 * 只读的只有：系统计算（readonly）、没有字段权限/修改权限的字段。
 * 证件号/银行卡/密钥（sensitive/secret）需要“查看明文”(secret) 权限才能改；密码类永不回显，格子里只能输入新值。
 * 文件、多引用、属性、清单没法在一个格子里敲字，由单元格弹出的编辑浮层完成（见 web 的 CellEditor）。
 */
export function gridFieldAccess(field: FieldDef, can: (permission: string) => boolean, canSecret: boolean): GridFieldAccess {
  if (field.readonly) return { editable: false, reason: '系统计算，不能修改' };
  if (field.permission && !can(field.permission)) return { editable: false, reason: '没有查看权限' };
  if (field.writePermission && !can(field.writePermission)) return { editable: false, reason: '没有修改权限' };
  switch (field.type) {
    case 'text': return { editable: true, kind: 'text' };
    case 'textarea': return { editable: true, kind: 'textarea' };
    case 'number': return { editable: true, kind: 'integer' };
    case 'decimal': return { editable: true, kind: 'decimal' };
    case 'money': return { editable: true, kind: 'money' };
    case 'date': return { editable: true, kind: 'date' };
    case 'monthday': return { editable: true, kind: 'monthday' };
    case 'bool': return { editable: true, kind: 'bool' };
    case 'select': return { editable: true, kind: 'select' };
    case 'phone': return { editable: true, kind: 'phone' };
    case 'ref': return { editable: true, kind: 'ref' };
    case 'refs': return { editable: true, kind: 'refs' };
    case 'files': return { editable: true, kind: 'files' };
    case 'attrs': return { editable: true, kind: 'attrs' };
    case 'json': return { editable: true, kind: 'json' };
    case 'secret':
    case 'sensitive':
      return canSecret ? { editable: true, kind: field.type } : { editable: false, reason: '需要“查看明文”权限才能修改' };
  }
}

/** 状态列：和详情页的状态下拉同一规则——要有“停用”权限；归档的资料不能改；只有一个状态的资料没有可改的 */
export function gridStatusAccess(def: ResourceDef, canDisable: boolean): GridFieldAccess {
  if (def.statuses.length < 2) return { editable: false, reason: '这类资料只有一个状态' };
  if (!canDisable) return { editable: false, reason: '没有改状态（停用/启用）的权限' };
  return { editable: true, kind: 'select' };
}

export type CellParse = { ok: true; value: unknown } | { ok: false; error: string };

const EMPTY: CellParse = { ok: true, value: null };

/** 日期：接受 2024-3-5 / 2024/03/05 / 2024.3.5 / 2024年3月5日，统一成 YYYY-MM-DD */
export function normalizeDateText(text: string): string | null {
  const m = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const TRUE_WORDS = new Set(['是', 'true', '1', 'y', 'yes', '√', '✓', '✔']);
const FALSE_WORDS = new Set(['否', 'false', '0', 'n', 'no', '×', '✗']);

/**
 * 把单元格里输入/粘贴的文本转成字段值（空文本 = 清空，值为 null）。
 * 金额按“元”输入、存整数分（单价类字段 scale>0 时最多保留到万分之一分），走 unit-price 的定点运算，不经过浮点乘 100。
 * 引用（ref）要靠名称找记录，由调用方解析，这里不处理。选项传入当前允许的选项（含公司维护的动态选项）。
 */
export function parseGridCell(field: FieldDef, kind: GridCellKind, raw: string, options?: readonly Option[]): CellParse {
  const text = raw.replace(/ /g, ' ').trim();
  if (text === '') return EMPTY;
  const label = field.label;
  switch (kind) {
    case 'text':
    case 'textarea':
    case 'secret':
    case 'sensitive': {
      if (text.length > (field.maxLength ?? 200)) return { ok: false, error: `${label}不能超过 ${field.maxLength ?? 200} 个字` };
      if (field.pattern && !new RegExp(field.pattern.source).test(text)) return { ok: false, error: field.pattern.message };
      return { ok: true, value: text };
    }
    case 'integer': {
      if (!/^\d+$/.test(text.replace(/,/g, ''))) return { ok: false, error: `${label}必须是非负整数` };
      const n = Number(text.replace(/,/g, ''));
      if (n > 2_000_000_000) return { ok: false, error: `${label}必须是非负整数` };
      return { ok: true, value: n };
    }
    case 'decimal': {
      const s = text.replace(/,/g, '');
      const scale = field.scale ?? 4;
      const n = Number(s);
      if (!/^\d*\.?\d+$/.test(s) || !Number.isFinite(n) || n > 1_000_000_000 || Math.round(n * 10 ** scale) / 10 ** scale !== n) return { ok: false, error: `${label}必须是不超过 ${scale} 位小数的非负数` };
      return { ok: true, value: n };
    }
    case 'money': {
      const s = text.replace(/[¥￥,\s]/g, '').replace(/^\./, '0.');
      try {
        if (!/^\d+(\.\d*)?$/.test(s)) throw new Error('bad');
        return { ok: true, value: yuanToPreciseCents(s, field.scale ?? 0) };
      } catch {
        return { ok: false, error: field.scale ? `${label}精度不合法（最多 ${2 + field.scale} 位元小数）` : `${label}请填写元，最多两位小数` };
      }
    }
    case 'date': {
      const d = normalizeDateText(text);
      return d ? { ok: true, value: d } : { ok: false, error: `${label}日期格式应为 YYYY-MM-DD` };
    }
    case 'monthday': {
      const m = /^(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(text);
      if (!m) return { ok: false, error: `${label}格式应为 MM-DD` };
      const out = `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      return /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(out) ? { ok: true, value: out } : { ok: false, error: `${label}格式应为 MM-DD` };
    }
    case 'phone': {
      const digits = normalizePhone(text);
      return digits.length >= 7 && digits.length <= 15 ? { ok: true, value: digits } : { ok: false, error: `${label}格式不对` };
    }
    case 'bool': {
      const w = text.toLowerCase();
      if (TRUE_WORDS.has(w)) return { ok: true, value: true };
      if (FALSE_WORDS.has(w)) return { ok: true, value: false };
      return { ok: false, error: `${label}请填“是”或“否”` };
    }
    case 'select': {
      const opts = options ?? field.options ?? [];
      const find = (t: string) => opts.find((o) => o.value === t) ?? opts.find((o) => o.label === t);
      if (field.multi) {
        const picked = text.split(/[、,，;；]/).map((x) => x.trim()).filter(Boolean).map(find);
        if (picked.some((x) => !x)) return { ok: false, error: `${label}的取值不合法` };
        const set = new Set(picked.map((x) => x!.value));
        return { ok: true, value: opts.map((o) => o.value).filter((v) => set.has(v)).join('、') };
      }
      const hit = find(text);
      return hit ? { ok: true, value: hit.value } : { ok: false, error: `${label}的取值不合法` };
    }
    case 'attrs': {
      const obj = parseAttrsText(text);
      if (!obj) return { ok: false, error: `${label}格式应为“名称：内容；名称：内容”` };
      const keys = Object.keys(obj);
      if (keys.length > 30) return { ok: false, error: `${label}最多 30 项` };
      for (const k of keys) if (k.length > 40 || obj[k].length > 200) return { ok: false, error: `${label}里「${k.slice(0, 10)}」太长` };
      return { ok: true, value: obj };
    }
    case 'json': {
      try {
        const v = JSON.parse(text) as unknown;
        if (typeof v !== 'object' || v === null) throw new Error('bad');
        if (JSON.stringify(v).length > 200_000) return { ok: false, error: `${label}内容太大` };
        return { ok: true, value: v };
      } catch {
        return { ok: false, error: `${label}不是合法的 JSON（应为 {…} 或 […]）` };
      }
    }
    case 'files':
    case 'refs':
      return { ok: false, error: `${label}请在格子的编辑浮层里选择` };
    default:
      return { ok: false, error: `${label}的内容不合法` };
  }
}

/** 属性文本：JSON 对象，或“名称：内容；名称：内容”（换行也可分隔）。空内容的名称丢掉，和服务端一致 */
export function parseAttrsText(text: string): Record<string, string> | null {
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as unknown;
      if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) { const x = String(v ?? '').trim(); if (x) out[k] = x; }
      return out;
    } catch { return null; }
  }
  const out: Record<string, string> = {};
  for (const part of t.split(/[;；\n]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^:：]+)[:：](.*)$/.exec(part);
    if (!m) return null;
    const v = m[2].trim();
    if (v) out[m[1].trim()] = v;
  }
  return out;
}

/** 字段值 → 单元格文本（复制、编辑初始值用）：金额按元，选项按名称；引用名称由调用方给 */
export function formatGridCell(field: FieldDef, kind: GridCellKind, value: unknown, options?: readonly Option[]): string {
  if (value === undefined || value === null || value === '') return '';
  switch (kind) {
    case 'money':
      return unitYuanText(Number(value)).replace(/^(\d+)$/, '$1');
    case 'bool':
      return value === true || value === 'true' ? '是' : '否';
    case 'select': {
      const opts = options ?? field.options ?? [];
      if (field.multi) return String(value).split('、').filter(Boolean).map((v) => opts.find((o) => o.value === v)?.label ?? v).join('、');
      return opts.find((o) => o.value === value)?.label ?? String(value);
    }
    case 'attrs':
      return typeof value === 'object' && value ? Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}：${String(v)}`).join('；') : '';
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'files':
      return Array.isArray(value) && value.length ? `${value.length} 个文件` : '';
    case 'refs':
      return '';
    default:
      return String(value);
  }
}

// ---------- 批量保存接口的请求/响应 ----------

export interface GridUpdateRow {
  id: number;
  /** 打开表格时这一行的版本（列表返回的 version）；别人改过就返回冲突 */
  version?: string;
  /** 只含被改动的字段 */
  data: Record<string, unknown>;
  /** 同时改状态（走与详情页状态下拉相同的规则：要“停用”权限，需要原因的状态必须带原因） */
  status?: string;
  statusReason?: string;
}

export interface GridCreateRow {
  /** 前端给的临时编号，原样回传，用来对上结果 */
  clientId: string;
  data: Record<string, unknown>;
}

export interface GridArchiveRow {
  id: number;
  version?: string;
  reason: string;
}

export interface GridSaveRequest {
  updates?: GridUpdateRow[];
  creates?: GridCreateRow[];
  /** 待删除行：沿用归档语义（要原因，可恢复），没有归档配置的资料不支持 */
  archives?: GridArchiveRow[];
}

export type GridFailCode = 'invalid' | 'conflict' | 'forbidden' | 'not_found' | 'error';

export interface GridRowResult<Row = unknown> {
  kind: 'update' | 'create' | 'archive';
  id?: number;
  clientId?: string;
  ok: boolean;
  code?: GridFailCode;
  message?: string;
  /** 保存成功后的最新记录（与列表同形） */
  row?: Row;
}

export interface GridSaveResponse<Row = unknown> {
  results: GridRowResult<Row>[];
  saved: number;
  failed: number;
}

export type { ResourceDef };
