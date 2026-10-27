import { useEffect, useState } from 'react';
import { ApiError } from '../../../api/client';
import { jstApi, type RegenRow } from './jstApi';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message || '操作失败');

/**
 * 改了命名规则之后：列出按新规则会变的编码/名称（只预览），选哪些、写原因、确认后才改。
 * 已验证的会回到“需重新验证”；上传过聚水潭的，下次同步会按“改码”处理。
 */
export function BundleRegenDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<RegenRow[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [reason, setReason] = useState('');
  const [ok, setOk] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => jstApi.regenPreview().then((r) => { setRows(r.rows); setPicked([]); setOk(false); }).catch((e) => setError(msg(e)));
  useEffect(() => { void load(); }, []);
  const usable = (rows ?? []).filter((r) => !r.error && !r.blocked);
  async function run() {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await jstApi.regenExecute((rows ?? []).filter((x) => picked.includes(x.id)).map((x) => ({ id: x.id, token: x.token })), reason.trim());
      const bad = r.results.filter((x) => !x.ok);
      setNotice(`已重新生成 ${r.done} 个${bad.length ? `，${bad.length} 个没成功：${bad.map((x) => x.error).join('；')}` : ''}`);
      onDone(); await load();
    } catch (e) { setError(msg(e)); }
    setBusy(false);
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card wide" role="dialog" aria-label="按新规则批量重生成编码">
        <div className="modal-head between"><strong>按新命名规则重生成编码</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          {notice && <div role="status" className="notice ok">{notice}</div>}
          <p className="muted">下面是按“现在的命名规则”重新算出来、和已有不一样的组合（手改过编码的不会变）。不会自动修改，选好、写原因、确认后才执行。</p>
          <div className="table-scroll"><table className="data-table">
            <thead><tr><th style={{ width: 28 }}><input type="checkbox" aria-label="全选" checked={usable.length > 0 && picked.length === usable.length} onChange={(e) => setPicked(e.target.checked ? usable.map((r) => r.id) : [])} /></th><th>现在的编码 / 名称</th><th>新的编码 / 名称</th><th>提醒</th></tr></thead>
            <tbody>
              {rows?.length === 0 && <tr><td colSpan={4} className="muted center">所有组合的编码都和现在的规则一致</td></tr>}
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" aria-label={`选择 ${r.oldCode}`} disabled={!!r.error || !!r.blocked} checked={picked.includes(r.id)} onChange={(e) => { setOk(false); setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id)); }} /></td>
                  <td>{r.oldCode}<div className="muted">{r.oldName}</div></td>
                  <td><strong>{r.newCode}</strong><div className="muted">{r.newName}</div></td>
                  <td>
                    {r.error && <div className="bad-text">{r.error}</div>}
                    {r.blocked && <div className="bad-text">{r.blocked}，暂不能改</div>}
                    {r.status === 'verified' && !r.error && !r.blocked && <div className="muted">已验证，改完回到“需重新验证”</div>}
                    {r.uploadedCode && <div className="warn-text">已上传聚水潭（{r.uploadedCode}），之后同步会走“改码”</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {picked.length > 0 && (
            <div className="form-grid">
              <label className="wide">重生成原因<b className="req"> *</b><textarea aria-label="重生成原因" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              <label className="check wide"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> 我已核对以上 {picked.length} 个组合的新编码和名称</label>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>关闭</button>
          <button type="button" className="primary-button" disabled={busy || picked.length === 0 || !ok || reason.trim().length < 2} onClick={() => void run()}>重新生成 {picked.length || ''}</button>
        </div>
      </div>
    </div>
  );
}
