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
  'finance-bundles': '组合有构成、命名、验证和聚水潭同步等专属面板，请在详情页编辑',
  'finance-bundle-lines': '组合构成行请在组合详情里编辑',
  'finance-bundle-revisions': '组合修订由系统生成',
  'finance-base-code-lines': '基础编码的构成行请在详情里编辑',
  'finance-product-boms': '商品构成请在商品详情里编辑',
  'finance-product-sources': '商品来源请在商品详情里编辑',
  'finance-product-costs': '成本记录由成本流程生成',
  'finance-product-freight-history': '运费历史由系统生成',
  'finance-product-exclusives': '专属归属走流程申请',
  'finance-jst-skus': '聚水潭商品由同步生成',
  'finance-jst-uploads': '聚水潭上传记录由同步生成',
  'finance-freight-estimates': '运费估算由系统生成',
  'finance-zone-runs': '分区运行记录由系统生成',
  'finance-express-recognitions': '快递识别记录由系统生成',
  'finance-express-fee-batches': '快递费用批次由导入生成',
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

export type GridCellKind = 'text' | 'integer' | 'decimal' | 'money' | 'date' | 'monthday' | 'bool' | 'select' | 'phone' | 'ref' | 'secret' | 'sensitive';

export type GridFieldAccess = { editable: true; kind: GridCellKind } | { editable: false; reason: string };

/**
 * 字段在网格里能不能改。
 * - 系统计算（readonly）、文件/属性/清单/多选引用：只读，去详情页改
 * - 没有字段权限（成本价格）：服务端本来就不返回，这里也当只读
 * - 证件号/银行卡/密钥：只有有“查看明文”(secret) 权限的人才能改；密码类永不回显，网格里只能输入新值
 */
export function gridFieldAccess(field: FieldDef, can: (permission: string) => boolean, canSecret: boolean): GridFieldAccess {
  if (field.readonly) return { editable: false, reason: '系统计算，不能修改' };
  if (field.permission && !can(field.permission)) return { editable: false, reason: '没有查看权限' };
  if (field.writePermission && !can(field.writePermission)) return { editable: false, reason: '没有修改权限' };
  switch (field.type) {
    case 'text':
    case 'textarea':
      return { editable: true, kind: 'text' };
    case 'number':
      return { editable: true, kind: 'integer' };
    case 'decimal':
      return { editable: true, kind: 'decimal' };
    case 'money':
      return { editable: true, kind: 'money' };
    case 'date':
      return { editable: true, kind: 'date' };
    case 'monthday':
      return { editable: true, kind: 'monthday' };
    case 'bool':
      return { editable: true, kind: 'bool' };
    case 'select':
      return { editable: true, kind: 'select' };
    case 'phone':
      return { editable: true, kind: 'phone' };
    case 'ref':
      return { editable: true, kind: 'ref' };
    case 'secret':
    case 'sensitive':
      return canSecret ? { editable: true, kind: field.type } : { editable: false, reason: '需要“查看明文”权限才能修改' };
    default:
      return { editable: false, reason: '请在详情页编辑' };
  }
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
    default:
      return { ok: false, error: `${label}请在详情页编辑` };
  }
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
