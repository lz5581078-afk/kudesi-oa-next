import { FEE_BOOKING_NODES, FEE_BOOKING_NODE_MAP, lineAmount, type DocType, type DocTypeDef } from '@kudesi/shared';
import { SearchPick, money } from '../common';
import type { LineHint } from '../financeApi';
import { gridKeyDown } from './gridNav';
import { emptyLine, type LineState } from './types';

export const unitPriceCents = (v: string, parse: (t: string) => number | null | undefined): number => { const c = parse(v); return typeof c === 'number' && !Number.isNaN(c) ? c : 0; };

interface Props {
  def: DocTypeDef;
  type: DocType;
  lines: LineState[];
  setLines: (f: (ls: LineState[]) => LineState[]) => void;
  setLine: (i: number, patch: Partial<LineState>) => void;
  priceOf: (text: string) => number;
  hints: Map<number, LineHint>;
  onPickProduct: (i: number, id: number | null, name: string) => void;
  onPickFee: (i: number, id: number | null, name: string) => void;
  addRow: () => void;
  gridRef?: React.Ref<HTMLDivElement>;
}

const outType = (t: DocType) => t === 'sale' || t === 'online-sale' || t === 'purchase-return';
const buyType = (t: DocType) => t === 'purchase-in' || t === 'purchase-return';

/** 行内小提示：账面库存、库存不足、最近进价/售价对比（管家婆“账面库存”“成本异常提示”“价格参考”） */
function rowHint(type: DocType, l: LineState, h: LineHint | undefined, priceCents: number) {
  if (!l.productId || !h) return null;
  const qty = Number(l.qty) || 0;
  const out: JSX.Element[] = [<span key="s" className={outType(type) && qty > h.stockQty ? 'vc-bad' : ''}>库存 {Number(h.stockQty.toFixed(4))}{outType(type) && qty > h.stockQty ? '（不够出，过账会被拒）' : ''}</span>];
  if (buyType(type) && h.lastPurchaseCents !== undefined && h.lastPurchaseCents !== null) {
    const diff = priceCents && priceCents !== h.lastPurchaseCents;
    out.push(<span key="p" className={diff ? 'vc-warn-text' : ''} title={`${h.lastPurchaseDocNo ?? ''} ${h.lastPurchaseDate ?? ''}`}>上次进价 {money(h.lastPurchaseCents)}{diff ? (priceCents > (h.lastPurchaseCents ?? 0) ? '，本次偏高' : '，本次偏低') : ''}</span>);
  }
  if ((type === 'sale' || type === 'online-sale') && h.lastSaleCents !== undefined && h.lastSaleCents !== null) out.push(<span key="q" title={`${h.lastSaleDocNo ?? ''} ${h.lastSaleDate ?? ''}`}>上次售价 {money(h.lastSaleCents)}</span>);
  return <div className="vc-hint">{out}</div>;
}

/** 商品/费用明细网格：回车逐格录入、方向键换行、Shift+Delete 删行；商品行带库存与价格提示、赠品开关 */
export function GoodsGrid({ def, type, lines, setLines, setLine, priceOf, hints, onPickProduct, onPickFee, addRow, gridRef }: Props) {
  const isFee = def.lines === 'fee';
  const delRow = (i: number) => setLines((ls) => (ls.length <= 1 ? [emptyLine()] : ls.filter((_, k) => k !== i)));
  return (
    <div className="table-scroll vc-grid" ref={gridRef} onKeyDown={(e) => gridKeyDown(e, { addRow, deleteRow: delRow })}>
      <table className="data-table doc-lines">
        <thead><tr><th>#</th><th>{isFee ? '费用项目' : '商品'}</th>{!isFee && <th>单位</th>}{isFee && <><th>挂账节点</th><th>挂账对象</th></>}<th>数量</th><th>单价（元）</th><th>金额</th><th>备注</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} data-row={i} className={l.gift ? 'vc-gift' : undefined}>
              <td data-cell="#" className="vc-no">{i + 1}</td>
              <td>
                {!isFee
                  ? <SearchPick ariaLabel={`第${i + 1}行商品`} type="finance-products" value={l.productId} label={l.productName} onChange={(id, name) => onPickProduct(i, id, name)} />
                  : <SearchPick ariaLabel={`第${i + 1}行费用项目`} type="finance-fee-items" fieldKey="direction" fieldValue={def.feeDirection} value={l.feeItemId} label={l.feeItemName} onChange={(id, name) => onPickFee(i, id, name)} />}
                {!isFee && rowHint(type, l, l.productId ? hints.get(l.productId) : undefined, priceOf(l.price))}
              </td>
              {!isFee && <td data-cell="单位"><input aria-label={`第${i + 1}行单位`} maxLength={20} value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} placeholder="单位" /></td>}
              {isFee && (
                <>
                  <td data-cell="挂账节点">
                    <select aria-label={`第${i + 1}行挂账节点`} value={l.node} onChange={(e) => setLine(i, { node: e.target.value, relatedId: null, relatedName: '' })}>
                      <option value="">不选择</option>
                      {FEE_BOOKING_NODES.map((n) => <option key={n.node} value={n.node}>{n.node}</option>)}
                    </select>
                  </td>
                  <td data-cell="挂账对象">
                    {l.node && FEE_BOOKING_NODE_MAP.get(l.node)?.resource
                      ? <SearchPick ariaLabel={`第${i + 1}行挂账对象`} type={FEE_BOOKING_NODE_MAP.get(l.node)!.resource!} fieldKey={FEE_BOOKING_NODE_MAP.get(l.node)!.kind ? 'kind' : undefined} fieldValue={FEE_BOOKING_NODE_MAP.get(l.node)!.kind} value={l.relatedId} label={l.relatedName} placeholder={`搜索${l.node}`} onChange={(id, name) => setLine(i, { relatedId: id, relatedName: name })} />
                      : <input aria-label={`第${i + 1}行挂账对象`} value={l.relatedName} maxLength={100} placeholder={l.needObject ? '必填：写清挂在哪里' : l.node ? `${l.node}名称` : '先选挂账节点'} disabled={!l.node} onChange={(e) => setLine(i, { relatedName: e.target.value })} />}
                    {l.needObject && !l.relatedId && !l.relatedName.trim() && <span className="vc-bad">必须挂对象</span>}
                  </td>
                </>
              )}
              <td data-cell="数量"><input inputMode="decimal" aria-label={`第${i + 1}行数量`} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></td>
              <td data-cell="单价（元）">
                <input inputMode="decimal" aria-label={`第${i + 1}行单价`} value={l.gift ? '0' : l.price} disabled={l.gift} onChange={(e) => setLine(i, { price: e.target.value })} />
                {!isFee && (
                  <label className="vc-gift-toggle"><input type="checkbox" aria-label={`第${i + 1}行赠品`} checked={l.gift} onChange={(e) => setLine(i, { gift: e.target.checked, price: e.target.checked ? '0' : '' })} />赠品</label>
                )}
              </td>
              <td className="num" data-cell="金额">{money(lineAmount({ qty: Number(l.qty) || 0, unitPriceCents: l.gift ? 0 : priceOf(l.price) }))}</td>
              <td data-cell="备注"><input aria-label={`第${i + 1}行备注`} maxLength={200} value={l.memo} onChange={(e) => setLine(i, { memo: e.target.value })} /></td>
              <td><button type="button" className="link-button" aria-label={`删除第${i + 1}行`} onClick={() => delRow(i)}>{lines.length <= 1 ? '清空' : '删除'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
