import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { groupPages, searchNav, type VisibleSection } from '@kudesi/shared';
import { SearchIcon } from './NavIcons';

/**
 * 二级菜单面板：点左侧图标栏（或手机底栏）弹出。
 * 桌面是贴着图标栏的浮层，手机是从底部升起的抽屉。
 * 面板里：搜索框（搜全部一级菜单下的页面）、按分组排开的页面链接。
 */
export function ModulePanel(props: {
  sections: VisibleSection[];
  sectionId: string;
  currentPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const { sections, sectionId, currentPath } = props;
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const section = sections.find((s) => s.id === sectionId) ?? sections[0];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    // 手机上自动弹键盘会挡住菜单，只在宽屏自动聚焦搜索框
    if (window.matchMedia?.('(min-width: 721px)').matches) searchRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hits = useMemo(() => searchNav(sections, query), [sections, query]);
  const searching = query.trim().length > 0;
  const groups = useMemo(() => (section ? groupPages(section) : []), [section]);
  const isCurrent = (path: string) => currentPath === path || currentPath.startsWith(`${path}/`);

  if (!section) return null;
  return (
    <>
      <button type="button" className="mp-backdrop" aria-label="关闭菜单" tabIndex={-1} onClick={props.onClose} />
      <div className="mp" role="dialog" aria-modal="false" aria-label={`${section.label}菜单`}>
        <span className="mp-grabber" aria-hidden="true" />
        <div className="mp-head">
          <strong>{searching ? '搜索结果' : section.label}</strong>
          <button type="button" className="mp-close" onClick={props.onClose}>收起</button>
        </div>
        <label className="mp-search">
          <SearchIcon />
          <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索菜单，如：成本表、制单" aria-label="搜索菜单" />
        </label>
        <nav aria-label="二级导航" className="mp-body">
          {searching ? (
            hits.length === 0 ? <p className="mp-empty">没有找到匹配的菜单，换个关键词试试。</p> : (
              <ul className="mp-hits">
                {hits.map((h) => (
                  <li key={h.page.path}>
                    <NavLink to={h.page.path} className={isCurrent(h.page.path) ? 'mp-link active' : 'mp-link'} aria-current={isCurrent(h.page.path) ? 'page' : undefined} onClick={() => props.onPick(h.page.path)}>
                      <span>{h.page.label}</span>
                      <small>{h.sectionLabel}{h.groupTitle !== h.sectionLabel ? ` · ${h.groupTitle}` : ''}</small>
                    </NavLink>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="mp-groups">
              {groups.map((g) => (
                <section key={g.title} className={g.pages.length >= 5 ? 'mp-group dense' : 'mp-group'} aria-label={g.title}>
                  <h3>{g.title}</h3>
                  <ul>
                    {g.pages.map((p) => (
                      <li key={p.path}>
                        <NavLink to={p.path} className={isCurrent(p.path) ? 'mp-link active' : 'mp-link'} aria-current={isCurrent(p.path) ? 'page' : undefined} onClick={() => props.onPick(p.path)} title={p.description}>
                          <span className="mp-link-label">{p.label}</span>
                          {p.description && <small className="mp-link-desc">{p.description}</small>}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </nav>
      </div>
    </>
  );
}
