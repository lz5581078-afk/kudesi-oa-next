import { useState } from 'react';
import { RESOURCE_COMPANIONS, createChecker, getResourceDef, permissionOwner, resourcePermission } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { LocationBoard } from './LocationBoard';
import { ResourcePage } from './ResourcePage';

type View = 'board' | 'table';
const VIEW_KEY = 'kudesi.locations.view';
function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'board'; } catch { return 'board'; }
}

/** 旧程序里一个页面带着几类资料（如“房间与档案位置”里有位置和档案项）：用页签切换，权限各自独立。 */
export function CompanionPage({ type }: { type: string }) {
  const { user } = useAuth();
  const check = user ? createChecker(user.permissions) : () => false;
  const tabs = [type, ...(RESOURCE_COMPANIONS[type] ?? [])].filter((t) => t === type || check(resourcePermission(permissionOwner(t), 'view')));
  const [active, setActive] = useState(type);
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* 浏览器不让存就算了 */ } };
  // 房间与档案位置默认用看板（区域位置、固定资产储物空间、档案三块），表格视图保留给批量编辑、导入导出
  const board = type === 'locations' && active === 'locations' && view === 'board';
  const switcher = type === 'locations' && active === 'locations';
  return (
    <div>
      {(tabs.length > 1 || switcher) && (
        <div className="tabs companion-tabs">
          {tabs.map((t) => <button key={t} type="button" className={active === t ? 'tab active' : 'tab'} onClick={() => setActive(t)}>{getResourceDef(t)?.label ?? t}</button>)}
          {switcher && (
            <span className="seg companion-view" role="group" aria-label="显示方式">
              <button type="button" aria-pressed={view === 'board'} className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>看板</button>
              <button type="button" aria-pressed={view === 'table'} className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>表格</button>
            </span>
          )}
        </div>
      )}
      {board ? <LocationBoard /> : <ResourcePage key={active} type={active} />}
    </div>
  );
}
