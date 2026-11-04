import { ImagePlus } from 'lucide-react';
import { ImageCropDialog } from './ImageCropDialog';
import { useEffect, useRef, useState } from 'react';
import type { FieldDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { resourceApi, type FileInfo } from './api';
import { PhoneUploadDialog } from './PhoneUploadDialog';

function size(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 单个文件：图片显示缩略图，其他显示文件名；点击用临时签名链接在新标签打开。链接按需获取，不长期保存。 */
export function FileThumb({ file, onRemove,removeText }: { file: FileInfo; onRemove?: () => void;removeText?:string }) {
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
      {onRemove && <button type="button" className={removeText?'link-button file-remove file-remove-text':'icon-button file-remove'} aria-label={`移除 ${file.name}`} onClick={onRemove}>{removeText || '✕'}</button>}
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
  const [crop,setCrop]=useState<File|null>(null);
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
    if(field.replacementOnly && list.length!==1){setError('每次请选择一张图片');return;}
    if(field.accept==='image' && Array.from(list).some(file=>!file.type.startsWith('image/'))){setError('只能上传图片');return;}
    if(field.imageCrop==='square'){
      const file=list[0];setError('');if(file.size>10*1024*1024){setError('照片不能超过10MB，请压缩后重试');return;}
      if(valueRef.current.length>=max){setError('请先移除原照片，再上传新照片');return;}
      setCrop(file);if(input.current)input.current.value='';return;
    }
    setBusy(true);
    setError('');
    let ids = field.replacementOnly ? [] : value;
    for (const file of Array.from(list)) {
      if (ids.length >= max) {
        setError(`最多 ${max} 个文件`);
        break;
      }
      const limit=field.maxFileBytes ?? 10*1024*1024;
      if (file.size > limit) {
        setError(`「${file.name}」超过 ${limit/1024/1024} MB，请压缩后再传`);
        continue;
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
    <div className={`files-input${field.replacementOnly ? ' replacement-only' : ''}`}>
      <div className="file-grid">
        {field.replacementOnly && value.length === 0 && <div className="replacement-file-empty"><ImagePlus size={22}/><span>尚未上传</span></div>}
        {value.map((id) => (known[id] ? <FileThumb key={id} file={known[id]} removeText={field.replacementOnly?'删除':undefined} onRemove={() => onChange(value.filter((x) => x !== id))} /> : null))}
      </div>
      {(field.replacementOnly || value.length < max) && (
        <>
          <input
            ref={input}
            type="file"
            hidden
            multiple={!field.replacementOnly && max > 1}
            accept={field.accept === 'image' ? 'image/png,image/jpeg,image/gif,image/webp' : 'image/png,image/jpeg,image/gif,image/webp,application/pdf'}
            onChange={(e) => void pick(e.target.files)}
            aria-label={`上传${field.label}`}
          />
          <button type="button" className="secondary-button" title={`单个文件不超过 ${(field.maxFileBytes ?? 10*1024*1024)/1024/1024} MB`} disabled={busy} onClick={() => input.current?.click()}>
            {field.replacementOnly && <ImagePlus size={14}/>}
            {busy ? '上传中…' : field.replacementOnly ? value.length ? `更换${field.label}` : `上传${field.label}` : `＋ 上传${field.accept === 'image' ? '图片' : '图片/PDF'}（${value.length}/${max}）`}
          </button>
          {field.phoneUpload && !field.replacementOnly && <button type="button" className="secondary-button" onClick={() => setPhone(true)}>手机上传</button>}
          {!field.replacementOnly && <small className="muted"> 单个文件不超过 {(field.maxFileBytes ?? 10*1024*1024)/1024/1024} MB</small>}
        </>
      )}
      {crop&&<ImageCropDialog file={crop} label={field.label} onClose={()=>setCrop(null)} onConfirm={async file=>{
        if(valueRef.current.length>=max)throw new Error('照片已变更，请关闭裁剪后核对');
        const info=await resourceApi.uploadFile(type,field.key,file);
        if(valueRef.current.length>=max)throw new Error('已收到其他照片，请关闭裁剪后核对');
        onKnown(info);const ids=[...valueRef.current,info.id];valueRef.current=ids;onChange(ids);setCrop(null);
      }}/>}
      {error && <div role="alert" className="notice error">{error}</div>}
      {phone && <PhoneUploadDialog type={type} field={field.key} label={field.label} onFiles={addFromPhone} onClose={() => setPhone(false)} />}
    </div>
  );
}
