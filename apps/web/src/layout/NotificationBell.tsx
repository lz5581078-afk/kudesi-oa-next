import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { flowApi, fmtTime, type NotificationDto } from '../pages/flow/flowApi';

/** 站内通知：每 60 秒刷新一次未读数；点通知跳到对应流程并标记已读。 */
export function NotificationBell() {
  const [data, setData] = useState<NotificationDto | null>(null);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const load = useCallback(() => { flowApi.notifications().then(setData).catch(() => undefined); }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <span className="bell">
      <button type="button" className="ghost-button" aria-label="通知" onClick={() => { setOpen((o) => !o); load(); }}>
        通知{data && data.unread > 0 && <span className="bell-count">{data.unread}</span>}
      </button>
      {open && (
        <div className="card bell-panel" role="dialog" aria-label="通知列表">
          <div className="between">
            <strong>通知</strong>
            <button type="button" className="link-button" onClick={() => flowApi.markRead().then(load)}>全部已读</button>
          </div>
          {data?.items.length === 0 && <p className="muted">没有通知</p>}
          {data?.items.map((n) => (
            <button key={n.id} type="button" className={n.read ? 'bell-item' : 'bell-item unread'}
              onClick={() => { void flowApi.markRead([n.id]).then(load); setOpen(false); if (n.link) navigate(n.link); }}>
              <strong>{n.title}</strong>
              {n.body && <div className="muted">{n.body}</div>}
              <small className="muted">{fmtTime(n.createdAt)}</small>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
