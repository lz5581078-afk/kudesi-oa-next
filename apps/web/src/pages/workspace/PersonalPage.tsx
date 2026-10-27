import { useAuth } from '../../auth/AuthContext';
import { RoleDesk } from './RoleDesk';

/** 个人工作台：不绑定岗位，只有本人的流程、待办和个人任务。 */
export function PersonalPage() {
  const { user } = useAuth();
  return <RoleDesk view={{ title: '个人工作台', subtitle: [user?.name, user?.positionName].filter(Boolean).join(' · ') || '个人任务与申请', links: [], cards: [], pending: [] }} />;
}
