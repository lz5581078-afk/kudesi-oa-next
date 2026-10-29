import { useEffect, useRef, useState } from 'react';
import { unitYuanText, yuanToPreciseCents, type FieldDef, type PurchaseLine } from '@kudesi/shared';
import { ApiError } from '../../api/client';
import { purchaseApi, type ProductOption, type PurchaseSummary } from './purchaseApi';
import './purchase.css';

type Names = Record<number, ProductOption>;
const labelOf = (names: Names, id: number) => names[id] ?? { id, code: '', name: `商品 #${id}`, spec: '' };

/** 按编号补商品名称（重新提交、办理人看明细时用） */
function useNames(ids: number[]) {
  const [names, setNames] = useState<Names>({});
  const key = ids.join(',');
  useEffect(() => {
    const need = ids.filter((id) => !names[id]);
    if (!need.length) return;
    let alive = true;
    purchaseApi.names(need).then((r) => alive && setNames((cur) => ({ ...cur, ...Object.fromEntries(r.items.map((o) => [o.id, o])) }))).catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [names, (o: ProductOption) => setNames((cur) => ({ ...cur, [o.id]: o }))] as const;
}

/** 搜索并选一个商品：只列启用的采购品，最多 30 条，没有价格。 */
function ProductPicker({ onPick, exclude }: { onPick: (o: ProductOption) => void; exclude: number[] }) {
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState('');
  const [items, setItems] = useState<ProductOption[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const t = setTimeout(() => { purchaseApi.options(kw).then((r) => alive && setItems(r.items)).catch((e) => alive && setErr(e instanceof ApiError ? e.message : '加载失败')); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [open, kw]);
  if (!open) return <button type="button" className="secondary-button small" onClick={() => setOpen(true)}>＋ 添加商品</button>;
  const shown = (items ?? []).filter((o) => !exclude.includes(o.id));
  return (
    <div className="pur-picker">
      <div className="row-actions">
        <input type="search" autoFocus placeholder="输入编码或名称搜索商品" aria-label="搜索商品" value={kw} onChange={(e) => setKw(e.target.value)} />
        <button type="button" className="link-button" onClick={() => { setOpen(false); setKw(''); }}>收起</button>
      </div>
      {err && <span role="alert" className="muted">{err}</span>}
      <ul className="pur-picker-list">
        {items === null ? <li className="muted" style={{ padding: 8 }}>加载中…</li> : shown.length === 0 ? <li className="muted" style={{ padding: 8 }}>{(items ?? []).length > 0 ? '搜索到的商品都已添加' : '没有找到（只能选启用的商品档案）'}</li> : shown.map((o) => (
          <li key={o.id}><button type="button" onClick={() => onPick(o)}><strong>{o.code || '无编码'}</strong> {o.name}{o.spec && <small className="muted"> · {o.spec}</small>}</button></li>
        ))}
      </ul>
    </div>
  );
}

/** 申请：采购商品明细（商品 + 数量 + 单位 + 备注） */
function LinesEditor({ value, onChange }: { value: PurchaseLine[]; onChange: (v: PurchaseLine[]) => void }) {
  const [names, learn] = useNames(value.map((l) => l.productId));
  const patch = (i: number, p: Partial<PurchaseLine>) => onChange(value.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <div>
      {value.length > 0 && (
        <ul className="pur-lines">
          {value.map((l, i) => {
            const n = labelOf(names, l.productId);
            return (
              <li key={l.productId} className="pur-line">
                <div className="pur-name"><strong>{n.name}</strong><small>{n.code}{n.spec ? ` · ${n.spec}` : ''}</small></div>
                <label className="pur-cell"><span>数量</span><input type="number" min={0} step="any" inputMode="decimal" aria-label="数量" value={Number.isFinite(l.qty) ? l.qty : ''} onChange={(e) => patch(i, { qty: e.target.value === '' ? NaN : Number(e.target.value) })} /></label>
                <label className="pur-cell"><span>单位</span><input aria-label="单位" maxLength={20} value={l.unit ?? ''} placeholder="箱/件" onChange={(e) => patch(i, { unit: e.target.value })} /></label>
                <label className="pur-cell"><span>备注</span><input aria-label="行备注" maxLength={200} value={l.note ?? ''} placeholder="规格要求等" onChange={(e) => patch(i, { note: e.target.value })} /></label>
                <button type="button" className="link-button" aria-label="去掉这个商品" onClick={() => onChange(value.filter((_, j) => j !== i))}>去掉</button>
              </li>
            );
          })}
        </ul>
      )}
      <ProductPicker exclude={value.map((l) => l.productId)} onPick={(o) => { learn(o); onChange([...value, { productId: o.id, qty: 1 }]); }} />
    </div>
  );
}

interface PriceRow { productId: number; unitPriceCents: number }

/** 采购方案/预计单价：按申请里的商品逐个填单价（元，最多 6 位小数），存成“分”（最多 4 位小数）。 */
function PricesEditor({ lines, value, onChange, optional }: { lines: PurchaseLine[]; value: PriceRow[]; onChange: (v: PriceRow[]) => void; optional?: boolean }) {
  const [names] = useNames(lines.map((l) => l.productId));
  const [texts, setTexts] = useState<Record<number, string>>({});
  const textOf = (id: number) => texts[id] ?? (value.find((v) => v.productId === id) ? unitYuanText(value.find((v) => v.productId === id)!.unitPriceCents) : '');
  function set(id: number, raw: string) {
    setTexts((cur) => ({ ...cur, [id]: raw }));
    const rest = value.filter((v) => v.productId !== id);
    if (raw.trim() === '') return onChange(rest);
    try { onChange([...rest, { productId: id, unitPriceCents: yuanToPreciseCents(raw.trim()) }]); } catch { onChange(rest); }
  }
  if (lines.length === 0) return <span className="muted">先填采购商品明细</span>;
  return (
    <ul className="pur-lines">
      {lines.map((l) => {
        const n = labelOf(names, l.productId);
        const t = textOf(l.productId);
        const bad = t.trim() !== '' && !value.some((v) => v.productId === l.productId);
        return (
          <li key={l.productId} className="pur-line price">
            <div className="pur-name"><strong>{n.name}</strong><small>{n.code}</small></div>
            <div className="pur-cell"><span>数量</span>{l.qty}{l.unit ?? ''}</div>
            <label className="pur-cell"><span>单价（元）</span><input inputMode="decimal" aria-label={`${n.name}单价（元）`} value={t} placeholder={optional ? '选填' : '必填'} aria-invalid={bad} onChange={(e) => set(l.productId, e.target.value)} /></label>
            <div className="pur-cell"><span>小计</span>{!bad && t.trim() !== '' && value.find((v) => v.productId === l.productId) ? `¥${(Math.round(value.find((v) => v.productId === l.productId)!.unitPriceCents * l.qty) / 100).toFixed(2)}` : bad ? <em className="muted">格式不对</em> : '—'}</div>
          </li>
        );
      })}
    </ul>
  );
}

interface ReceiptRow { productId: number; receivedQty: number; acceptedQty: number }

/** 到货验收：每个商品本次到货数量和合格数量；上面显示已累计验收的数量。 */
function ReceiptEditor({ lines, value, onChange, runId }: { lines: PurchaseLine[]; value: ReceiptRow[]; onChange: (v: ReceiptRow[]) => void; runId?: number }) {
  const [names] = useNames(lines.map((l) => l.productId));
  const [sum, setSum] = useState<PurchaseSummary | null>(null);
  useEffect(() => { if (runId) purchaseApi.summary(runId).then(setSum).catch(() => undefined); }, [runId]);
  const seeded = useRef(false);
  const rowOf = (id: number) => value.find((v) => v.productId === id);
  const set = (id: number, p: Partial<ReceiptRow>) => {
    const cur = rowOf(id) ?? { productId: id, receivedQty: 0, acceptedQty: 0 };
    const next = { ...cur, ...p };
    onChange([...value.filter((v) => v.productId !== id), next]);
  };
  // 默认每个商品都带一行（数量 0），办理人只改有到货的
  useEffect(() => {
    if (seeded.current || lines.length === 0) return;
    seeded.current = true;
    if (value.length === 0) onChange(lines.map((l) => ({ productId: l.productId, receivedQty: 0, acceptedQty: 0 })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.length]);
  return (
    <ul className="pur-lines">
      {lines.map((l) => {
        const n = labelOf(names, l.productId);
        const row = rowOf(l.productId);
        const before = sum?.lines.find((x) => x.productId === l.productId);
        return (
          <li key={l.productId} className="pur-line receipt">
            <div className="pur-name"><strong>{n.name}</strong><small>申请 {l.qty}{l.unit ?? ''}{before && before.received !== null ? ` · 已累计到货 ${before.received}、合格 ${before.accepted}` : ''}</small></div>
            <label className="pur-cell"><span>本次到货</span><input type="number" min={0} step="any" inputMode="decimal" aria-label={`${n.name}本次到货数量`} value={row?.receivedQty ?? 0} onChange={(e) => { const q = e.target.value === '' ? 0 : Number(e.target.value); set(l.productId, { receivedQty: q, acceptedQty: !row || row.acceptedQty === row.receivedQty ? q : Math.min(row.acceptedQty, q) }); }} /></label>
            <label className="pur-cell"><span>其中合格</span><input type="number" min={0} step="any" inputMode="decimal" aria-label={`${n.name}本次合格数量`} value={row?.acceptedQty ?? 0} onChange={(e) => set(l.productId, { acceptedQty: e.target.value === '' ? 0 : Number(e.target.value) })} /></label>
            <div className="pur-cell"><span>不合格</span>{Math.max(0, Math.round(((row?.receivedQty ?? 0) - (row?.acceptedQty ?? 0)) * 10000) / 10000)}</div>
          </li>
        );
      })}
    </ul>
  );
}

/** 采购流程里“结构化清单”字段（商品明细、单价、验收数量）的编辑器；其余字段走通用控件。 */
export function PurchaseJsonField({ field, values, context, onChange }: {
  field: FieldDef; values: Record<string, unknown>; context?: Record<string, unknown>; onChange: (v: unknown) => void;
}) {
  const asLines = (v: unknown) => (Array.isArray(v) ? (v as PurchaseLine[]) : []);
  const arr = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  if (field.key === 'estimates') return <PricesEditor optional lines={asLines(values.lines)} value={arr<PriceRow>(values[field.key])} onChange={onChange} />;
  if (field.key === 'prices') return <PricesEditor lines={asLines(context?.lines)} value={arr<PriceRow>(values[field.key])} onChange={onChange} />;
  if (field.key === 'lines' && context?.lines) return <ReceiptEditor runId={typeof context._runId === 'number' ? context._runId : undefined} lines={asLines(context.lines)} value={arr<ReceiptRow>(values[field.key])} onChange={onChange} />;
  if (field.key === 'lines') return <LinesEditor value={arr<PurchaseLine>(values[field.key])} onChange={onChange} />;
  return <span className="muted">不支持编辑</span>;
}
