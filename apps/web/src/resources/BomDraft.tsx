import { useState } from 'react';
import type { FieldDef } from '@kudesi/shared';
import { resourceApi } from './api';
import { RefSelect } from './RecordForm';

/** 新建自制品/OEM 成品时直接加“生产组成”行（原料/包装/人工），和档案一起保存；保存后也能在“构成（BOM）”页签里改。 */
export interface BomDraftRow { kind: 'component' | 'labor'; id: number | null; qty: number | ''; loss: number | '' }

const COMPONENT: FieldDef = { key: 'componentId', label: '组件', type: 'ref', group: '基础', ref: 'finance-products' };
const LABOR: FieldDef = { key: 'laborId', label: '人工项目', type: 'ref', group: '基础', ref: 'finance-labor-costs' };

export function validBomRows(rows: BomDraftRow[]) { return rows.filter((r) => r.id && Number(r.qty) > 0); }

/** 保存档案后补建构成行；返回没建成功的行的说明 */
export async function saveBomRows(productId: number, rows: BomDraftRow[]): Promise<string[]> {
  const failed: string[] = [];
  for (const [i, r] of validBomRows(rows).entries()) {
    try {
      await resourceApi.create('finance-product-boms', { productId, ...(r.kind === 'labor' ? { laborId: r.id } : { componentId: r.id }), qty: Number(r.qty), ...(r.loss !== '' ? { lossPercent: Number(r.loss) } : {}) });
    } catch (e) { failed.push(`第 ${i + 1} 行：${(e as Error).message || '保存失败'}`); }
  }
  return failed;
}

export function BomDraft({ rows, onChange }: { rows: BomDraftRow[]; onChange: (r: BomDraftRow[]) => void }) {
  const [open, setOpen] = useState(rows.length > 0);
  const set = (i: number, patch: Partial<BomDraftRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="form-group">
      <legend>生产组成（选填）</legend>
      {!open && <button type="button" className="secondary-button small" onClick={() => { setOpen(true); onChange([{ kind: 'component', id: null, qty: 1, loss: '' }]); }}>＋ 现在添加原料 / 包装 / 人工</button>}
      {open && (
        <>
          <table className="data-table cards-narrow">
            <thead><tr><th>类别</th><th>组件 / 人工项目</th><th>数量</th><th>损耗率(%)</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td data-label="类别"><select aria-label="组成类别" value={r.kind} onChange={(e) => set(i, { kind: e.target.value as BomDraftRow['kind'], id: null })}><option value="component">原料 / 包装</option><option value="labor">人工</option></select></td>
                  <td data-label="组件"><RefSelect key={r.kind} field={r.kind === 'labor' ? LABOR : COMPONENT} value={r.id} onChange={(v) => set(i, { id: v })} /></td>
                  <td data-label="数量"><input aria-label="组成数量" type="number" min={0} step="any" value={r.qty} onChange={(e) => set(i, { qty: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                  <td data-label="损耗率"><input aria-label="组成损耗率" type="number" min={0} step="any" value={r.loss} onChange={(e) => set(i, { loss: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                  <td><button type="button" className="link-button" onClick={() => onChange(rows.filter((_, k) => k !== i))}>去掉</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="secondary-button small" onClick={() => onChange([...rows, { kind: 'component', id: null, qty: 1, loss: '' }])}>＋ 加一行</button>
        </>
      )}
    </fieldset>
  );
}
