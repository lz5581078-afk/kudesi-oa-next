import { useState } from 'react';
import { ApiError } from '../../api/client';
import type { FileInfo } from '../../resources/api';
import { financeApi, type DocDetailDto } from './financeApi';
import { money } from './common';

/** 已在系统外付出的款项只补登记往来余额，不再扣银行。 */
export function OpeningPrepaymentDialog({ doc, onClose, onSaved }: { doc: DocDetailDto; onClose: () => void; onSaved: (d: DocDetailDto) => void }) {
  const [reason, setReason] = useState('');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fail = (e: unknown) => setError(e instanceof ApiError || e instanceof Error ? e.message : '操作失败');

  async function upload(list: File[]) {
    setError('');
    if (files.length + list.length > 10) return setError('最多上传 10 个凭证附件');
    setBusy(true);
    try {
      for (const file of list) {
        const info = await financeApi.uploadOpeningVoucher(doc.id, file);
        setFiles((current) => [...current, info]);
      }
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="登记已有预付款余额" onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !reason.trim() || !files.length || !confirmed) return;
        setBusy(true); setError('');
        try { onSaved(await financeApi.registerOpeningPrepayment(doc.id, { reason: reason.trim(), fileIds: files.map((f) => f.id), confirmed })); }
        catch (x) { fail(x); } finally { setBusy(false); }
      }}>
        <div className="modal-head between"><strong>登记已有预付款余额</strong><button type="button" className="icon-button" aria-label="关闭登记" disabled={busy} onClick={onClose}>×</button></div>
        <div className="modal-body">
          <p>{doc.docNo} · {doc.partyName} · {money(doc.amountCents)}</p>
          <p className="notice">用于登记上线前已经付给供应商的款项。登记后增加供应商预付余额，不扣银行或现金余额。</p>
          <label>核对说明（必填）<textarea required maxLength={500} rows={3} disabled={busy} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label>凭证附件（至少 1 个，最多 10 个，每个不超过 10MB）<input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" disabled={busy} onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ''; if (list.length) void upload(list); }} /></label>
          <ul className="stack">{files.map((f) => <li key={f.id} className="between"><span>{f.name}</span><button type="button" className="link-button" disabled={busy} aria-label={`移除 ${f.name}`} onClick={() => setFiles((current) => current.filter((x) => x.id !== f.id))}>移除</button></li>)}</ul>
          <label><input type="checkbox" disabled={busy} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我已核对：款项已在系统上线前付出，本次仅登记预付余额，不再扣银行余额。</label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !reason.trim() || !files.length || !confirmed}>{busy ? '处理中…' : '确认登记'}</button></div>
      </form>
    </div>
  );
}
