import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { qrMatrix, qrSvgPath } from '../lib/qr';
import { phoneUploadApi, type FileInfo, type PhoneSession } from './api';

export const phoneUploadUrl = (token: string) => `${window.location.origin}/m/upload#${token}`;

/** 电脑端：显示二维码，手机扫码拍照/选图，传上来的图自动加到字段里（每 2.5 秒看一次）。 */
export function PhoneUploadDialog({ type, field, label, onFiles, onClose }: {
  type: string; field: string; label: string; onFiles: (files: FileInfo[]) => void; onClose: () => void;
}) {
  const [session, setSession] = useState<PhoneSession | null>(null);
  const [state, setState] = useState<{ scanned: boolean; uploaded: number; expired: boolean }>({ scanned: false, uploaded: 0, expired: false });
  const [error, setError] = useState('');
  const seen = useRef(new Set<number>());
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const [round, setRound] = useState(0);

  useEffect(() => {
    let alive = true;
    seen.current = new Set();
    setSession(null);
    setState({ scanned: false, uploaded: 0, expired: false });
    setError('');
    phoneUploadApi.create(type, field).then((s) => alive && setSession(s)).catch((e) => alive && setError(e instanceof ApiError ? e.message : '生成二维码失败'));
    return () => { alive = false; };
  }, [type, field, round]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const tick = async () => {
      try {
        const st = await phoneUploadApi.status(session.id);
        if (!alive) return;
        const fresh = st.files.filter((f) => !seen.current.has(f.id));
        fresh.forEach((f) => seen.current.add(f.id));
        if (fresh.length) onFilesRef.current(fresh);
        setState({ scanned: st.scanned, uploaded: st.uploaded, expired: st.expired });
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : '读取上传状态失败');
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [session]);

  const qr = useMemo(() => (session ? qrSvgPath(qrMatrix(phoneUploadUrl(session.token))) : null), [session]);

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card small" role="dialog" aria-modal="true" aria-label={`手机上传${label}`}>
        <div className="modal-head between"><strong>手机上传{label}</strong><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>✕</button></div>
        <div className="modal-body phone-upload-body">
          {error && <div role="alert" className="notice error">{error}</div>}
          {qr && !state.expired && (
            <svg className="phone-upload-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="手机上传二维码" shapeRendering="crispEdges">
              <rect width={qr.size} height={qr.size} fill="#fff" />
              <path d={qr.path} fill="#000" />
            </svg>
          )}
          {session && !state.expired && <p className="muted">用手机相机或微信扫一扫，拍照或选图上传；{session.minutes} 分钟内有效，最多 {session.maxUploads} 张。传好的图会自动出现在表单里。</p>}
          {state.expired && <div className="notice warn">二维码已失效或次数已用完。<button type="button" className="link-button" onClick={() => setRound((n) => n + 1)}>重新生成</button></div>}
          <p role="status">{!session ? '正在生成二维码…' : state.uploaded ? `已收到 ${state.uploaded} 张` : state.scanned ? '手机已打开页面，等待上传…' : '等待手机扫码…'}</p>
        </div>
        <div className="modal-foot"><button type="button" className="primary-button" onClick={onClose}>完成</button></div>
      </div>
    </div>
  );
}
