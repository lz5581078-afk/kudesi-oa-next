import { AnchorMonthPanel } from './AnchorMonthPanel';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PersonPhotoUpload } from './PersonPhotoUpload';
import { api } from '../../api/client';
import { errText } from './liveFormat';
import './personPhoto.css';
export interface PersonPhoto {
  userId: number;
  name: string;
  upload?: { recordId: number };
  photo: { url: string; expiresIn: number; name: string; mime: string } | null;
}
export const personPhotoApi = {
  read: (id: number) => api<PersonPhoto>(`/live/people/${id}/photo`),
};
/** 点击姓名读取受控照片和服务器本月业绩；按员工编号隔离，避免同名串人。 */
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
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [detailOpen,setDetailOpen]=useState(false);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const outside = (e: PointerEvent) => {
      if (
        !cropOpen && !detailOpen &&
        !panel.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !cropOpen && !detailOpen && document.querySelectorAll('[role=dialog]').item(document.querySelectorAll('[role=dialog]').length-1)===panel.current) {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, cropOpen, detailOpen]);
  useEffect(()=>{if(open)panel.current?.querySelector<HTMLButtonElement>('button')?.focus();},[open]);
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
        ref={trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`查看${name}的照片与本月直播业绩`}
        aria-label={`查看${name}资料`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) {
            close();
            return;
          }
          setData(null);
          setError('');
          setOpen(true);
        }}
      >
        {name}
      </button>
      {open &&
        createPortal(
          <div className="live-person-profile-overlay">
          <div
            ref={panel}
            className="live-person-photo-popover"
            role="dialog"
            aria-modal="true"
            aria-label={`${name} · 主播资料`}
            onKeyDown={(e) => {
              if(e.key==='Tab'&&!cropOpen&&!detailOpen){
                const controls=[...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')??[])].filter(el=>el.getClientRects().length);
                const first=controls[0],last=controls[controls.length-1];
                if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
                else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
              }
              if (e.key === 'Escape') {
                e.stopPropagation();
                if (!cropOpen && !detailOpen) close();
              }
            }}
          >
            <div className="live-person-photo-heading">
              <strong>{name} · 主播资料</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                onClick={close}
              >
                ×
              </button>
            </div>
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
                <>
                  <p className="muted">尚未上传人员照片</p>
                  {current.upload ? (
                    <PersonPhotoUpload
                      key={`${personId}:${current.upload.recordId}`}
                      recordId={current.upload.recordId}
                      onCropChange={setCropOpen}
                      onSaved={() => {
                        setData(null);
                        setRetry((v) => v + 1);
                      }}
                    />
                  ) : (
                    <small className="muted">
                      请由有档案编辑权限的人事人员补传。
                    </small>
                  )}
                </>
              )}
              <AnchorMonthPanel userId={personId!} onOverlayChange={setDetailOpen}/>
            </div>
          </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

/** Native options cannot contain buttons; keep a separate name link beside the selected value. */
export function SelectedAnchorProfile({personId,name}:{personId?:number;name?:string}) {
  if(!Number.isSafeInteger(personId)||Number(personId)<=0||!name)return null;
  return <span className="live-selected-anchor-profile">主播资料：<PersonPhotoName key={personId} personId={personId} name={name}/></span>;
}
