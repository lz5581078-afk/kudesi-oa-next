import { ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { PageTab } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';

export interface HostTab extends PageTab { Component: ComponentType }

/** 宿主页面：把旧程序里“页面内的 Tab/面板”做成标签页，而不是单独的菜单项。 */
export function TabHost({ tabs }: { tabs: HostTab[] }) {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const visible = tabs.filter((t, i) => i === 0 || can(t.permission));
  const current = visible.find((t) => t.id === params.get('tab')) ?? visible[0];
  const Page = current.Component;
  return (
    <div>
      {visible.length > 1 && (
        <div className="tab-group host-tabs" role="tablist" aria-label="页面分区">
          {visible.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === current.id} className={t.id === current.id ? 'chip active' : 'chip'}
              onClick={() => setParams(t === visible[0] ? {} : { tab: t.id }, { replace: true })}>{t.label}</button>
          ))}
        </div>
      )}
      <Page key={current.id} />
    </div>
  );
}
