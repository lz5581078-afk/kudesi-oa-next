import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';

/** 从营业执照直接把已有店铺关联过来（旧系统“关联已有店铺”）：可搜索多选，已属于其他执照的要勾选确认后转移。 */
export function LinkExistingStoresButton({ license, onDone, onError }: {
  license: ResourceDto; onDone: () => void; onError: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [stores, setStores] = useState<ResourceDto[] | null>(null);
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      resourceApi.list('stores', { pageSize: 100, keyword: q || undefined }).then((r) => setStores(r.items.filter((s) => s.data.licenseId !== license.id)))
        .catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
    }, 200);
    return () => clearTimeout(t);
  }, [open, q, license.id]);
  const transfers = (stores ?? []).filter((s) => chosen.has(s.id) && s.data.licenseId);
  async function save() {
    if (!chosen.size) return setError('请至少选择一个店铺。');
    if (transfers.length && !confirm) return setError('所选店铺里有已关联其他营业执照的，请勾选下方确认后再保存。');
    setBusy(true); setError('');
    const failures: string[] = [];
    for (const s of (stores ?? []).filter((x) => chosen.has(x.id))) {
      try { await resourceApi.update('stores', s.id, { licenseId: license.id }); } catch (e) { failures.push(`${s.title}：${e instanceof ApiError ? e.message : '失败'}`); }
    }
    setBusy(false);
    if (failures.length) { setError(`有 ${failures.length} 个店铺没有关联成功：${failures.join('；')}`); onDone(); return; }
    setOpen(false); setChosen(new Set()); onDone();
  }
  if (!open) return <button type="button" className="secondary-button" onClick={() => setOpen(true)}>关联已有店铺</button>;
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card" role="dialog" aria-label="关联已有店铺">
        <div className="modal-head"><strong>关联已有店铺</strong></div>
        <div className="modal-body">
          <p className="muted">选择的店铺会改为属于「{license.title}」。已属于其他营业执照的店铺会转移，操作写入店铺记录。</p>
          <input type="search" aria-label="搜索店铺" placeholder="搜索平台、店铺名称、店铺编号" value={q} onChange={(e) => setQ(e.target.value)} />
          <div role="group" aria-label="可关联的店铺">
            {stores?.length === 0 && <p className="muted">没有匹配的店铺。</p>}
            {stores?.map((s) => (
              <label key={s.id} className="line-item">
                <input type="checkbox" checked={chosen.has(s.id)} onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} />
                <span>{s.title}<small className="muted"> {String(s.data.storeNo ?? '')} {s.data.licenseId ? `· 现属于：${s.refLabels.licenseId ?? '其他营业执照'}` : '· 未关联营业执照'}</small></span>
              </label>
            ))}
          </div>
          {transfers.length > 0 && (
            <label><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> 确认把 {transfers.length} 个已属于其他营业执照的店铺转移到这张执照</label>
          )}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
          <button type="button" className="primary-button" disabled={busy || !chosen.size} onClick={() => void save()}>{busy ? '正在关联…' : `关联 ${chosen.size} 个店铺`}</button>
        </div>
      </div>
    </div>
  );
}
