import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';

interface Snap { id: number; name: string; remark: string; auto: boolean; categoryCount: number; itemCount: number; createdAt: string; restoredAt: string | null }
interface View { id: number; name: string; categories: string[]; items: Array<{ code: string; name: string; category: string; status: string }> }
const when = (s: string) => new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const base = '/finance/fee-archive/snapshots';

/** 费用档案存档表：把当前费用类别和费用项目存成历史包，可查看、恢复（恢复前自动再存一份）、删除。 */
export function FeeSnapshotsDialog({ canWrite, canDelete, onClose, onRestored }: { canWrite: boolean; canDelete: boolean; onClose: () => void; onRestored: () => void }) {
  const [rows, setRows] = useState<Snap[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [name, setName] = useState('');
  const [remark, setRemark] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try { setRows(await api<Snap[]>(base)); } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(''); setNotice('');
    try { await fn(); if (done) setNotice(done); await load(); } catch (e) { setError(e instanceof ApiError ? e.message : '操作失败'); }
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal wide card" role="dialog" aria-label="费用档案存档表">
        <div className="modal-head"><strong>费用档案存档表</strong></div>
        <div className="modal-body">
          <p className="muted">把当前费用类别和费用项目存成历史包，以后可以查看或恢复。恢复前系统会自动保存一份当前状态；存档里没有的费用会被停用（不会删除）。</p>
          {error && <div role="alert" className="notice error">{error}</div>}
          {notice && <div role="status" className="notice ok">{notice}</div>}
          {canWrite && (
            <div className="toolbar">
              <input aria-label="存档名称" placeholder="存档名称，如“2026 年初整理前”" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              <input aria-label="存档备注" placeholder="备注（选填）" value={remark} maxLength={500} onChange={(e) => setRemark(e.target.value)} />
              <button type="button" className="primary-button" disabled={!name.trim()} onClick={() => void run(async () => { await api(base, { method: 'POST', body: { name, remark: remark || undefined } }); setName(''); setRemark(''); }, '已存档')}>存为历史包</button>
            </div>
          )}
          <table className="data-table">
            <thead><tr><th>存档名称</th><th>存档时间</th><th>分类数</th><th>费用数</th><th>备注</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="muted">暂无存档，可以先把当前费用档案存成一个历史包。</td></tr>}
              {rows.map((r) => (
                <tr key={r.id}><td>{r.name}{r.auto ? <span className="chip muted">自动</span> : null}</td><td>{when(r.createdAt)}</td><td>{r.categoryCount}</td><td>{r.itemCount}</td><td>{r.remark || '-'}</td>
                  <td className="row-actions">
                    <button type="button" className="link-button" onClick={() => void run(async () => setView(await api<View>(`${base}/${r.id}`)))}>查看</button>
                    {canWrite && <button type="button" className="link-button" onClick={() => { if (window.confirm(`恢复到「${r.name}」？恢复前会自动存一份当前状态；存档里没有的费用项目和类别会被停用。`)) void run(async () => { const x = await api<{ restored: number; stopped: number }>(`${base}/${r.id}/restore`, { method: 'POST', body: {} }); setNotice(`已恢复 ${x.restored} 条，停用 ${x.stopped} 条`); onRestored(); }); }}>恢复</button>}
                    {canDelete && <button type="button" className="link-button danger" onClick={() => { if (window.confirm(`删除存档「${r.name}」？`)) void run(() => api(`${base}/${r.id}`, { method: 'DELETE' })); }}>删除</button>}
                  </td></tr>
              ))}
            </tbody>
          </table>
          {view && (
            <div className="card">
              <strong>「{view.name}」里有 {view.categories.length} 个类别、{view.items.length} 个费用项目</strong>
              <div className="table-scroll" style={{ maxHeight: 260 }}><table className="data-table" aria-label="存档内容">
                <thead><tr><th>编号</th><th>名称</th><th>类别</th><th>状态</th></tr></thead>
                <tbody>{view.items.slice(0, 300).map((i) => <tr key={i.code + i.name}><td>{i.code}</td><td>{i.name}</td><td>{i.category}</td><td>{i.status === 'active' ? '启用' : '停用'}</td></tr>)}</tbody>
              </table></div>
              {view.items.length > 300 && <p className="muted">只显示前 300 项。</p>}
            </div>
          )}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></div>
      </div>
    </div>
  );
}
