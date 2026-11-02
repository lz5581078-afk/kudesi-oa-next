import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import type { SubmissionStatus } from './liveApi';

export function SubmissionNotice({ status, onRefresh }: { status: SubmissionStatus; onRefresh: () => void }) {
  const { can } = useAuth();
  return <div className={`notice ${status.ready ? 'ok' : 'warn'} live-submission-notice`} role="status">
    <span>{status.message}{!status.ready && ' 已填写的数据可先保存，流程就绪后再提交。'}</span>
    {!status.ready && <div className="live-actions">
      {can('flow.templates.view') && can('flow.templates.manage') && <Link to="/flow/templates?flow=live-session-review">配置直播场次审核</Link>}
      <button type="button" className="link-button" onClick={onRefresh}>重新检查</button>
    </div>}
  </div>;
}
