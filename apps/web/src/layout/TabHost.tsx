import { ComponentType, type ReactNode, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { PageTab } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import './tabHost.css';

export interface HostTab extends PageTab { Component: ComponentType }

/** 宿主页面：把旧程序里“页面内的 Tab/面板”做成标签页，而不是单独的菜单项。 */
export function TabHost({ tabs, hideNavigation = false, primaryCount, beforeNavigation }: { tabs: HostTab[]; hideNavigation?: boolean; primaryCount?: number; beforeNavigation?: ReactNode }) {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const visible = tabs.filter((t, i) => i === 0 || can(t.permission));
  const current = visible.find((t) => t.id === params.get('tab')) ?? visible[0];
  const primary = primaryCount === undefined ? visible : visible.filter(tab => tabs.indexOf(tab) < primaryCount);
  const secondary = primaryCount === undefined ? [] : visible.filter(tab => tabs.indexOf(tab) >= primaryCount);
  const maintenanceRef = useRef<HTMLDetailsElement>(null);
  const Page = current.Component;
  function select(tab: HostTab) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (tab === visible[0]) next.delete('tab'); else next.set('tab', tab.id);
      return next;
    }, { replace: true });
    if (maintenanceRef.current) { maintenanceRef.current.open = false; maintenanceRef.current.querySelector('summary')?.focus(); }
  }
  return (
    <div>
      {beforeNavigation}
      {!hideNavigation && primary.length > 1 && (
        <div className="tab-group host-tabs" role="tablist" aria-label="页面分区">
          {primary.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === current.id} className={t.id === current.id ? 'chip active' : 'chip'}
              onClick={() => select(t)}>{t.label}</button>
          ))}
        </div>
      )}
      {!hideNavigation && secondary.length > 0 && <details ref={maintenanceRef} className="host-maintenance">
        <summary>{secondary.includes(current) ? `资料维护 · ${current.label}` : '资料维护'}</summary>
        <div role="tablist" aria-label="资料维护分区">
          {secondary.map(tab => <button key={tab.id} type="button" role="tab" aria-selected={tab === current} onClick={() => select(tab)}>{tab.label}</button>)}
          {secondary.includes(current) && <button type="button" onClick={() => select(visible[0])}>返回{visible[0].label}</button>}
        </div>
      </details>}
      <Page key={current.id} />
    </div>
  );
}
