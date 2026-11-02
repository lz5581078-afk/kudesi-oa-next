import { useEffect, useMemo, useState } from 'react';
import { qrMatrix, qrSvgPath } from '../../lib/qr';
import { copyText } from '../../resources/CopyValue';
import { enrollmentApi, type CreatedEnrollmentInvite, type EnrollmentInvite } from './enrollmentApi';
import './enrollment.css';

const when = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const err = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';

export function EnrollmentInviteDialog({ position, onClose }: { position?: { id: number; name: string }; onClose: () => void }) {
  const [days, setDays] = useState(30);
  const [created, setCreated] = useState<CreatedEnrollmentInvite | null>(null);
  const [rows, setRows] = useState<EnrollmentInvite[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mode = position ? 'position' : 'general';
  const title = position ? `${position.name} · 岗位入职码` : '通用入职码';
  const link = created ? `${window.location.origin}/join#${created.token}` : '';
  const matrix = useMemo(() => link ? qrMatrix(link) : null, [link]);
  const graphic = useMemo(() => matrix ? qrSvgPath(matrix) : null, [matrix]);
  const load = () => enrollmentApi.list().then(setRows).catch(e => setError(err(e)));
  useEffect(() => { void load(); }, []);
  async function generate() {
    setBusy(true); setError(''); setNotice('');
    try { setCreated(await enrollmentApi.create({ mode, ...(position ? { positionId: position.id } : {}), validDays: days })); await load(); }
    catch (e) { setError(err(e)); } finally { setBusy(false); }
  }
  async function revoke(id: number) {
    setBusy(true); setError('');
    try { await enrollmentApi.revoke(id); if (id === created?.id) setCreated(null); await load(); setNotice('该二维码已停用，不能再用于入职。'); }
    catch (e) { setError(err(e)); } finally { setBusy(false); }
  }
  function download() {
    if (!matrix) return;
    const cell = 8, quiet = 4, size = (matrix.length + quiet * 2) * cell;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size); ctx.fillStyle = '#000';
    matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) ctx.fillRect((x + quiet) * cell, (y + quiet) * cell, cell, cell); }));
    const a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = `${position?.name ?? '公司通用'}-入职二维码.png`; a.click();
  }
  const relevant = rows.filter(row => row.mode === mode && (mode === 'general' || row.positionId === position?.id));
  return <div className="modal-backdrop"><section className="modal card enrollment-dialog" role="dialog" aria-modal="true" aria-label={title}>
    <header className="modal-head"><strong>{title}</strong><button type="button" className="icon-button" aria-label="关闭入职二维码" onClick={onClose}>×</button></header>
    <div className="modal-body">
      <p>{position ? `扫码填写姓名、手机号和密码后，自动加入「${position.name}」。` : '扫码填写姓名、手机号和密码，并选择岗位后加入本公司。'}</p>
      <div className="enrollment-generate"><label>二维码有效期<select aria-label="二维码有效期" value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>7天</option><option value={30}>30天</option><option value={90}>90天</option></select></label><button type="button" className="primary-button" disabled={busy} onClick={() => void generate()}>{busy ? '处理中…' : '生成二维码'}</button></div>
      {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice ok" role="status">{notice}</div>}
      {created && graphic && <div className="enrollment-code">
        <svg role="img" aria-label="入职二维码" viewBox={`0 0 ${graphic.size} ${graphic.size}`} width="240" height="240" shapeRendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d={graphic.path} fill="#000"/></svg>
        <strong>{title}</strong><small>有效至 {when(created.expiresAt)}</small>
        <div className="row-actions"><button type="button" className="secondary-button" onClick={download}>下载二维码</button><button type="button" className="secondary-button" onClick={async () => setNotice(await copyText(link) ? '入职链接已复制' : '复制失败，请重试')}>复制入职链接</button></div>
        <p className="muted">有效期内可供多位新员工使用。请发给需要入职的员工；停用后立即失效。</p>
      </div>}
      <details className="enrollment-existing"><summary>已生成的{position ? '本岗位' : '通用'}二维码（{relevant.length}）</summary>
        {relevant.length === 0 ? <p className="muted">还没有生成过二维码。</p> : <ul>{relevant.map(row => <li key={row.id}><div><strong>入职码 #{row.id}</strong><small>有效至 {when(row.expiresAt)}</small></div>{row.status === 'active' ? <button type="button" className="link-button danger-text" disabled={busy} onClick={() => void revoke(row.id)}>停用</button> : <span className="muted">{row.status === 'revoked' ? '已停用' : '已过期'}</span>}</li>)}</ul>}
      </details>
    </div><footer className="modal-foot"><button type="button" className="secondary-button" onClick={onClose}>关闭</button></footer>
  </section></div>;
}
