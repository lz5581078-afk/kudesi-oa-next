import { useState } from 'react';
import { RESOURCE_COMPANIONS, createChecker, getResourceDef, permissionOwner, resourcePermission } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { ResourcePage } from './ResourcePage';

/** 旧程序里一个页面带着几类资料（如“房间与档案位置”里有位置和档案项）：用页签切换，权限各自独立。 */
export function CompanionPage({ type }: { type: string }) {
  const { user } = useAuth();
  const check = user ? createChecker(user.permissions) : () => false;
  const tabs = [type, ...(RESOURCE_COMPANIONS[type] ?? [])].filter((t) => t === type || check(resourcePermission(permissionOwner(t), 'view')));
  const [active, setActive] = useState(type);
  return (
    <div>
      {tabs.length > 1 && (
        <div className="tabs" style={{ marginBottom: 12 }}>
          {tabs.map((t) => <button key={t} type="button" className={active === t ? 'tab active' : 'tab'} onClick={() => setActive(t)}>{getResourceDef(t)?.label ?? t}</button>)}
        </div>
      )}
      <ResourcePage key={active} type={active} />
    </div>
  );
}
