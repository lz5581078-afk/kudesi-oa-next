import { useEffect, useMemo, useState } from 'react';
import { multiplyUnitCents, sumUnitCents } from '@kudesi/shared';
import type { BomDraftRow } from './BomDraft';
import { resourceApi, type ResourceDto } from './api';

const finite = (value: unknown): number | null => value === '' || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
/** 与服务端构成汇总同口径：组件总成本含自身运装费，损耗只计成本，人工不计重量。 */
export function calculateDraftFacts(rows: BomDraftRow[], records: Map<string, ResourceDto>, canCost: boolean) {
  let weightG = 0, cost: number | null = rows.length ? 0 : null, complete = true;
  const groups: Record<string, { weightG: number; cost: number | null }> = {};
  for (const row of rows) {
    if (!row.id || !Number.isFinite(Number(row.qty)) || !(Number(row.qty) > 0) || !Number.isFinite(Number(row.loss || 0))) { complete = false; cost = null; continue; }
    const r = records.get(`${row.kind}:${row.id}`), weight = row.kind === 'labor' ? 0 : finite(r?.data.weightG);
    const price = canCost ? finite(r?.data[row.kind === 'labor' ? 'unitPrice' : 'totalCost']) : null;
    if (!r || weight === null) complete = false;
    const partWeight = Number(row.qty) * (weight ?? 0);
    let partCost: number | null = null;
    try { partCost = price === null ? null : multiplyUnitCents(price, Number(row.qty), row.kind === 'labor' ? 0 : Number(row.loss || 0)); } catch { complete = false; }
    weightG += partWeight;
    cost = cost === null || partCost === null ? null : sumUnitCents([cost, partCost]);
    const group = groups[row.group] ?? { weightG: 0, cost: 0 };
    group.weightG += partWeight;
    group.cost = group.cost === null || partCost === null ? null : sumUnitCents([group.cost, partCost]);
    groups[row.group] = group;
  }
  return { weightG: complete && rows.length ? Math.round(weightG * 1e6) / 1e6 : null, cost, groups, complete };
}

export function useProductDraftFacts(rows: BomDraftRow[], canCost: boolean) {
  const [records, setRecords] = useState(new Map<string, ResourceDto>());
  const ids = [...new Set(rows.filter(r => r.id).map(r => `${r.kind}:${r.id}`))].sort().join(',');
  useEffect(() => { let alive = true;
    Promise.all(ids.split(',').filter(Boolean).map(async key => { const [kind, id] = key.split(':'); try { return [key, await resourceApi.get(kind === 'labor' ? 'finance-labor-costs' : 'finance-products', Number(id))] as const; } catch { return null; } })).then(results => { if (alive) setRecords(new Map(results.filter((r): r is NonNullable<typeof r> => r !== null))); });
    return () => { alive = false; };
  }, [ids]);
  return useMemo(() => ({...calculateDraftFacts(rows, records, canCost), records}), [rows, records, canCost]);
}
