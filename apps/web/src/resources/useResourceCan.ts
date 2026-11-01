import { createChecker, getResourceDef, permissionOwner, resourcePermission, type ResourceAction } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';

export function useResourceCan(type: string) {
  const { user } = useAuth();
  const check = user ? createChecker(user.permissions) : () => false;
  return (action: ResourceAction) => (!getResourceDef(type)?.readOnly || ['view', 'export'].includes(action)) && check(resourcePermission(permissionOwner(type), action));
}
