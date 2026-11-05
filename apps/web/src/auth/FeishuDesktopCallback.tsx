import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

export function FeishuDesktopCallback({ code, state }: { code: string | null; state: string }) {
  const request = useRef<Promise<unknown> | null>(null);
  const [message, setMessage] = useState(code ? '正在确认飞书授权…' : '飞书授权已取消，请返回 OA 桌面端重新发起。');
  useEffect(() => {
    history.replaceState(history.state, '', location.pathname);
    if (!code) return;
    let active = true;
    request.current ??= api('/auth/feishu/desktop/relay', { body: { code, state } });
    request.current.then(
      () => { if (active) setMessage('授权成功，可以返回 OA 桌面端。'); },
      error => { if (active) setMessage(error.message); },
    );
    return () => { active = false; };
  }, [code, state]);
  return <main className="center-screen"><p role="status">{message}</p></main>;
}
