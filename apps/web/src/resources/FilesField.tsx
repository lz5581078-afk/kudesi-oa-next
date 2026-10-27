import { useEffect, useRef, useState } from 'react';
import type { FieldDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { resourceApi, type FileInfo } from './api';
import { PhoneUploadDialog } from './PhoneUploadDialog';

function size(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 单个文件：图片显示缩略图，其他显示文件名；点击用临时签名链接在新标签打开。链接按需获取，不长期保存。 */
export function FileThumb({ file, onRemove }: { file: FileInfo; onRemove?: () => void }) {
  const isImage = file.mime.startsWith('image/');
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    resourceApi.fileUrl(file.id).then((r) => alive && setSrc(r.url)).catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [file.id, isImage]);

  async function open() {
    if (isImage && src) { setZoom(true); return; } // 图片在页面里放大核对，不跳新标签
    try {
      const r = await resourceApi.fileUrl(file.id);
      window.open(r.url, '_blank', 'noopener');
    } catch {
      setError(true);
    }
  }

  return (
    <div className="file-thumb">
      <button type="button" className="file-open" onClick={open} title={`${file.name}（${size(file.size)}）`}>
        {isImage && src ? <img src={src} alt={file.name} loading="lazy" /> : <span className="file-icon">{isImage ? (error ? '无法加载' : '…') : 'PDF'}</span>}
      </button>
      <span className="file-name">{file.name}</span>
      {zoom && src && (
        <div className="modal-backdrop" role="presentation" onClick={() => setZoom(false)}>
          <div className="modal card image-zoom" role="dialog" aria-label={`查看图片 ${file.name}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') setZoom(false); }}>
            <div className="modal-head between">
              <strong>{file.name}</strong>
              <span className="pill-row">
                <a className="secondary-button" href={src} download={file.name} target="_blank" rel="noopener noreferrer">另存为</a>
                <button type="button" className="secondary-button" autoFocus onClick={() => setZoom(false)}>关闭</button>
              </span>
            </div>
            <div className="modal-body"><img src={src} alt={file.name} style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} /></div>
          </div>
        </div>
      )}
      {onRemove && <button type="button" className="icon-button file-remove" aria-label={`移除 ${file.name}`} onClick={onRemove}>✕</button>}
    </div>
  );
}

export function FileList({ ids, files }: { ids: number[]; files: Record<number, FileInfo> }) {
  const list = ids.map((id) => files[id]).filter(Boolean);
  if (list.length === 0) return <span className="muted">—</span>;
  return <div className="file-grid">{list.map((f) => <FileThumb key={f.id} file={f} />)}</div>;
}

/** 表单里的上传控件：选文件 → 立即上传到服务端（再转存七牛）→ 记下文件 id，保存记录时才绑定。 */
export function FilesInput({ field, type, value, known, onChange, onKnown }: {
  field: FieldDef; type: string; value: number[]; known: Record<number, FileInfo>;
  onChange: (ids: number[]) => void; onKnown: (f: FileInfo) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState(false);
  const max = field.maxFiles ?? 9;
  const valueRef = useRef(value);
  valueRef.current = value;

  /** 手机传上来的图：加进字段，超过上限的不要 */
  function addFromPhone(list: FileInfo[]) {
    let ids = valueRef.current;
    for (const f of list) {
      if (ids.length >= max || ids.includes(f.id)) continue;
      onKnown(f);
      ids = [...ids, f.id];
    }
    valueRef.current = ids;
    onChange(ids);
  }

  async function pick(list: FileList | null) {
    if (!list || list.length === 0) return;
    setBusy(true);
    setError('');
    let ids = value;
    for (const file of Array.from(list)) {
      if (ids.length >= max) {
        setError(`最多 ${max} 个文件`);
        break;
      }
      try {
        const info = await resourceApi.uploadFile(type, field.key, file);
        onKnown(info);
        ids = [...ids, info.id];
        onChange(ids);
      } catch (e) {
        setError(`${file.name}：${e instanceof ApiError ? e.message : '上传失败'}`);
        break;
      }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  }

  return (
    <div className="files-input">
      <div className="file-grid">
        {value.map((id) => (known[id] ? <FileThumb key={id} file={known[id]} onRemove={() => onChange(value.filter((x) => x !== id))} /> : null))}
      </div>
      {value.length < max && (
        <>
          <input
            ref={input}
            type="file"
            hidden
            multiple={max > 1}
            accept={field.accept === 'image' ? 'image/png,image/jpeg,image/gif,image/webp' : 'image/png,image/jpeg,image/gif,image/webp,application/pdf'}
            onChange={(e) => void pick(e.target.files)}
            aria-label={`上传${field.label}`}
          />
          <button type="button" className="secondary-button" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? '上传中…' : `＋ 上传${field.accept === 'image' ? '图片' : '图片/PDF'}（${value.length}/${max}）`}
          </button>
          {field.phoneUpload && <button type="button" className="secondary-button" onClick={() => setPhone(true)}>手机上传</button>}
        </>
      )}
      {error && <div role="alert" className="notice error">{error}</div>}
      {phone && <PhoneUploadDialog type={type} field={field.key} label={field.label} onFiles={addFromPhone} onClose={() => setPhone(false)} />}
    </div>
  );
}
