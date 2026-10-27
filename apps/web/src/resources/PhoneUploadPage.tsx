import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { phoneUploadApi } from './api';

/**
 * 手机扫码后打开的临时页面（免登录）：令牌在网址的 # 后面（不会被服务器日志记下）。
 * 页面只知道要传什么、还能传几张；上传成功后电脑上的表单自动出现图片。
 */
export function PhoneUploadPage() {
  const token = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  const [info, setInfo] = useState<{ label: string; resource: string; remaining: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  const camera = useRef<HTMLInputElement>(null);
  const album = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) { setError('二维码无效，请回到电脑上重新生成'); return; }
    phoneUploadApi.inspect(token).then(setInfo).catch((e) => setError(e instanceof ApiError ? e.message : '打开失败，请重试'));
  }, [token]);

  async function pick(list: FileList | null) {
    if (!list?.length || !info) return;
    setBusy(true);
    setError('');
    let remaining = info.remaining;
    for (const file of Array.from(list)) {
      if (remaining <= 0) { setError('本次能传的张数已用完'); break; }
      try {
        const r = await phoneUploadApi.upload(token, file);
        remaining = r.remaining;
        setDone((d) => [...d, file.name]);
        setInfo((cur) => (cur ? { ...cur, remaining: r.remaining } : cur));
      } catch (e) {
        setError(`${file.name}：${e instanceof ApiError ? e.message : '上传失败，请重试'}`);
        break;
      }
    }
    setBusy(false);
    if (camera.current) camera.current.value = '';
    if (album.current) album.current.value = '';
  }

  const dead = !!error && !info;
  return (
    <main className="phone-upload-page">
      <h1>手机上传</h1>
      {info && <p>{info.resource} · {info.label}，还能传 {info.remaining} 张</p>}
      {dead && <div role="alert" className="notice error">{error}</div>}
      {info && (
        <>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden aria-label="拍照" onChange={(e) => void pick(e.target.files)} />
          <input ref={album} type="file" accept="image/*" multiple hidden aria-label="从相册选图" onChange={(e) => void pick(e.target.files)} />
          <div className="phone-upload-actions">
            <button type="button" className="primary-button" disabled={busy || info.remaining <= 0} onClick={() => camera.current?.click()}>拍照上传</button>
            <button type="button" className="secondary-button" disabled={busy || info.remaining <= 0} onClick={() => album.current?.click()}>从相册选择</button>
          </div>
          {busy && <p role="status">上传中…</p>}
          {!dead && error && <div role="alert" className="notice error">{error}</div>}
          {done.length > 0 && <ul className="plain-list">{done.map((n, i) => <li key={i}>已上传：{n}</li>)}</ul>}
          {done.length > 0 && <p className="muted">传好的图片已经自动出现在电脑的表单里，可以关闭本页。</p>}
        </>
      )}
    </main>
  );
}
