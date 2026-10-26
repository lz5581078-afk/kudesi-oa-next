import { PROVINCES } from '@kudesi/shared';
import { yuanToCents } from '../common';
import type { RuleRow } from './expressApi';

/** 价格矩阵：行 = 省份（含“全国”），列 = 重量段 + 计费方式；格子是价格（固定价，或首重价 + 续重价）。 */
export interface MatrixColumn {
  id: string;
  start: number;
  end: number | null;
  startExclusive: boolean;
  endExclusive: boolean;
  mode: 'fixed' | 'formula';
  /** 首重 0 或 1（公斤），只有 formula 用 */
  firstWeight: 0 | 1;
}
export interface MatrixCell { a: string; b: string }
export type MatrixCells = Record<string, MatrixCell>;

export const MATRIX_ROWS: Array<{ value: string; label: string }> = [{ value: 'ALL', label: '全国统一' }, ...PROVINCES.map((p) => ({ value: p, label: p }))];

export const cellKey = (province: string, columnId: string) => `${province}|${columnId}`;
export const columnId = (c: Pick<MatrixColumn, 'start' | 'end' | 'startExclusive' | 'endExclusive' | 'mode' | 'firstWeight'>) =>
  `${c.startExclusive ? '>' : '≥'}${c.start}|${c.end === null ? '' : `${c.endExclusive ? '<' : '≤'}${c.end}`}|${c.mode}${c.mode === 'formula' ? c.firstWeight : ''}`;

export function columnLabel(c: MatrixColumn): string {
  const lo = `${c.startExclusive ? '>' : '≥'}${c.start}`;
  const hi = c.end === null ? '不限' : `${c.endExclusive ? '<' : '≤'}${c.end}`;
  return `${lo}kg ~ ${hi}${c.end === null ? '' : 'kg'}${c.mode === 'formula' ? `（首重${c.firstWeight}kg）` : ''}`;
}

const centsText = (c: number | null | undefined) => (c === null || c === undefined ? '' : String(c / 100));

/** 价格规则 → 矩阵。同一省份同一列出现多条时，以后出现的为准。 */
export function rulesToMatrix(rules: RuleRow[]): { columns: MatrixColumn[]; cells: MatrixCells } {
  const columns: MatrixColumn[] = [];
  const cells: MatrixCells = {};
  for (const r of rules) {
    const formula = r.fixedPrice === null || r.fixedPrice === undefined;
    const col: MatrixColumn = {
      id: '', start: r.shipWeightMin ?? 0, end: r.shipWeightMax ?? null, startExclusive: Boolean(r.minExclusive), endExclusive: Boolean(r.maxExclusive),
      mode: formula ? 'formula' : 'fixed', firstWeight: r.firstWeight === 0 ? 0 : 1,
    };
    col.id = columnId(col);
    if (!columns.some((c) => c.id === col.id)) columns.push(col);
    cells[cellKey(r.province, col.id)] = formula ? { a: centsText(r.firstPrice), b: centsText(r.extraPrice) } : { a: centsText(r.fixedPrice), b: '' };
  }
  columns.sort((x, y) => x.start - y.start || (x.end ?? Infinity) - (y.end ?? Infinity));
  return { columns, cells };
}

export interface MatrixResult { rules: RuleRow[]; errors: string[] }

/** 矩阵 → 价格规则。空格子跳过；填了但不合法的给出“省份 / 列”的错误。 */
export function matrixToRules(columns: MatrixColumn[], cells: MatrixCells): MatrixResult {
  const rules: RuleRow[] = [];
  const errors: string[] = [];
  for (const col of columns) {
    if (!(col.start >= 0)) errors.push(`${columnLabel(col)}：下限要大于等于 0`);
    if (col.end !== null && !(col.end > col.start)) errors.push(`${columnLabel(col)}：上限必须大于下限`);
  }
  if (errors.length) return { rules, errors };
  for (const row of MATRIX_ROWS) {
    for (const col of columns) {
      const cell = cells[cellKey(row.value, col.id)];
      if (!cell || (cell.a.trim() === '' && cell.b.trim() === '')) continue;
      const a = yuanToCents(cell.a);
      const where = `${row.label} / ${columnLabel(col)}`;
      if (a === null || Number.isNaN(a) || a < 0) { errors.push(`${where}：价格要填大于等于 0 的金额（最多两位小数）`); continue; }
      const base: RuleRow = { province: row.value, shipWeightMin: col.start, shipWeightMax: col.end, minExclusive: col.startExclusive || undefined, maxExclusive: col.endExclusive || undefined };
      if (col.mode === 'fixed') {
        rules.push({ ...base, fixedPrice: a });
      } else {
        const b = yuanToCents(cell.b);
        if (b === null || Number.isNaN(b) || b < 0) { errors.push(`${where}：续重价要填大于等于 0 的金额`); continue; }
        rules.push({ ...base, firstWeight: col.firstWeight, firstPrice: a, extraPrice: b });
      }
    }
  }
  return { rules, errors };
}

/** 旧系统的标准档位：0.5 / 1 / 2 / 3 / 4 / 5 / 6 公斤 */
export function standardColumns(): MatrixColumn[] {
  const edges: Array<[number, number]> = [[0, 0.5], [0.5, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]];
  return edges.map(([start, end]) => {
    const c: MatrixColumn = { id: '', start, end, startExclusive: start > 0, endExclusive: false, mode: 'fixed', firstWeight: 1 };
    c.id = columnId(c);
    return c;
  });
}
