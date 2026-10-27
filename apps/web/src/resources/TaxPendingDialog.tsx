import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { resourceApi } from './api';

interface Pending { id: number; title: string; creditCode: string; category: 'operation' | 'ecommerce' }

/** 列出还没有对应类别税务资料的营业执照（类别跟随执照：经营/电商），可逐张或全部按执照信息生成，税种待确认。 */
export function TaxPendingDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [rows, setRows] = useState<Pending[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  async function load() {
    try {
      const [lic, tax] = await Promise.all([
        resourceApi.list('licenses', { pageSize: 200 }),
        resourceApi.list('tax-profiles', { pageSize: 200, showHidden: true }),
      ]);
      const taken = new Set(tax.items.map((t) => `${Number(t.data.licenseId)}:${String(t.data.taxCategory ?? 'operation')}`));
      const cat = (l: { data: Record<string, unknown> }): 'operation' | 'ecommerce' => (l.data.category === 'ecommerce' ? 'ecommerce' : 'operation');
      setRows(lic.items.filter((l) => !taken.has(`${l.id}:${cat(l)}`)).map((l) => ({ id: l.id, title: l.title, creditCode: String(l.data.creditCode ?? ''), category: cat(l) })));
      setError('');
    } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
  }
  useEffect(() => { void load(); }, []);
  async function gen(r: Pending) {
    setBusyId(r.id);
    try {
      await resourceApi.create('tax-profiles', { taxCategory: r.category, licenseId: r.id, taxpayerName: r.title, taxpayerNo: r.creditCode, taxType: 'pending' });
      onCreated();
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '生成失败'); }
    setBusyId(null);
  }
  async function genAll() {
    for (const r of rows ?? []) {
      setBusyId(r.id);
      try {
        await resourceApi.create('tax-profiles', { taxCategory: r.category, licenseId: r.id, taxpayerName: r.title, taxpayerNo: r.creditCode, taxType: 'pending' });
      } catch (e) { setError(`${r.title}：${e instanceof ApiError ? e.message : '生成失败'}`); setBusyId(null); onCreated(); await load(); return; }
    }
    setBusyId(null);
    onCreated();
    await load();
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="待生成税务资料">
        <div className="modal-head"><strong>待生成税务资料</strong></div>
        <div className="modal-body">
          <p className="muted">下面的营业执照还没有税务资料。点「生成」会按执照名称和信用代码建一条，税种先记为“待确认”，之后再补全。</p>
          {error && <div role="alert" className="notice error">{error}</div>}
          {rows === null && !error && <p className="muted">加载中…</p>}
          {rows?.length === 0 && <p className="muted">所有执照都已有税务资料。</p>}
          {rows?.map((r) => (
            <div key={r.id} className="line-item between">
              <span>{r.title}<small className="muted"> {r.category === 'ecommerce' ? '电商税务' : '经营税务'} {r.creditCode}</small></span>
              <button type="button" className="link-button" disabled={busyId === r.id} onClick={() => void gen(r)}>生成</button>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          {!!rows?.length && <button type="button" className="secondary-button" disabled={busyId !== null} onClick={() => void genAll()}>全部生成（{rows.length}）</button>}
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
