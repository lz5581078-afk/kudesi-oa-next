import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { purchaseApi, type PurchaseProduct, type PurchaseProducts } from './purchaseApi';

export interface RequestLine { productId: number; qty: number | ''; aliasName?: string; name?: string; unit?: string; code?: string }

/** 凭证上传：选文件即上传，列出已上传的文件名，可移除（还没提交的）。 */
export function EvidenceInput({ runId, ids, onChange, label }: { runId: number; ids: number[]; onChange: (ids: number[]) => void; label: string }) {
  const [names, setNames] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function pick(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setErr('');
    try {
      let next = [...ids];
      for (const f of Array.from(files)) {
        const r = await purchaseApi.upload(runId, f);
        setNames((n) => ({ ...n, [r.id]: r.name }));
        next = [...next, r.id];
      }
      onChange(next);
    } catch (e) { setErr(e instanceof ApiError ? e.message : '上传失败'); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  return (
    <div className="purchase-evidence">
      <span>{label}</span>
      <input ref={input} type="file" multiple accept="image/*,application/pdf" aria-label={label} disabled={busy} onChange={(e) => void pick(e.target.files)} />
      {busy && <span className="muted">上传中…</span>}
      {err && <span role="alert" className="notice error">{err}</span>}
      <ul className="purchase-files">
        {ids.map((id) => <li key={id}>{names[id] ?? `文件 #${id}`} <button type="button" className="link-button" onClick={() => onChange(ids.filter((x) => x !== id))}>移除</button></li>)}
      </ul>
    </div>
  );
}

/** 已提交的凭证：点开取临时地址 */
export function EvidenceLinks({ runId, ids }: { runId: number; ids: number[] }) {
  const [err, setErr] = useState('');
  if (!ids.length) return <span className="muted">无凭证</span>;
  const open = async (id: number) => { try { window.open((await purchaseApi.fileUrl(runId, id)).url, '_blank', 'noopener'); } catch (e) { setErr(e instanceof ApiError ? e.message : '打开失败'); } };
  return <span>{ids.map((id, i) => <button key={id} type="button" className="link-button" onClick={() => void open(id)}>凭证{i + 1}</button>)}{err && <span role="alert" className="muted"> {err}</span>}</span>;
}

/** 发起采购：按分类或关键字找商品，加入清单，填数量；原料有成品名（马甲）时必须选一个。 */
export function PurchaseRequestFields({ values, onChange }: { values: Record<string, unknown>; onChange: (k: string, v: unknown) => void }) {
  const lines = (Array.isArray(values.lines) ? values.lines : []) as RequestLine[];
  const [kw, setKw] = useState('');
  const [cat, setCat] = useState('');
  const [data, setData] = useState<PurchaseProducts | null>(null);
  const [err, setErr] = useState('');
  const picked = useRef(new Map<number, PurchaseProduct>());
  /** 界面显示用的名称和单位（发给服务端的清单只有商品、数量和成品名，其余由服务端按档案补全） */
  const meta = useRef(new Map<number, { name?: string; unit?: string }>());
  for (const l of lines) if (l.name && !meta.current.has(l.productId)) meta.current.set(l.productId, { name: l.name, unit: l.unit });
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => { purchaseApi.products({ keyword: kw.trim() || undefined, categoryId: cat ? Number(cat) : undefined }).then((r) => { if (alive) { setData(r); setErr(''); } }).catch((e) => alive && setErr(e instanceof ApiError ? e.message : '加载失败')); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [kw, cat]);
  const set = (next: RequestLine[]) => onChange('lines', next.map((l) => ({ productId: l.productId, qty: l.qty, ...(l.aliasName !== undefined ? { aliasName: l.aliasName } : {}) })));
  const add = (p: PurchaseProduct) => {
    picked.current.set(p.id, p);
    meta.current.set(p.id, { name: p.name, unit: p.unit });
    if (lines.some((l) => l.productId === p.id)) return;
    set([...lines, { productId: p.id, qty: '', ...(p.aliases.length ? { aliasName: '' } : {}) }]);
  };
  const nameOf = (id: number) => meta.current.get(id)?.name ?? `商品 #${id}`;
  const upd = (i: number, patch: Partial<RequestLine>) => set(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const aliasesOf = (id: number) => picked.current.get(id)?.aliases ?? [];
  return (
    <div className="purchase-request wide">
      <h4>采购商品</h4>
      <div className="exclusive-filters">
        <input type="search" placeholder="按名称或编码找商品" aria-label="搜索采购商品" value={kw} onChange={(e) => setKw(e.target.value)} />
        <select aria-label="商品分类" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">全部分类</option>
          {data?.categories.map((c) => <option key={c.id} value={c.id}>{c.parentId ? '　' : ''}{c.name}</option>)}
        </select>
      </div>
      {err && <div role="alert" className="notice error">{err}</div>}
      <div className="exclusive-options">
        {data?.rows.map((p) => (
          <button key={p.id} type="button" className="exclusive-option" aria-pressed={lines.some((l) => l.productId === p.id)} onClick={() => add(p)}>
            <strong>{p.name}</strong><span className="muted">{p.code} · {p.categoryName || '未分类'} · {p.unit || '未设单位'}</span>
            {p.aliases.length > 0 && <span className="muted">成品名：{p.aliases.join('、')}</span>}
          </button>
        ))}
        {data && !data.rows.length && <p className="muted">没有找到可采购的商品。</p>}
      </div>
      {data && data.total > data.rows.length && <p className="muted">共 {data.total} 个，仅显示前 {data.rows.length} 个，请缩小范围。</p>}
      <h4>已选清单（{lines.length}）</h4>
      {!lines.length && <p className="muted">从上面点选商品加入清单。</p>}
      <ul className="purchase-lines">
        {lines.map((l, i) => (
          <li key={l.productId}>
            <strong>{nameOf(l.productId)}</strong>
            {(l.aliasName !== undefined || aliasesOf(l.productId).length > 0) && (
              <label>成品名
                <select aria-label={`${nameOf(l.productId)}成品名`} value={l.aliasName ?? ''} onChange={(e) => upd(i, { aliasName: e.target.value })}>
                  <option value="">（请选择）</option>
                  {aliasesOf(l.productId).map((a) => <option key={a} value={a}>{a}</option>)}
                  {l.aliasName && !aliasesOf(l.productId).includes(l.aliasName) && <option value={l.aliasName}>{l.aliasName}</option>}
                </select>
              </label>
            )}
            <label>数量{meta.current.get(l.productId)?.unit ? `（${meta.current.get(l.productId)!.unit}）` : ''}
              <input type="number" min="0" step="0.0001" aria-label={`${nameOf(l.productId)}数量`} value={l.qty} onChange={(e) => upd(i, { qty: e.target.value === '' ? '' : Number(e.target.value) })} />
            </label>
            <button type="button" className="link-button" onClick={() => set(lines.filter((_, k) => k !== i))}>移除</button>
          </li>
        ))}
      </ul>
      <label>要求到货日期<b className="req"> *</b>
        <input type="date" aria-label="要求到货日期" value={String(values.requestedArrivalAt ?? '')} onChange={(e) => onChange('requestedArrivalAt', e.target.value)} />
      </label>
      <label className="wide">申请说明
        <textarea rows={2} maxLength={500} value={String(values.note ?? '')} onChange={(e) => onChange('note', e.target.value)} />
      </label>
    </div>
  );
}
