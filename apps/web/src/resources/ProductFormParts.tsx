import { useEffect, useState } from 'react';
import { PRODUCT_UNIT_SEEDS, sourcePriceTime, type ResourceFormCollection, type FieldDef } from '@kudesi/shared';
import { MoneyControl, RefSelect } from './RecordForm';
import { resourceApi } from './api';
import { FieldHint } from './FieldHint';
import { FinanceSupplierPicker } from './FinanceSupplierPicker';
import { fieldOptions, useUnitOptions } from './unitOptions';
import { ManageLink } from './ManageLink';

/** 供货来源行（原料、发货物料）：同一个组件用于新增和编辑，与主档在同一事务内按差异保存。 */
export interface SourceRow { rowId?: number; version?: string; supplierId: number | null; originArea: string; systemSpec: string; purchasePrice: unknown; note?: string; stopped?: boolean; priceUpdatedAt?: string; updatedAt?: string; supplierLabel?: string }

const SUPPLIER: FieldDef = { key: 'supplierId', label: '供应商', type: 'ref', group: '基础', ref: 'finance-suppliers' };
const SOURCE_SPEC: FieldDef = { key: 'systemSpec', label: '系统规格', type: 'select', group: '基础', optionsFrom: { resource: 'finance-product-units', kind: 'shipping_system_spec' }, options: PRODUCT_UNIT_SEEDS.filter(([kind]) => kind === 'shipping_system_spec').map(([, name]) => ({ value: name, label: name })) };
export const blankSource = (): SourceRow => ({ supplierId: null, originArea: '', systemSpec: '', purchasePrice: '', priceUpdatedAt: new Date().toISOString() });

export async function loadSourceRows(productId: number): Promise<SourceRow[]> {
  const items: import('./api').ResourceDto[] = [];
  for (let page = 1; ; page++) { const r = await resourceApi.list('finance-product-sources', { fieldKey: 'productId', fieldValue: productId, page, pageSize: 200, showHidden: true }); items.push(...r.items); if (items.length >= r.total || !r.items.length) break; }
  return items.map((i) => ({
    rowId: i.id, version: i.version, supplierId: typeof i.data.supplierId === 'number' ? i.data.supplierId : null, originArea: String(i.data.originArea ?? ''), systemSpec: String(i.data.systemSpec ?? ''),
    priceUpdatedAt: typeof i.data.priceUpdatedAt === 'string' ? i.data.priceUpdatedAt : undefined, updatedAt: i.updatedAt, supplierLabel: i.refLabels?.supplierId,
    purchasePrice: i.data.purchasePrice ?? '', note: String(i.data.note ?? ''), stopped: i.status !== 'active',
  }));
}

/** 完整子表由通用表单事务保存；按编辑采购价的先后提交，最后改价的成为当前报价。 */
export function sourceCollection(rows: SourceRow[], original: SourceRow[], canCost: boolean): ResourceFormCollection {
  return {
    type: 'finance-product-sources', expected: original.filter(r => r.rowId).map(r => ({ id: r.rowId!, version: r.version ?? '' })),
    rows: [...rows].filter(r => r.supplierId).sort((a,b) => sourcePriceTime(a.priceUpdatedAt,a.updatedAt)-sourcePriceTime(b.priceUpdatedAt,b.updatedAt)).map(r => ({
      ...(r.rowId ? { id: r.rowId } : {}), values: { supplierId: r.supplierId, originArea: r.originArea, systemSpec: r.systemSpec, ...(r.note !== undefined ? { note: r.note } : {}), ...(canCost && r.purchasePrice !== '' && !Number.isNaN(r.purchasePrice) ? { purchasePrice: r.purchasePrice } : {}) },
    })),
  };
}

export function latestSource(rows: SourceRow[]): SourceRow | undefined {
  return rows.filter(row => !row.stopped).reduce<SourceRow | undefined>((latest,row) => !latest || sourcePriceTime(row.priceUpdatedAt,row.updatedAt) > sourcePriceTime(latest.priceUpdatedAt,latest.updatedAt) || sourcePriceTime(row.priceUpdatedAt,row.updatedAt) === sourcePriceTime(latest.priceUpdatedAt,latest.updatedAt) && (row.rowId ?? 0) >= (latest.rowId ?? 0) ? row : latest, undefined);
}

export function SourcesDraft({ rows, onChange, canCost, needSpec, error, reference = false, pricingUnit }: { pricingUnit?: string; rows: SourceRow[]; onChange: (r: SourceRow[]) => void; canCost: boolean; needSpec: boolean; error?: string; reference?: boolean }) {
  const units = useUnitOptions();
  const specs = fieldOptions(SOURCE_SPEC, {}, units);
  const specSelect = (row: SourceRow, change: (value: string) => void) => <select aria-label="来源系统规格" value={row.systemSpec} onChange={e => change(e.target.value)}><option value="">请选择系统规格</option>{row.systemSpec && !specs.some(option => option.value === row.systemSpec) && <option value={row.systemSpec}>{row.systemSpec}</option>}{specs.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  const set = (i: number, patch: Partial<SourceRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch, ...("purchasePrice" in patch && patch.purchasePrice !== r.purchasePrice ? { priceUpdatedAt: new Date().toISOString() } : {}) } : r)));
  if (reference) {
    const shown = rows.length ? rows : [blankSource()];
    const change = (i: number, patch: Partial<SourceRow>) => onChange(shown.map((r,k) => k === i ? {...r,...patch,...('purchasePrice' in patch && patch.purchasePrice !== r.purchasePrice ? {priceUpdatedAt:new Date().toISOString()} : {})} : r));
    const latest = latestSource(shown);
    return <div className="reference-sources" data-field="supplySources"><div className="reference-lines-actions"><button type="button" className="secondary-button small" onClick={() => onChange([...rows,blankSource()])}>＋ 添加供货来源</button></div>{shown.map((r,i) => <section key={r.rowId ?? i} className={`reference-source${r === latest ? ' is-latest' : ''}`}><header><strong>来源 {String(i + 1).padStart(2,'0')}</strong>{r === latest && <span>当前最新成本</span>}<button type="button" className="link-button danger" aria-label="删除供货来源" onClick={() => onChange(rows.length > 1 ? rows.filter((_,k)=>k!==i) : [blankSource()])}>去掉</button></header><div className={`reference-source-grid${needSpec ? ' has-system-spec' : ''}`}><label>供应商名称 <b className="req">必填</b><FinanceSupplierPicker labelNow={r.supplierLabel} value={r.supplierId} onChange={v=>change(i,{supplierId:v})}/></label><label>产区 <b className="req">必填</b><input aria-label="产区" maxLength={80} value={r.originArea} onChange={e=>change(i,{originArea:e.target.value})}/></label>{needSpec && <label>系统规格 <b className="req">必填</b><ManageLink field={SOURCE_SPEC} inPlace onChoose={value => change(i, { systemSpec: String(value) })} />{specSelect(r, value => change(i, { systemSpec: value }))}</label>}{canCost && <label>采购价 <b className="req">必填</b><small className="reference-source-unit">元/{needSpec ? r.systemSpec : pricingUnit}</small><MoneyControl ariaLabel="来源采购价" value={r.purchasePrice} scale={4} onChange={v=>change(i,{purchasePrice:v})}/></label>}</div></section>)}{error && <small className="field-error" role="alert">{error}</small>}</div>;
  }
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
                {needSpec && <td data-label="系统规格">{specSelect(r, value => set(i, { systemSpec: value }))}</td>}
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
  useEffect(() => { setText(grams === '' ? '' : String(Math.round((grams / f) * 1e9) / 1e9)); }, [grams, f]);
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
