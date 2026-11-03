import { useRef, useState } from 'react';
import { ImageCropDialog } from '../../resources/ImageCropDialog';
import { PhoneUploadDialog } from '../../resources/PhoneUploadDialog';
import { resourceApi, type FileInfo } from '../../resources/api';
import { errText } from './liveFormat';

/** 沿用档案的上传与保存权限；只提交人员照片字段。 */
export function PersonPhotoUpload({
  recordId,
  onSaved,
  onCropChange,
}: {
  recordId: number;
  onSaved: () => void;
  onCropChange: (open: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null),
    saving = useRef(false);
  const [crop, setCrop] = useState<File | null>(null),
    [phone, setPhone] = useState(false);
  const [pending, setPending] = useState<FileInfo | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function save(info: FileInfo) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setPending(info);
    setError('');
    try {
      await resourceApi.update('workforce', recordId, { photo: [info.id] });
      setPending(null);
      setPhone(false);
      onSaved();
    } catch (e) {
      setError(errText(e, '照片保存失败，请重试'));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="live-person-photo-upload">
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp"
        aria-label="选择人员照片"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setError('');
          if (file.size > 10 * 1024 * 1024) {
            setError('照片不能超过10MB');
            return;
          }
          setCrop(file);
          onCropChange(true);
        }}
      />
      {!pending && !phone && (
        <div className="live-person-photo-upload-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            电脑上传
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => setPhone(true)}
          >
            手机扫码
          </button>
        </div>
      )}
      {!pending && !phone && (
        <small className="muted">支持裁剪，上传后自动保存</small>
      )}
      {phone && (
        <PhoneUploadDialog
          inline
          type="workforce"
          field="photo"
          label="人员照片"
          onClose={() => setPhone(false)}
          onFiles={(files) => {
            if (files[0]) void save(files[0]);
          }}
        />
      )}
      {busy && <p role="status">正在保存照片…</p>}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {pending && !busy && (
        <button
          type="button"
          className="primary-button"
          onClick={() => void save(pending)}
        >
          重试保存照片
        </button>
      )}
      {crop && (
        <ImageCropDialog
          file={crop}
          label="人员照片"
          onClose={() => {
            setCrop(null);
            onCropChange(false);
          }}
          onConfirm={async (file) => {
            const info = await resourceApi.uploadFile(
              'workforce',
              'photo',
              file,
            );
            setCrop(null);
            onCropChange(false);
            await save(info);
          }}
        />
      )}
    </div>
  );
}
