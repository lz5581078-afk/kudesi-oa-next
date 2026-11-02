import { useEffect, useRef } from 'react';
import type { LiveProductSnapshot } from '@kudesi/shared';
import { emptyManualProduct, productLabel } from './liveProducts';

/** 每行一个产品；编辑旧名称才转为手填，未改的旧基础编码引用仍保留。 */
export function ManualProductEditor({ products, onChange }: { products: LiveProductSnapshot[]; onChange: (products: LiveProductSnapshot[]) => void }) {
  const inputs = useRef<Array<HTMLInputElement | null>>([]), focusAdded = useRef(false);
  useEffect(() => { if (focusAdded.current) { inputs.current[products.length - 1]?.focus(); focusAdded.current = false; } }, [products.length]);
  return <div className="wide live-field live-room-products-editor" role="group" aria-label="场次产品">
    <span>场次产品（{products.filter((p) => p.id !== null || p.name.trim()).length}/100）</span>
    {products.map((p, i) => <div className="live-room-product-row" key={i}>
      <input ref={(el) => { inputs.current[i] = el; }} aria-label={`场次产品 ${i + 1}`} maxLength={200} placeholder="填写一个产品名称，可带规格" value={productLabel(p)}
        onChange={(e) => onChange(products.map((item, j) => j === i ? { id: null, code: '', name: e.target.value, spec: '' } : item))} />
      <button type="button" className="secondary-button small" aria-label={`移除场次产品 ${i + 1}`} onClick={() => onChange(products.length > 1 ? products.filter((_, j) => j !== i) : [emptyManualProduct()])}>×</button>
    </div>)}
    <button type="button" className="link-button" aria-label="添加场次产品" disabled={products.length >= 100} onClick={() => { focusAdded.current = true; onChange([...products, emptyManualProduct()]); }}>＋ 添加产品</button>
  </div>;
}
