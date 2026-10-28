import {
  formatGridCell,
  gridFieldAccess,
  parseGridCell,
  type FieldDef,
  type GridCellKind,
  type GridCreateRow,
  type GridSaveRequest,
  type GridSaveResponse,
  type GridUpdateRow,
  type Option,
  type ResourceDef,
} from '@kudesi/shared';
import type { ResourceDto } from '../api';
import type { RefChoice } from './refResolve';

/** 网格的纯逻辑（无界面）：列、行、改动、撤销、粘贴、向下填充、保存请求与结果合并。界面在 ResourceGrid.tsx。 */

export interface GridCol {
  key: string;
  label: string;
  field: FieldDef | null; // null = 状态列
  kind: GridCellKind | null;
  editable: boolean;
  reason?: string;
}

export function buildColumns(def: ResourceDef, fields: readonly FieldDef[], can: (p: string) => boolean, canSecret: boolean): GridCol[] {
  const cols: GridCol[] = fields.map((f) => {
    const derived = !def.fields.some((x) => x.key === f.key);
    const a = derived ? ({ editable: false, reason: '统计数字，不能修改' } as const) : gridFieldAccess(f, can, canSecret);
    return { key: f.key, label: f.label, field: f, kind: a.editable ? a.kind : null, editable: a.editable, reason: a.editable ? undefined : a.reason };
  });
  cols.push({ key: '$status', label: '状态', field: null, kind: null, editable: false, reason: '状态请在详情页或批量栏修改（停用要填原因）' });
  return cols;
}

export interface CellInvalid { raw: string; error: string }

export interface GridRow {
  /** 已有记录是 id 字符串，新增行是 new-N */
  key: string;
  id?: number;
  version?: string;
  isNew: boolean;
  title: string;
  status: string;
  base: Record<string, unknown>;
  data: Record<string, unknown>;
  refLabels: Record<string, string>;
  secretConfigured: Record<string, boolean>;
  invalid: Record<string, CellInvalid>;
  deleted: boolean;
  error?: { code: string; message: string };
}

export function rowFromDto(dto: ResourceDto): GridRow {
  return {
    key: String(dto.id), id: dto.id, version: dto.version, isNew: false, title: dto.title, status: dto.status,
    base: { ...dto.data }, data: { ...dto.data }, refLabels: { ...dto.refLabels }, secretConfigured: { ...dto.secretConfigured },
    invalid: {}, deleted: false,
  };
}

export function newRow(seq: number, defaults: Record<string, unknown> = {}, labels: Record<string, string> = {}): GridRow {
  return { key: `new-${seq}`, isNew: true, title: '', status: '', base: {}, data: { ...defaults }, refLabels: { ...labels }, secretConfigured: {}, invalid: {}, deleted: false };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** 该单元格被改过（含填了格式不对的内容） */
export function isChanged(row: GridRow, col: GridCol): boolean {
  if (row.invalid[col.key]) return true;
  if (col.field?.type === 'secret') return !empty(row.data[col.key]);
  if (row.isNew) return !empty(row.data[col.key]);
  return !same(empty(row.data[col.key]) ? null : row.data[col.key], empty(row.base[col.key]) ? null : row.base[col.key]);
}

/** 新增行里什么都没填，不算一行 */
export function isBlankNew(row: GridRow, cols: GridCol[], defaults: Record<string, unknown> = {}): boolean {
  return row.isNew && cols.every((c) => !row.invalid[c.key] && (empty(row.data[c.key]) || same(row.data[c.key], defaults[c.key])));
}

/** showWhen 不满足的字段，这一行不显示也不能改 */
export function applicable(row: GridRow, col: GridCol): boolean {
  const sw = col.field?.showWhen;
  if (!sw) return true;
  const cur = sw.field === 'status' ? row.status : String(row.data[sw.field] ?? '');
  return sw.in.includes(cur);
}

export function summarize(rows: GridRow[], cols: GridCol[], defaults: Record<string, unknown> = {}) {
  let cells = 0, created = 0, deleted = 0, invalid = 0, errors = 0;
  for (const r of rows) {
    if (r.error) errors++;
    if (r.deleted) { if (!r.isNew) deleted++; continue; }
    if (r.isNew) { if (!isBlankNew(r, cols, defaults)) created++; }
    else cells += cols.filter((c) => c.field && isChanged(r, c) && !r.invalid[c.key]).length;
    invalid += Object.keys(r.invalid).length;
  }
  return { cells, created, deleted, invalid, errors, total: cells + created + deleted + invalid };
}

export interface CellChange {
  row: number; // 在当前行数组里的位置；等于行数 = 底部空行（新增）
  key: string;
  value?: unknown;
  label?: string;
  invalid?: CellInvalid;
}

/** 应用一批单元格改动；越过末尾的行号表示新增行。返回新数组（行对象不可变） */
export function applyChanges(rows: GridRow[], cols: GridCol[], changes: CellChange[], seq: { n: number }, defaults: Record<string, unknown> = {}, defaultLabels: Record<string, string> = {}): GridRow[] {
  const out = rows.slice();
  for (const ch of changes) {
    while (ch.row >= out.length) out.push(newRow(++seq.n, defaults, defaultLabels));
    const row = out[ch.row];
    const col = cols.find((c) => c.key === ch.key);
    if (!col?.editable || row.deleted || !applicable(row, col)) continue;
    const data = { ...row.data };
    const labels = { ...row.refLabels };
    const invalid = { ...row.invalid };
    if (ch.invalid) invalid[ch.key] = ch.invalid;
    else {
      delete invalid[ch.key];
      if (ch.value === null || ch.value === undefined) { delete data[ch.key]; delete labels[ch.key]; }
      else { data[ch.key] = ch.value; if (ch.label !== undefined) labels[ch.key] = ch.label; }
    }
    // 改了会让别的字段不再适用（showWhen）：那些字段清空，和服务端一致
    for (const c of cols) if (c.field?.showWhen && c.field.showWhen.field === ch.key && !applicable({ ...row, data }, c)) { delete data[c.key]; delete invalid[c.key]; }
    out[ch.row] = { ...row, data, refLabels: labels, invalid, error: undefined };
  }
  return out;
}

export interface Selection { r1: number; c1: number; r2: number; c2: number }
export const normSel = (a: { r: number; c: number }, f: { r: number; c: number }): Selection => ({ r1: Math.min(a.r, f.r), r2: Math.max(a.r, f.r), c1: Math.min(a.c, f.c), c2: Math.max(a.c, f.c) });

/** 取单元格的文本（复制、编辑初始值）。密码类永不复制。 */
export function cellEditText(col: GridCol, row: GridRow, options?: readonly Option[]): string {
  if (!col.field || !col.kind || col.kind === 'secret') return '';
  const inv = row.invalid[col.key];
  if (inv) return inv.raw;
  if (col.kind === 'ref') return row.refLabels[col.key] ?? '';
  return formatGridCell(col.field, col.kind, row.data[col.key], options);
}

export interface TextCtx {
  options?: (field: FieldDef, row: GridRow) => readonly Option[] | undefined;
  resolveRef?: (field: FieldDef, text: string) => Promise<RefChoice | null>;
}

/** 文本 → 单元格改动（粘贴、键入、填充共用）。格式不对的不丢，标红留在格子里等人修改 */
export async function textToChange(col: GridCol, row: GridRow, rowIndex: number, text: string, ctx: TextCtx): Promise<CellChange> {
  const field = col.field!;
  const base: CellChange = { row: rowIndex, key: col.key };
  if (col.kind === 'ref') {
    if (text.trim() === '') return { ...base, value: null };
    const hit = await ctx.resolveRef?.(field, text);
    return hit ? { ...base, value: hit.id, label: hit.label } : { ...base, invalid: { raw: text, error: `${field.label}里找不到「${text.trim()}」，请从下拉里选` } };
  }
  const r = parseGridCell(field, col.kind!, text, ctx.options?.(field, row));
  if (r.ok) return { ...base, value: r.value };
  return { ...base, invalid: { raw: text, error: r.error } };
}

/** 向下填充：把 source 行的值抄到下面的行（多行源按顺序循环），选区外的列不动 */
export function fillChanges(rows: GridRow[], cols: GridCol[], sel: Selection, toRow: number): CellChange[] {
  const out: CellChange[] = [];
  const height = sel.r2 - sel.r1 + 1;
  for (let r = sel.r2 + 1; r <= toRow; r++) {
    const src = rows[sel.r1 + ((r - sel.r2 - 1) % height)];
    if (!src) continue;
    for (let c = sel.c1; c <= sel.c2; c++) out.push(copyCell(cols[c], src, r));
  }
  return out;
}

/** Ctrl+D：选区第一行向下填满选区 */
export function fillDownChanges(rows: GridRow[], cols: GridCol[], sel: Selection): CellChange[] {
  const src = rows[sel.r1];
  if (!src) return [];
  const out: CellChange[] = [];
  for (let r = sel.r1 + 1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) out.push(copyCell(cols[c], src, r));
  return out;
}

function copyCell(col: GridCol, src: GridRow, row: number): CellChange {
  if (src.invalid[col.key]) return { row, key: col.key, invalid: src.invalid[col.key] };
  if (col.kind === 'secret') return { row, key: col.key, value: src.data[col.key] ?? null };
  return { row, key: col.key, value: src.data[col.key] ?? null, label: src.refLabels[col.key] };
}

// ---------- 保存 ----------

export function buildRequest(rows: GridRow[], cols: GridCol[], archiveReason: string, defaults: Record<string, unknown> = {}): GridSaveRequest {
  const updates: GridUpdateRow[] = [];
  const creates: GridCreateRow[] = [];
  const archives: NonNullable<GridSaveRequest['archives']> = [];
  for (const r of rows) {
    if (r.deleted) {
      if (!r.isNew && r.id !== undefined) archives.push({ id: r.id, version: r.version, reason: archiveReason });
      continue;
    }
    if (r.isNew) {
      if (isBlankNew(r, cols, defaults)) continue;
      const data: Record<string, unknown> = {};
      for (const c of cols) if (c.field && c.editable && !empty(r.data[c.key])) data[c.key] = r.data[c.key];
      creates.push({ clientId: r.key, data });
      continue;
    }
    const data: Record<string, unknown> = {};
    for (const c of cols) if (c.field && c.editable && isChanged(r, c)) data[c.key] = empty(r.data[c.key]) ? null : r.data[c.key];
    if (Object.keys(data).length && r.id !== undefined) updates.push({ id: r.id, version: r.version, data });
  }
  return { updates, creates, archives };
}

/** 把一次保存的结果合并回表格：成功的用服务端最新记录替换（并清掉改动标记），失败的留着标红 */
export function applyResponse(rows: GridRow[], res: GridSaveResponse<ResourceDto>): GridRow[] {
  const byKey = new Map(rows.map((r) => [r.key, r] as const));
  const out = new Map(byKey);
  for (const x of res.results) {
    const key = x.kind === 'create' ? x.clientId! : String(x.id);
    const cur = byKey.get(key);
    if (!cur) continue;
    if (x.ok) {
      if (x.kind === 'archive') out.delete(key);
      else if (x.row) out.set(key, { ...rowFromDto(x.row), key });
      else out.set(key, { ...cur, error: undefined });
    } else {
      out.set(key, { ...cur, error: { code: x.code ?? 'error', message: x.message ?? '保存失败' } });
    }
  }
  return rows.filter((r) => out.has(r.key)).map((r) => out.get(r.key)!);
}

/** 请求里的行太多时分批（服务端一次最多 N 行） */
export function chunkRequest(req: GridSaveRequest, size: number): GridSaveRequest[] {
  const flat: Array<['updates' | 'creates' | 'archives', unknown]> = [
    ...(req.updates ?? []).map((x) => ['updates', x] as ['updates', unknown]),
    ...(req.creates ?? []).map((x) => ['creates', x] as ['creates', unknown]),
    ...(req.archives ?? []).map((x) => ['archives', x] as ['archives', unknown]),
  ];
  const out: GridSaveRequest[] = [];
  for (let i = 0; i < flat.length; i += size) {
    const part: GridSaveRequest = {};
    for (const [k, v] of flat.slice(i, i + size)) ((part[k] ??= []) as unknown[]).push(v);
    out.push(part);
  }
  return out;
}

// ---------- 撤销/重做（只在未保存的改动里） ----------

export interface History { rows: GridRow[]; past: GridRow[][]; future: GridRow[][] }
const LIMIT = 100;

export const historyInit = (rows: GridRow[]): History => ({ rows, past: [], future: [] });
export const historyPush = (h: History, rows: GridRow[]): History => (rows === h.rows ? h : { rows, past: [...h.past, h.rows].slice(-LIMIT), future: [] });
export const historyUndo = (h: History): History => (h.past.length ? { rows: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.rows, ...h.future] } : h);
export const historyRedo = (h: History): History => (h.future.length ? { rows: h.future[0], past: [...h.past, h.rows], future: h.future.slice(1) } : h);

/** 删除：新增行直接去掉；已有行标记“待删除”（保存时按归档处理），再删一次取消标记 */
export function toggleDelete(rows: GridRow[], indices: number[]): GridRow[] {
  const set = new Set(indices);
  const out: GridRow[] = [];
  rows.forEach((r, i) => {
    if (!set.has(i)) return void out.push(r);
    if (r.isNew) return;
    out.push({ ...r, deleted: !r.deleted, error: undefined });
  });
  return out;
}

/** 用服务端最新的记录替换一行（放弃自己对这一行的修改，冲突后用） */
export function replaceRow(rows: GridRow[], key: string, dto: ResourceDto): GridRow[] {
  return rows.map((r) => (r.key === key ? { ...rowFromDto(dto), key } : r));
}
