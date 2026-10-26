import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { findPageByPath, visibleSections } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { CommandPalette } from './CommandPalette';
import { NotificationBell } from './NotificationBell';

/** 方案 B：顶部一级导航 + 左侧二级导航。菜单完全由导航注册表和当前用户权限生成。 */
export function Shell() {
  const { user, can, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const sections = useMemo(() => visibleSections(can), [can]);
  const current = findPageByPath(location.pathname);
  const activeSection = sections.find((s) => s.id === current?.section.id);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!user) return null;

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">白</span>
          <span>小白全流程系统</span>
        </Link>
        <nav aria-label="一级导航" className="topnav">
          {sections.map((section) => (
            <NavLink
              key={section.id}
              to={section.landingPath}
              className={() => (section.id === activeSection?.id ? 'topnav-link active' : 'topnav-link')}
            >
              {section.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <button type="button" className="search-box" onClick={() => setPaletteOpen(true)}>
            <span>搜索页面</span>
            <kbd>⌘K</kbd>
          </button>
          <NotificationBell />
          <span className="user-chip" title={`${user.companyName} · ${user.account}`}>
            <span className="avatar" aria-hidden="true">{user.name.slice(0, 1)}</span>
            <span className="user-meta">
              <strong>{user.name}</strong>
              <small>{user.positionName ?? '管理员'}</small>
            </span>
          </span>
          <button type="button" className="ghost-button" onClick={logout}>退出</button>
        </div>
      </header>

      <div className="body">
        <nav aria-label="二级导航" className="subnav">
          {activeSection ? (
            <>
              <span className="subnav-title">{activeSection.label}</span>
              {activeSection.pages.map((page, i) => (
                <Fragment key={page.id}>
                  {page.group && page.group !== activeSection.pages[i - 1]?.group && <span className="subnav-group">{page.group}</span>}
                  <NavLink to={page.path} className={({ isActive }) => (isActive ? 'subnav-link active' : 'subnav-link')}>
                    {page.label}
                  </NavLink>
                </Fragment>
              ))}
            </>
          ) : (
            <span className="subnav-title">账号</span>
          )}
        </nav>
        <main className="content">
          {user.mustChangePassword && location.pathname !== '/account/password' && (
            <div role="alert" className="notice warn">
              当前是初始密码，请先<Link to="/account/password">修改密码</Link>。
            </div>
          )}
          <Outlet />
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette
          sections={sections}
          onClose={() => setPaletteOpen(false)}
          onPick={(path) => {
            setPaletteOpen(false);
            navigate(path);
          }}
        />
      )}
    </div>
  );
}
