import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { resourceApi } from './api';

interface Pending { id: number; title: string; creditCode: string }

/** 列出还没有税务资料的营业执照，一键按执照信息生成（类别默认「经营税务」，税种待确认）。 */
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
      const taken = new Set(tax.items.map((t) => Number(t.data.licenseId)));
      setRows(lic.items.filter((l) => !taken.has(l.id)).map((l) => ({ id: l.id, title: l.title, creditCode: String(l.data.creditCode ?? '') })));
      setError('');
    } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
  }
  useEffect(() => { void load(); }, []);
  async function gen(r: Pending) {
    setBusyId(r.id);
    try {
      await resourceApi.create('tax-profiles', { taxCategory: 'operation', licenseId: r.id, taxpayerName: r.title, taxpayerNo: r.creditCode, taxType: 'pending' });
      onCreated();
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '生成失败'); }
    setBusyId(null);
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
              <span>{r.title}<small className="muted"> {r.creditCode}</small></span>
              <button type="button" className="link-button" disabled={busyId === r.id} onClick={() => void gen(r)}>生成</button>
            </div>
          ))}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}
