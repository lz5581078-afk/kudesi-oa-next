import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { CopyButton } from './CopyValue';

interface Preview { code: string; manual: boolean; notes: string[]; basicInfoFullName: string }
const numOrUndef = (v: unknown) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v));
const intOrUndef = (v: unknown) => { const n = numOrUndef(v); return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined; };
const txt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 商品编码实时预览（旧系统同款）：填名称、分类、品牌、规格时，随时看到保存后会得到的编码；服务端按保存时的同一套规则算。 */
export function CodePreview({ values, excludeId, onPreview, onFullName, quiet = false }: { values: Record<string, unknown>; excludeId?: number; onPreview?: (code: string) => void; onFullName?: (name: string) => void; quiet?: boolean }) {
  const [res, setRes] = useState<Preview | null>(null);
  const [err, setErr] = useState('');
  const body = {
    archiveType: txt(values.archiveType), supplyMode: txt(values.supplyMode), categoryId: intOrUndef(values.categoryId), brandId: intOrUndef(values.brandId),
    name: txt(values.name), specQty: numOrUndef(values.specQty), specUnit: txt(values.specUnit), shape: txt(values.shape), code: txt(values.code), materialCode: txt(values.materialCode), capacities: txt(values.capacities), dimensions: txt(values.dimensions), dimensionUnit: txt(values.dimensionUnit), productPackagingSpec: txt(values.productPackagingSpec), productPackagingUnit: txt(values.productPackagingUnit), excludeId,
  };
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!body.archiveType || !body.name) { setRes(null); setErr(''); return; }
    let alive = true;
    const t = setTimeout(() => {
      api<Preview>('/finance/products/code-preview', { method: 'POST', body }).then((r) => { if (alive) { setRes(r); setErr(''); onPreview?.(r.code); onFullName?.(r.basicInfoFullName); } })
        .catch((e) => { if (alive) { setRes(null); setErr(e instanceof Error && e.message ? e.message : '编码预览失败'); } });
    }, 450);
    return () => { alive = false; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (err) return <div className="notice error" role="status" aria-label="编码预览">{err}</div>;
  if (quiet || !res) return null;
  return (
    <div className="notice code-preview" role="status" aria-label="编码预览">
      <div>{res.manual ? '使用你填写的编码' : '保存后将生成编码'}：<strong className="mono">{res.code}</strong> <CopyButton value={res.code} label="预览编码" /></div>
      {res.basicInfoFullName && <div className="muted">基础信息全称：{res.basicInfoFullName}</div>}
      {res.notes.map((n) => <div key={n} className="muted">{n}</div>)}
    </div>
  );
}
