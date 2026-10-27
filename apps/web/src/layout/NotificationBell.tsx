import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { flowApi, fmtTime, type NotificationDto } from '../pages/flow/flowApi';

const KIND_LABEL: Record<string, string> = { todo: '待办', overdue: '逾期', escalate: '升级', cc: '抄送', done: '办结', returned: '退回', cancelled: '废除', rejected: '拒绝' };

/** 站内通知：每 60 秒刷新一次未读数；点通知跳到对应流程并标记已读；可只看未读，Esc / 点空白处关闭。 */
export function NotificationBell() {
  const [data, setData] = useState<NotificationDto | null>(null);
  const [open, setOpen] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLSpanElement>(null);
  const navigate = useNavigate();
  const load = useCallback(() => { flowApi.notifications().then((d) => { setData(d); setError(''); }).catch(() => setError('通知读取失败')); }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [open]);

  const items = (data?.items ?? []).filter((n) => !onlyUnread || !n.read);
  return (
    <span className="bell" ref={ref}>
      <button type="button" className="ghost-button" aria-label="通知" aria-expanded={open} onClick={() => { setOpen((o) => !o); load(); }}>
        通知{data && data.unread > 0 && <span className="bell-count">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="card bell-panel" role="dialog" aria-label="通知列表">
          <div className="between">
            <strong>通知{data && data.unread > 0 ? `（${data.unread} 条未读）` : ''}</strong>
            <button type="button" className="link-button" disabled={!data || data.unread === 0} onClick={() => flowApi.markRead().then(load)}>全部已读</button>
          </div>
          <div className="bell-tabs" role="group" aria-label="通知筛选">
            <button type="button" aria-pressed={!onlyUnread} className={!onlyUnread ? 'chip active' : 'chip'} onClick={() => setOnlyUnread(false)}>全部</button>
            <button type="button" aria-pressed={onlyUnread} className={onlyUnread ? 'chip active' : 'chip'} onClick={() => setOnlyUnread(true)}>未读</button>
          </div>
          {error && <p role="alert" className="muted">{error}</p>}
          {!data && !error && <p className="muted">正在读取…</p>}
          {data && items.length === 0 && <p className="muted">{onlyUnread ? '没有未读通知' : '没有通知'}</p>}
          {items.map((n) => (
            <button key={n.id} type="button" className={n.read ? 'bell-item' : 'bell-item unread'}
              onClick={() => { void flowApi.markRead([n.id]).then(load); setOpen(false); if (n.link) navigate(n.link); }}>
              <strong>{n.title}</strong>
              {n.body && <div className="muted">{n.body}</div>}
              <small className="muted bell-time">{KIND_LABEL[n.kind] ? `${KIND_LABEL[n.kind]} · ` : ''}{fmtTime(n.createdAt)}</small>
            </button>
          ))}
          {data && data.items.length >= 50 && <p className="muted">仅显示最近 50 条。</p>}
        </div>
      )}
    </span>
  );
}
