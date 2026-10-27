import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { groupPages, searchNav, visibleSections, type NavPage } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';

const RECENT_KEY = 'kudesi.features.recent';
const RECENT_LIMIT = 6;
const HOME_PATH = '/workbench/home';

function readRecent(): string[] {
  try { const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}

/** 功能首页：当前账号能进的全部功能启动台——搜索、最近使用、按模块分组。入口和权限全部来自导航注册表。 */
export function HomePage() {
  const { can } = useAuth();
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState(readRecent);
  const compact = useMemo(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 720px)').matches, []);
  const sections = useMemo(() => visibleSections(can).map((s) => ({ ...s, pages: s.pages.filter((p) => p.path !== HOME_PATH) })).filter((s) => s.pages.length > 0), [can]);
  const byPath = useMemo(() => new Map(sections.flatMap((s) => s.pages.map((p) => [p.path, { page: p, section: s.label }] as const))), [sections]);
  const total = byPath.size;
  const hits = useMemo(() => searchNav(sections, query), [sections, query]);
  const searching = query.trim().length > 0;
  const recentItems = recent.map((p) => byPath.get(p)).filter((x): x is NonNullable<typeof x> => !!x);
  const remember = (page: NavPage) => {
    const next = [page.path, ...recent.filter((p) => p !== page.path)].slice(0, RECENT_LIMIT);
    setRecent(next);
    try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 只记在本机，写不进去不影响使用 */ }
  };
  const Tile = ({ page, hint }: { page: NavPage; hint: string }) => <Link to={page.path} className="ws-tile" onClick={() => remember(page)}><strong>{page.label}</strong><small>{hint}</small></Link>;
  return (
    <div className="ws-page">
      <div className="page-head"><div><h1>功能首页</h1><p className="muted">按你的权限列出所有可用功能；搜一下名称，或点最近用过的直接进入。</p></div></div>
      <div className="ws-search">
        <input type="search" aria-label="搜索功能" placeholder={`搜索 ${total} 个功能，如：成本表、草稿`} value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button type="button" className="secondary-button" aria-label="清除搜索" onClick={() => setQuery('')}>清除</button>}
      </div>
      {total === 0 && <div className="empty-state muted"><strong>暂无可用功能</strong><span>当前账号还没有可进入的功能，请联系管理员在“员工与权限”里开通。</span></div>}
      {searching ? (
        hits.length ? (
          <section aria-label="搜索结果">
            <p className="muted" role="status">找到 <b>{hits.length}</b> 个功能</p>
            <div className="ws-grid">{hits.map((h) => <Tile key={h.page.path} page={h.page} hint={`${h.sectionLabel} · ${h.groupTitle}`} />)}</div>
          </section>
        ) : (
          <div className="empty-state muted" role="status"><strong>没有找到“{query.trim()}”</strong><span>换个关键词试试，比如功能名称里的一个字。</span><button type="button" className="secondary-button" onClick={() => setQuery('')}>清除搜索</button></div>
        )
      ) : (
        <>
          {recentItems.length > 0 && (
            <section aria-label="最近使用">
              <h2 className="section-title">最近使用</h2>
              <div className="ws-grid">{recentItems.map(({ page, section }) => <Tile key={page.path} page={page} hint={section} />)}</div>
            </section>
          )}
          {sections.map((s) => (
            <details key={s.id} className="card ws-fold" open={!compact}>
              <summary><h2>{s.label}<small className="muted"> · {s.pages.length} 项</small></h2></summary>
              {groupPages(s).map((g) => (
                <div key={g.title} className="ws-fold-group">
                  {(groupPages(s).length > 1) && <h3>{g.title}</h3>}
                  <div className="ws-grid">{g.pages.map((p) => <Tile key={p.path} page={p} hint={g.title === s.label ? s.label : g.title} />)}</div>
                </div>
              ))}
            </details>
          ))}
        </>
      )}
    </div>
  );
}
