import { useState } from 'react';
import type { FieldDef } from '@kudesi/shared';
import { MoneyControl, RefSelect } from './RecordForm';
import { resourceApi } from './api';
import { FieldHint } from './FieldHint';

/** 供货来源行（原料、发货物料）：同一个组件用于新增和编辑，保存档案后按差异落库。 */
export interface SourceRow { rowId?: number; supplierId: number | null; originArea: string; systemSpec: string; purchasePrice: unknown; note?: string; stopped?: boolean }

const SUPPLIER: FieldDef = { key: 'supplierId', label: '供应商', type: 'ref', group: '基础', ref: 'finance-suppliers' };
export const blankSource = (): SourceRow => ({ supplierId: null, originArea: '', systemSpec: '', purchasePrice: '' });

export async function loadSourceRows(productId: number): Promise<SourceRow[]> {
  const r = await resourceApi.list('finance-product-sources', { fieldKey: 'productId', fieldValue: productId, pageSize: 200, showHidden: true });
  return r.items.map((i) => ({
    rowId: i.id, supplierId: typeof i.data.supplierId === 'number' ? i.data.supplierId : null, originArea: String(i.data.originArea ?? ''), systemSpec: String(i.data.systemSpec ?? ''),
    purchasePrice: i.data.purchasePrice ?? '', note: String(i.data.note ?? ''), stopped: i.status !== 'active',
  }));
}

const same = (a: SourceRow, b: SourceRow) => a.supplierId === b.supplierId && a.originArea === b.originArea && a.systemSpec === b.systemSpec && a.purchasePrice === b.purchasePrice;

/** 保存档案后落供货来源：没填供应商的空行忽略；没有成本编辑权限时不提交采购价 */
export async function saveSourceRows(productId: number, rows: SourceRow[], original: SourceRow[], canCost: boolean): Promise<string[]> {
  const failed: string[] = [];
  const keep = new Set(rows.map((r) => r.rowId).filter(Boolean));
  for (const o of original) if (o.rowId && !keep.has(o.rowId)) {
    try { await resourceApi.remove('finance-product-sources', o.rowId, '在商品档案表单里去掉'); } catch (e) { failed.push(`删除旧供货来源：${(e as Error).message || '失败'}`); }
  }
  for (const [i, r] of rows.entries()) {
    if (!r.supplierId) continue;
    const before = original.find((o) => o.rowId === r.rowId);
    if (before && same(before, r)) continue;
    const values: Record<string, unknown> = { productId, supplierId: r.supplierId, originArea: r.originArea, ...(r.systemSpec ? { systemSpec: r.systemSpec } : {}), ...(canCost && r.purchasePrice !== '' && !Number.isNaN(r.purchasePrice) ? { purchasePrice: r.purchasePrice } : {}) };
    try {
      if (r.rowId) await resourceApi.update('finance-product-sources', r.rowId, values);
      else await resourceApi.create('finance-product-sources', values);
    } catch (e) { failed.push(`供货来源第 ${i + 1} 行：${(e as Error).message || '保存失败'}`); }
  }
  return failed;
}

export function SourcesDraft({ rows, onChange, canCost, needSpec, error }: { rows: SourceRow[]; onChange: (r: SourceRow[]) => void; canCost: boolean; needSpec: boolean; error?: string }) {
  const set = (i: number, patch: Partial<SourceRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="rf-rows" data-field="supplySources">
      {rows.length > 0 && (
        <table className="data-table cards-narrow">
          <thead><tr><th>供应商</th><th>产区</th>{needSpec && <th>系统规格</th>}{canCost && <th>采购价（元）</th>}<th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.rowId ?? `n${i}`}>
                <td data-label="供应商"><RefSelect field={SUPPLIER} value={r.supplierId} onChange={(v) => set(i, { supplierId: v })} /></td>
                <td data-label="产区"><input aria-label="产区" maxLength={80} value={r.originArea} onChange={(e) => set(i, { originArea: e.target.value })} /></td>
                {needSpec && <td data-label="系统规格"><input aria-label="来源系统规格" maxLength={30} value={r.systemSpec} onChange={(e) => set(i, { systemSpec: e.target.value })} /></td>}
                {canCost && <td data-label="采购价"><MoneyControl ariaLabel="来源采购价" value={r.purchasePrice} scale={4} onChange={(v) => set(i, { purchasePrice: v })} /></td>}
                <td><button type="button" className="link-button" onClick={() => onChange(rows.filter((_, k) => k !== i))}>去掉</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button type="button" className="secondary-button small" onClick={() => onChange([...rows, blankSource()])}>＋ 添加供货来源</button>
      {error && <small className="field-error" role="alert">{error}</small>}
    </div>
  );
}

const UNIT_G: Record<string, number> = { g: 1, kg: 1000, jin: 500 };
const UNIT_LABEL: Record<string, string> = { g: '克', kg: '千克', jin: '斤' };

/**
 * 重量块（旧版“称重重量 / 物料重量”）：
 * - 包装类、发货物料、自建类型：直接填，可选克/千克/斤（斤、千克换算成克存，所选单位一并留存）；
 * - 其余类型：自动换算，勾选“人工修正重量”后才能自己填克数。
 */
export function WeightBlock({ values, onChange, manualOnly, required, error, defaultUnit = 'g' }: {
  values: Record<string, unknown>; onChange: (patch: Record<string, unknown>) => void; manualOnly: boolean; required?: boolean; error?: string; defaultUnit?: 'g' | 'kg';
}) {
  const unit = String(values.weightUnit || defaultUnit);
  const f = UNIT_G[unit] ?? 1;
  const manual = manualOnly || values.weightManual === true;
  const grams = values.weightG === undefined || values.weightG === '' || values.weightG === null ? '' : Number(values.weightG);
  const [text, setText] = useState(() => (grams === '' ? '' : String(Math.round((grams / f) * 1e6) / 1e6)));
  const setValue = (raw: string, u: string) => {
    setText(raw);
    if (!raw.trim()) return onChange({ weightG: '', ...(manualOnly ? { weightManual: true } : {}) });
    const n = Number(raw);
    onChange({ weightG: Number.isFinite(n) ? Math.round(n * (UNIT_G[u] ?? 1) * 1e6) / 1e6 : NaN, ...(manualOnly ? { weightManual: true } : {}) });
  };
  const autoHint = `不勾选时按${values.archiveType === 'raw' ? '系统规格' : '规格数量和单位'}自动换算${values.archiveType === 'self_made' ? '，自产成品按构成汇总' : ''}`;
  return (
    <div className="rf-weight" data-field="weightG">
      {!manualOnly && (
        <label className="rf-check"><input type="checkbox" checked={values.weightManual === true} onChange={(e) => onChange({ weightManual: e.target.checked })} /> 人工修正重量<FieldHint text={autoHint} /></label>
      )}
      {manual ? (
        <div className="rf-weight-row">
          <input aria-label="重量" inputMode="decimal" value={text} placeholder={required ? '必填' : ''} onChange={(e) => setValue(e.target.value, unit)} />
          <select aria-label="重量输入单位" value={unit} onChange={(e) => { onChange({ weightUnit: e.target.value }); setText(grams === '' ? '' : String(Math.round((grams / (UNIT_G[e.target.value] ?? 1)) * 1e6) / 1e6)); }}>
            {Object.entries(UNIT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {grams !== '' && unit !== 'g' && <small className="muted">= {grams} 克</small>}
        </div>
      ) : (
        <span className="rf-auto">{grams !== '' ? `自动换算：${grams} 克` : '保存后自动换算'}</span>
      )}
      {error && <small className="field-error" role="alert">{error}</small>}
    </div>
  );
}
