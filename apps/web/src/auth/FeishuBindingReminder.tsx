import { Link } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { rememberLiveRoom } from './liveRoomIntent';
import './feishuBinding.css';

/** Unbound accounts always retain a visible entry, including after route changes. */
export function FeishuBindingReminder() {
  const { user } = useAuth();
  if (!user?.feishuBindingPending) return null;
  return <aside className="feishu-binding-reminder" aria-label="飞书绑定提醒">
    <div><strong>你还没有绑定本人飞书</strong><p>绑定后可使用飞书登录，并接收 OA 待办和通知。</p></div>
    <Link className="primary-button" to="/feishu-setup" onClick={rememberLiveRoom}>去绑定</Link>
  </aside>;
}
