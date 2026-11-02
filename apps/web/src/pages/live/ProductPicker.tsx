import { useEffect, useState } from 'react';
import { liveApi, type Product } from './liveApi';
import { errText } from './liveFormat';

export const productText = (products?: Product[]) => products?.map((p) => `${p.name || p.code}${p.spec ? `（${p.spec}）` : ''}`).join('、') || '未选择';

export function ProductPicker({ picked, onChange }: { picked: Product[]; onChange: (products: Product[]) => void }) {
  const [keyword, setKeyword] = useState('');
  const [found, setFound] = useState<Product[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const t = setTimeout(() => {
      liveApi.products(keyword.trim()).then((rows) => { if (active) { setFound(rows); setError(''); } })
        .catch((e) => { if (active) setError(errText(e, '读取产品失败')); })
        .finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; clearTimeout(t); };
  }, [keyword]);
  const toggle = (p: Product) => onChange(picked.some((x) => x.id === p.id) ? picked.filter((x) => x.id !== p.id) : picked.length >= 100 ? picked : [...picked, p]);
  return <div className="wide live-field">
    <span>场次产品（{picked.length}/100）</span>
    <input aria-label="搜索产品" type="search" placeholder="按编码或名称搜索" maxLength={50} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
    {error && <small role="alert">{error}，请调整关键词重试。</small>}
    <div className="live-pickbox" aria-label="产品列表">
      {loading ? <p className="muted pad" role="status">正在读取产品…</p> : !error && found.length === 0 ? <p className="muted pad">没有找到产品</p> : found.map((p) => <label key={p.id}><input type="checkbox" checked={picked.some((x) => x.id === p.id)} disabled={picked.length >= 100 && !picked.some((x) => x.id === p.id)} onChange={() => toggle(p)} />{p.code} · {p.name}{p.spec ? ` · ${p.spec}` : ''}</label>)}
    </div>
    {picked.length > 0 && <div className="live-chips" aria-label="已选产品">{picked.map((p) => <button type="button" key={p.id} className="pill" onClick={() => toggle(p)} title="点击移除">{p.name || p.code}{p.spec ? ` · ${p.spec}` : ''} ×</button>)}</div>}
  </div>;
}
