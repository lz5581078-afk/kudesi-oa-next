import { createContext, useContext, useMemo } from 'react';
import { visibleSections, type VisibleSection } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';

export const NavigationContext = createContext<VisibleSection[] | null>(null);

/** 功能首页与外壳共享已授权的动态菜单，不另建岗位目录或权限规则。 */
export function useNavigationSections() {
  const sections = useContext(NavigationContext);
  const { can, user } = useAuth();
  const isCompanyAdmin = user?.permissions?.isCompanyAdmin;
  return useMemo(() => sections ?? visibleSections(can, { isCompanyAdmin }), [sections, can, isCompanyAdmin]);
}
