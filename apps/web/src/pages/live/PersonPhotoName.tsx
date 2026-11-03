import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Modal } from './liveUi';
import { errText } from './liveFormat';
import './personPhoto.css';
export interface PersonPhoto {
  userId: number;
  name: string;
  photo: { url: string; expiresIn: number; name: string; mime: string } | null;
}
export const personPhotoApi = {
  read: (id: number) => api<PersonPhoto>(`/live/people/${id}/photo`),
};
/** 按员工编号读取，点击时才申请短期照片链接，不加载人事附件或工资。 */
export function PersonPhotoName({
  personId,
  name,
}: {
  personId?: number;
  name: string;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<PersonPhoto | null>(null),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const valid = Number.isSafeInteger(personId) && Number(personId) > 0;
  useEffect(() => {
    if (!open || !valid) return;
    let alive = true;
    setData(null);
    setError('');
    personPhotoApi
      .read(personId!)
      .then((x) => {
        if (alive) setData(x);
      })
      .catch((e) => {
        if (alive) setError(errText(e, '照片读取失败'));
      });
    return () => {
      alive = false;
    };
  }, [open, personId, valid, retry]);
  if (!valid) return <>{name}</>;
  const current = data?.userId === personId ? data : null;
  return (
    <span
      className="live-person-photo-trigger"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="live-person-photo-name"
        title={`查看${name}的人员照片`}
        aria-label={`查看${name}照片`}
        onClick={(e) => {
          e.stopPropagation();
          setData(null);
          setError('');
          setOpen(true);
        }}
      >
        {name}
      </button>
      {open && (
        <Modal
          title={`${name} · 人员照片`}
          onClose={() => setOpen(false)}
          size="small"
        >
          <div className="live-person-photo-view">
            {error ? (
              <>
                <p role="alert" className="notice error">
                  {error}
                </p>
                <button type="button" onClick={() => setRetry((v) => v + 1)}>
                  重新读取照片
                </button>
              </>
            ) : !current ? (
              <p role="status">正在读取照片…</p>
            ) : current.photo ? (
              <img
                src={current.photo.url}
                alt={`${current.name}的人员照片`}
                onError={() => setError('照片加载失败，请重新读取')}
              />
            ) : (
              <p className="muted">尚未上传人员照片，请联系人事维护。</p>
            )}
          </div>
        </Modal>
      )}
    </span>
  );
}
