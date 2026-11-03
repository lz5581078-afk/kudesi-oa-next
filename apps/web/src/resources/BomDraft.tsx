import { useEffect, useState } from 'react';
import { COMPOSITION_GROUP_LABEL, multiplyUnitCents, type ResourceFormCollection, type CompositionGroup } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';
import { RefSelect } from './RecordForm';
import { FieldHint } from './FieldHint';
import { FinanceCompositionPicker, formatCompositionCost } from './FinanceCompositionPicker';

/**
 * 商品档案表单里的“生产组成”：自产成品（原料 / 产品包装 / OEM 包装 / 人工）和供应商 OEM 成品（OEM 包装）。
 * 新增和编辑是同一个组件：编辑时读出已有的构成行，与主档在同一事务内对改过的行做增、改、删；也能在详情“构成（BOM）”页签里单独改。
 */
export interface BomDraftRow { kind: 'component' | 'labor'; group: CompositionGroup; id: number | null; qty: number | ''; loss: number | ''; rowId?: number; version?: string }

const LABOR = { key: 'laborId', label: '人工项目', type: 'ref', group: '基础', ref: 'finance-labor-costs' } as const;

export const blankBomRow = (group: CompositionGroup): BomDraftRow => ({ kind: group === 'labor' ? 'labor' : 'component', group, id: null, qty: '', loss: '' });
export function validBomRows(rows: BomDraftRow[]) { return rows.filter((r) => r.id && Number(r.qty) > 0); }

/** 读出一个商品已有的构成行；组件所属的组按组件的档案类型归类 */
export async function loadBomRows(productId: number): Promise<BomDraftRow[]> {
  const boms: { items: ResourceDto[] } = { items: [] };
  for (let page = 1; ; page++) { const result = await resourceApi.list('finance-product-boms', { fieldKey: 'productId', fieldValue: productId, pageSize: 200, page, showHidden: true }); boms.items.push(...result.items); if (!result.items.length || boms.items.length >= result.total) break; }
  const rows: BomDraftRow[] = [];
  const types = new Map<number, string>();
  await Promise.all([...new Set(boms.items.map((b) => b.data.componentId).filter((x): x is number => typeof x === 'number'))].map((id) => resourceApi.get('finance-products', id).then((r) => { types.set(id, String(r.data.archiveType ?? '')); }).catch(() => undefined)));
  for (const b of boms.items) {
    const laborId = typeof b.data.laborId === 'number' ? b.data.laborId : null;
    const componentId = typeof b.data.componentId === 'number' ? b.data.componentId : null;
    const type = types.get(componentId ?? 0) ?? '';
    const group: CompositionGroup = laborId ? 'labor' : type === 'oem_package' ? 'oem_package' : type === 'package' ? 'package' : 'raw';
    rows.push({ kind: laborId ? 'labor' : 'component', group, id: laborId ?? componentId, qty: Number(b.data.qty ?? 1), loss: b.data.lossPercent === undefined || b.data.lossPercent === null || b.data.lossPercent === '' ? '' : Number(b.data.lossPercent), rowId: b.id, version: b.version });
  }
  return rows;
}

export function bomCollection(rows: BomDraftRow[], original: BomDraftRow[]): ResourceFormCollection {
  if (rows.some(row => !row.id || !Number.isFinite(Number(row.qty)) || !(Number(row.qty) > 0))) throw new Error('原料、包装和人工明细必须选择档案，并填写大于 0 的倍数');
  return { type: 'finance-product-boms', expected: original.filter(r => r.rowId).map(r => ({ id: r.rowId!, version: r.version ?? '' })), rows: validBomRows(rows).map(r => ({ ...(r.rowId ? { id: r.rowId } : {}), values: { ...(r.kind === 'labor' ? { laborId: r.id, componentId: null } : { componentId: r.id, laborId: null }), qty: Number(r.qty), lossPercent: r.loss === '' ? 0 : Number(r.loss) } })) };
}

/** 按档案类型挑组件：原料、产品包装、OEM 包装各自只列自己那一类（先取前 200 条，可输入关键字缩小） */
function ComponentSelect({ archiveType, value, onChange }: { archiveType: string; value: number | null; onChange: (v: number | null) => void }) {
  const [keyword, setKeyword] = useState('');
  const [items, setItems] = useState<Array<{ id: number; title: string }>>([]);
  const [labelNow, setLabelNow] = useState('');
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => { resourceApi.list('finance-products', { tab: archiveType, pageSize: 200, keyword: keyword.trim() || undefined }).then((r) => alive && setItems(r.items.map((i) => ({ id: i.id, title: i.title })))).catch(() => alive && setItems([])); }, keyword ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [archiveType, keyword]);
  useEffect(() => { if (value && !items.some((i) => i.id === value)) resourceApi.get('finance-products', value).then((r) => setLabelNow(r.title)).catch(() => setLabelNow(`#${value}`)); }, [value, items]);
  return (
    <>
      <input type="search" className="ref-search" aria-label="搜索组件" placeholder="输入名称或编码搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      <select aria-label="组件" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">（请选择）</option>
        {value && !items.some((i) => i.id === value) && <option value={value}>{labelNow || `#${value}`}</option>}
        {items.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
      </select>
    </>
  );
}

export function BomDraft({ rows, onChange, groups = ['raw', 'package', 'oem_package', 'labor'], required, error, reference = false, records, canCost = true }: { rows: BomDraftRow[]; onChange: (r: BomDraftRow[]) => void; groups?: readonly CompositionGroup[]; required?: boolean; error?: string; reference?: boolean; records?: Map<string,ResourceDto>; canCost?: boolean }) {
  const set = (i: number, patch: Partial<BomDraftRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const choose = (i: number, id: number | null) => set(i, { id, qty: id && !(Number(rows[i].qty) > 0) ? 1 : rows[i].qty });
  if (reference) {
    const visible = groups.filter(g => g !== 'oem_package' || !groups.includes('package'));
    return <div className="reference-bom" data-field="composition">{visible.map((g,index) => {
      const combined = g === 'package' && groups.includes('oem_package'), meta=COMPOSITION_GROUP_LABEL[g];
      const mine=rows.map((r,i)=>({r,i})).filter(({r})=>r.group===g || combined&&r.group==='oem_package');
      return <section key={g} id={`rf-bom-${g}`} className="reference-bom-group" aria-label={meta.title}><header><div><span>{String(index+1).padStart(2,'0')}</span><strong>{combined?'包装组成':meta.title}</strong><small>{meta.hint}</small></div><div><button type="button" className="secondary-button small" onClick={()=>onChange([...rows,blankBomRow(g)])}>＋ 添加{meta.title}</button>{combined&&<button type="button" className="secondary-button small" onClick={()=>onChange([...rows,blankBomRow('oem_package')])}>＋ 添加OEM 包装</button>}</div></header>{mine.map(({r,i})=>{const record=records?.get(`${r.kind}:${r.id}`),d=record?.data,price=d?.[r.kind==='labor'?'unitPrice':'totalCost'],cost=price==null?null:multiplyUnitCents(Number(price),Number(r.qty||0),r.kind==='labor'?0:Number(r.loss||0));return <div key={r.rowId??i} className="reference-bom-row"><div className="reference-bom-choice"><label>{COMPOSITION_GROUP_LABEL[r.group].pick}<FinanceCompositionPicker group={r.group} value={r.id} onChange={id=>choose(i,id)} labelNow={record ? String(r.kind==='labor' ? `${record.data.workName||record.title} · ${record.data.workCode||'无编号'}` : record.data.basicInfoFullName||record.title) : undefined} categoriesEnabled={groups.length>1} canCost={canCost}/></label><small>{record?.refLabels.categoryId??''}{d?.purchaseSpec?` · ${String(d.purchaseSpec)}`:''}</small><button type="button" className="link-button danger" onClick={()=>onChange(rows.filter((_,k)=>k!==i))}>去掉</button></div><div className="reference-bom-facts"><label>{groups.length===1&&g==='oem_package'?'个数/用量':'使用倍数'}<input aria-label="组成数量" type="number" min="0" step="any" value={r.qty} onChange={e=>set(i,{qty:e.target.value===''?'':Number(e.target.value)})}/></label>{canCost&&<div><small>{g==='labor'?'单位人工成本':'采购价'}</small><strong>{d?.[g==='labor'?'unitPrice':'purchasePrice']==null?'待补齐':formatCompositionCost(Number(d[g==='labor'?'unitPrice':'purchasePrice']))}</strong><small>/ {String(d?.purchaseSpec||d?.unitName||'单位')}</small></div>}{g!=='labor'&&<div><small>每倍重量</small><strong>{d?.weightG==null?'待补齐':`${Number(d.weightG)/1000} kg`}</strong></div>}{canCost&&<div className="reference-bom-subtotal"><small>本项成本</small><strong>{cost===null?'待补齐':formatCompositionCost(cost)}</strong><small>{g==='labor'?'人工不计重量':`重量 ${Number(d?.weightG||0)*Number(r.qty||0)/1000} kg`}</small></div>}</div>{g!=='labor'&&<details className="reference-bom-loss"><summary>损耗设置</summary><label>损耗率（%）<input aria-label="组成损耗率" type="number" min="0" max="99.999999" step="any" value={r.loss} onChange={e=>set(i,{loss:e.target.value===''?'':Number(e.target.value)})}/></label></details>}</div>;})}{!mine.length&&<p className="reference-bom-empty">尚未添加{combined?'包装':meta.title}，可从已维护的档案中选择。</p>}</section>;
    })}{error&&<small className="field-error" role="alert">{error}</small>}</div>;
  }
  return (
    <div className="rf-rows" data-field="composition">
      {groups.map((g) => {
        const meta = COMPOSITION_GROUP_LABEL[g];
        const mine = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.group === g);
        return (
          <fieldset key={g} className="form-group rf-rowgroup" aria-label={meta.title}>
            <div className="rf-rg-head"><strong>{meta.title}</strong><FieldHint text={meta.hint} /><button type="button" className="secondary-button small" onClick={() => onChange([...rows, blankBomRow(g)])}>＋ 添加{meta.title}</button></div>
            {mine.length > 0 && (
              <table className="data-table cards-narrow">
                <thead><tr><th>{meta.pick}</th><th>数量</th><th>损耗率(%)</th><th /></tr></thead>
                <tbody>
                  {mine.map(({ r, i }) => (
                    <tr key={i}>
                      <td data-label={meta.pick}>{g === 'labor' ? <RefSelect field={{ ...LABOR }} value={r.id} onChange={(v) => choose(i, v)} /> : <ComponentSelect archiveType={meta.archiveType!} value={r.id} onChange={(v) => choose(i, v)} />}</td>
                      <td data-label="数量"><input aria-label="组成数量" type="number" min={0} step="any" value={r.qty} onChange={(e) => set(i, { qty: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                      <td data-label="损耗率"><input aria-label="组成损耗率" type="number" min={0} step="any" value={r.loss} onChange={(e) => set(i, { loss: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                      <td><button type="button" className="link-button" onClick={() => onChange(rows.filter((_, k) => k !== i))}>去掉</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </fieldset>
        );
      })}
            {error && <small className="field-error" role="alert">{error}</small>}
    </div>
  );
}
