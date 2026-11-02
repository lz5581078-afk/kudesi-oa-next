import { useAuth } from '../../auth/AuthContext';
import { RoleDesk } from './RoleDesk';
import { PersonalLiveIncome } from './PersonalLiveIncome';

/** 个人工作台：本人的直播收入、流程、待办和个人任务。 */
export function PersonalPage() {
  const { user } = useAuth();
  return <RoleDesk view={{ title: '个人工作台', subtitle: [user?.name, user?.positionName].filter(Boolean).join(' · ') || '个人任务与申请', links: [], cards: [], pending: [], top:refreshKey=><PersonalLiveIncome refreshKey={refreshKey}/> }} />;
}
