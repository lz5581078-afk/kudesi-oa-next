import { useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { sessionApi, type VoucherFile } from './sessionApi';

const MAX = 10;
const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export async function openVoucher(id: number): Promise<void> {
  const r = await sessionApi.voucherUrl(id);
  window.open(r.url, '_blank', 'noopener');
}

/** 提现凭证：上传图片/PDF、直接粘贴截图、或让授权电脑的助手截取当前店铺窗口。只读模式只显示和查看。 */
export function VoucherPanel({ files, onChange, shopId, readOnly }: { files: VoucherFile[]; onChange?: (f: VoucherFile[]) => void; shopId?: number | null; readOnly?: boolean }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const fail = (e: unknown) => setError(e instanceof ApiError || e instanceof Error ? e.message : '操作失败');
  const add = (f: VoucherFile) => onChange?.([...files, f]);

  const uploadAll = async (list: File[]) => {
    setError('');
    if (files.length + list.length > MAX) return setError(`每笔提现最多 ${MAX} 个凭证文件`);
    setBusy('正在上传…');
    try {
      let cur = files;
      for (const f of list) { const info = await sessionApi.uploadVoucher(f); cur = [...cur, info]; onChange?.(cur); }
    } catch (e) { fail(e); } finally { setBusy(''); }
  };

  const capture = async () => {
    if (!shopId) return;
    setError('');
    setBusy('已通知店铺所在电脑截图，请稍候…');
    try {
      const { id } = await sessionApi.capture(shopId);
      const until = Date.now() + 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await sessionApi.requestStatus(id);
        if (st.status === 'succeeded' && st.file) { add(st.file); break; }
        if (['failed', 'cancelled', 'expired'].includes(st.status)) throw new Error(st.errorText || '截图没有成功');
        if (Date.now() > until) throw new Error('等了 60 秒助手还没有回应，请确认那台电脑的助手在线');
      }
    } catch (e) { fail(e); } finally { setBusy(''); }
  };

  return (
    <div className="voucher-panel" tabIndex={0} aria-label="提现凭证"
      onPaste={(e) => { if (readOnly) return; const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); void uploadAll(imgs); } }}>
      <div className="between"><strong>提现凭证</strong><span className="muted">{files.length}/{MAX}</span></div>
      {files.length === 0 && <p className="muted">{readOnly ? '没有上传凭证' : '上传平台提现成功的页面截图（点这里后可直接 Ctrl+V 粘贴截图）'}</p>}
      <ul className="stack">
        {files.map((f) => (
          <li key={f.id} className="between">
            <span>{f.name} <span className="muted">{sizeText(f.size)}</span></span>
            <span className="row-actions">
              <button type="button" className="link-button" onClick={() => openVoucher(f.id).catch(fail)}>查看</button>
              {!readOnly && <button type="button" className="link-button" onClick={() => onChange?.(files.filter((x) => x.id !== f.id))}>移除</button>}
            </span>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className="row-actions">
          <input ref={input} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" aria-label="选择凭证文件" onChange={(e) => { const l = Array.from(e.target.files ?? []); e.target.value = ''; if (l.length) void uploadAll(l); }} />
          <button type="button" className="secondary-button small" disabled={!!busy} onClick={() => input.current?.click()}>上传图片/PDF</button>
          {shopId ? <button type="button" className="secondary-button small" disabled={!!busy} onClick={() => void capture()}>从店铺窗口截图</button> : null}
        </div>
      )}
      {busy && <div role="status" className="muted">{busy}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
    </div>
  );
}
