import { ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { PageTab } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import './tabHost.css';

export interface HostTab extends PageTab { Component: ComponentType }

/** 宿主页面：把旧程序里“页面内的 Tab/面板”做成标签页，而不是单独的菜单项。 */
export function TabHost({ tabs, primaryCount }: { tabs: HostTab[]; primaryCount?: number }) {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const visible = tabs.filter((t, i) => i === 0 || can(t.permission));
  const current = visible.find((t) => t.id === params.get('tab')) ?? visible[0];
  const Page = current.Component;
  const primary = primaryCount === undefined ? visible : visible.filter(t => tabs.indexOf(t) < primaryCount);
  const secondary = primaryCount === undefined ? [] : visible.filter(t => tabs.indexOf(t) >= primaryCount);
  return (
    <div>
      {primary.length > 1 && (
        <div className="tab-group host-tabs" role="tablist" aria-label="页面分区">
          {primary.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === current.id} className={t.id === current.id ? 'chip active' : 'chip'}
              onClick={() => setParams(t === visible[0] ? {} : { tab: t.id }, { replace: true })}>{t.label}</button>
          ))}
        </div>
      )}
      {secondary.length > 0 && <details className="finance-secondary-tabs"><summary>{secondary.includes(current) ? current.label : '资料维护'}</summary><div role="tablist" aria-label="资料维护分区">{secondary.map(t=><button key={t.id} type="button" role="tab" aria-selected={current.id===t.id} onClick={()=>setParams({tab:t.id},{replace:true})}>{t.label}</button>)}{secondary.includes(current) && <button type="button" onClick={()=>setParams({},{replace:true})}>返回{visible[0].label}</button>}</div></details>}
      <Page key={current.id} />
    </div>
  );
}
