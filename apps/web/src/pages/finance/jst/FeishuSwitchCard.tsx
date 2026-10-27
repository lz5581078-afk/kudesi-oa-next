import { useEffect, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';

interface Sw { enabled: boolean; senderConfigured: boolean; counts?: Record<string, number> }

/** 飞书通知开关：SKU 批量申请进入新环节时给办理人发飞书；走出站队列，独立开关，默认关；没接入飞书时只积压不发送。 */
export function FeishuSwitchCard() {
  const { user } = useAuth();
  const isAdmin = !!user?.permissions.isCompanyAdmin;
  const [sw, setSw] = useState<Sw | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Sw>('/finance/feishu-notice/switch').then(setSw).catch(() => setSw(null)); }, []);
  async function toggle(on: boolean) {
    if (on && !window.confirm('打开后，SKU 批量申请的新待办、被退回、办结等提醒会加入飞书通知队列（需要已接入飞书才会真正发送）。确定打开吗？')) return;
    try { setSw({ ...(await api<Sw>('/finance/feishu-notice/switch', { method: 'PUT', body: { enabled: on, note: on ? '管理员打开' : '管理员关闭' } })), counts: sw?.counts }); setError(''); }
    catch (e) { setError(e instanceof ApiError ? e.message : '操作失败'); }
  }
  if (!sw) return null;
  const pending = sw.counts?.pending ?? 0;
  return (
    <div className={`notice ${sw.enabled ? 'ok' : ''}`} aria-label="飞书通知开关">
      <strong>飞书通知：{sw.enabled ? '已打开' : '已关闭（默认）'}</strong>
      {!sw.senderConfigured && <div className="bad-text">还没有接入飞书（需要管理员提供并授权应用凭证），即使打开也只会在队列里积压，不会发送。</div>}
      {sw.enabled && <div className="muted">队列里待发送 {pending} 条</div>}
      {error && <div role="alert" className="bad-text">{error}</div>}
      {isAdmin && <div className="row-actions">{sw.enabled ? <button type="button" className="secondary-button small" onClick={() => void toggle(false)}>关闭飞书通知</button> : <button type="button" className="secondary-button small" onClick={() => void toggle(true)}>打开飞书通知</button>}</div>}
    </div>
  );
}
