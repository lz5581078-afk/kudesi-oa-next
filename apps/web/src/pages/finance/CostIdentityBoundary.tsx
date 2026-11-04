import { useAuth } from '../../auth/AuthContext';

/** Reset cost data, selections and open dialogs when the authenticated scope changes. */
export function useCostIdentityKey() {
  const { user } = useAuth();
  return JSON.stringify([user?.companyId ?? null, user?.id ?? null, { isCompanyAdmin: user?.permissions?.isCompanyAdmin ?? false, allow: [...(user?.permissions?.allow ?? [])].sort(), deny: [...(user?.permissions?.deny ?? [])].sort() }]);
}
