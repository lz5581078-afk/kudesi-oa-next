import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { mergedHomeLinks, NAV_SECTIONS, type HomeDto, type HomeWidget } from '@kudesi/shared';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ApplyCard, FinanceCard, FlowAlertsCard, PeopleCard, ResourceAlertsCard, StartedCard, StockCard, StoresCard, TasksCard, TodosCard } from './HomeCards';

const WIDGET_LABEL: Record<HomeWidget, string> = {
  todos: '我的待办', started: '我发起的', tasks: '我指派的任务', apply: '发起申请', flowAlerts: '逾期流程', people: '人员逾期排行',
  finance: '本月经营', stores: '店铺销售排行', stock: '库存缺货', resourceAlerts: '资料预警',
};

function renderWidget(w: HomeWidget, d: HomeDto) {
  switch (w) {
    case 'todos': return d.todos && <TodosCard key={w} data={d.todos} />;
    case 'started': return d.started && <StartedCard key={w} data={d.started} />;
    case 'tasks': return d.tasks && <TasksCard key={w} data={d.tasks} />;
    case 'apply': return d.apply && <ApplyCard key={w} data={d.apply} />;
    case 'flowAlerts': return d.flowAlerts && <FlowAlertsCard key={w} data={d.flowAlerts} />;
    case 'people': return d.people && <PeopleCard key={w} data={d.people} />;
    case 'finance': return d.finance && <FinanceCard key={w} data={d.finance} />;
    case 'stores': return d.stores && <StoresCard key={w} data={d.stores} />;
    case 'stock': return d.stock && <StockCard key={w} data={d.stock} />;
    case 'resourceAlerts': return d.resourceAlerts && <ResourceAlertsCard key={w} data={d.resourceAlerts} />;
  }
}

/** 首页：按登录人岗位的工作台类型展示常用入口和卡片。数据全部来自 /api/home，由服务端按权限算好。 */
export function HomePage() {
  const { user, can } = useAuth();
  const [data, setData] = useState<HomeDto | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    api<HomeDto>('/home').then(setData).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, []);
  useEffect(load, [load]);

  // 常用入口：配置里的页面 id → 导航注册表的页面；没做完或没权限的不显示
  const links = useMemo(() => {
    if (!data) return { shown: [], configured: 0 };
    const keys = mergedHomeLinks(data.workspace.types);
    const pages = NAV_SECTIONS.flatMap((s) => s.pages.map((p) => ({ key: `${s.id}.${p.id}`, page: p })));
    const shown = keys.flatMap((k) => pages.filter((x) => x.key === k && x.page.ready && (x.page.open || can(x.page.permission))).map((x) => x.page));
    return { shown, configured: keys.length };
  }, [data, can]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{data?.workspace.title ?? '首页'}</h1>
          <p className="muted home-sub">{[user?.name, data?.workspace.positionName ?? (user?.permissions.isCompanyAdmin ? '管理员' : null), data?.workspace.focus].filter(Boolean).join(' · ')}</p>
        </div>
        <button type="button" className="secondary-button" onClick={load}>刷新</button>
      </div>
      {error && <div role="alert" className="notice error">{error} <button type="button" className="link-button" onClick={load}>重试</button></div>}
      {!data && !error && <p className="muted" role="status">正在读取…</p>}
      {data && (
        <>
          {links.configured > 0 && (
            <section className="card home-card" aria-label="常用入口">
              <div className="home-card-head"><h2>常用入口</h2></div>
              {links.shown.length > 0
                ? <div className="pill-row home-links">{links.shown.map((p) => <Link key={p.path} to={p.path} className="home-link">{p.label}</Link>)}</div>
                : <p className="muted home-empty">暂无已授权的业务入口</p>}
            </section>
          )}
          {data.failed && data.failed.length > 0 && (
            <div role="alert" className="notice warn">{data.failed.map((w) => WIDGET_LABEL[w]).join('、')} 暂时读取失败，其余内容不受影响。 <button type="button" className="link-button" onClick={load}>重试</button></div>
          )}
          <div className="home-grid">{data.widgets.map((w) => renderWidget(w, data))}</div>
        </>
      )}
    </div>
  );
}
