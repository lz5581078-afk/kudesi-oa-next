import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { directPage, findPageByPath, splitMobileSections, visibleSections, type VisibleSection } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { AppbarContext, useAppbarState } from './AppbarSlot';
import { CommandPalette } from './CommandPalette';
import { ModulePanel } from './ModulePanel';
import { MoreIcon, NavIcon, SearchIcon } from './NavIcons';
import { NotificationBell } from './NotificationBell';

/**
 * 外壳：左侧窄图标栏（一级菜单）+ 点开后弹出的分组菜单（二级）+ 顶部页面栏 + 手机底部标签栏。
 * 菜单完全由导航注册表和当前用户权限生成；一个一级菜单只有一个页面时直接进入。
 */
export function Shell() {
  const { user, can, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const appbar = useAppbarState();

  const sections = useMemo(() => visibleSections(can), [can]);
  const current = findPageByPath(location.pathname);
  const activeSection = sections.find((s) => s.id === current?.section.id);
  const mobile = useMemo(() => splitMobileSections(sections), [sections]);

  // 换了页面就收起菜单
  useEffect(() => { setPanelId(null); setAccountOpen(false); }, [location.pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === 'Escape') setAccountOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!user) return null;

  const pageTitle = current?.page.label ?? (location.pathname === '/account/password' ? '修改密码' : '');
  const openPanel = (section: VisibleSection) => setPanelId((id) => (id === section.id ? null : section.id));
  const moreActive = Boolean(activeSection && mobile.more.some((s) => s.id === activeSection.id));

  const railItem = (section: VisibleSection) => {
    const direct = directPage(section);
    const selected = section.id === activeSection?.id;
    const open = panelId === section.id;
    const cls = `rail-item${selected ? ' active' : ''}${open ? ' open' : ''}${section.id === 'system' ? ' rail-item-end' : ''}`;
    const body = (<><NavIcon name={section.icon} /><span>{section.label}</span></>);
    return direct ? (
      <NavLink key={section.id} to={direct.path} className={cls} aria-current={selected ? 'page' : undefined}>{body}</NavLink>
    ) : (
      <button key={section.id} type="button" className={cls} aria-haspopup="dialog" aria-expanded={open} aria-current={selected ? 'page' : undefined} onClick={() => openPanel(section)}>{body}</button>
    );
  };

  return (
    <AppbarContext.Provider value={appbar.value}>
    <div className="app-shell">
      <aside className="rail">
        <Link to="/" className="rail-brand" title="小白全流程系统" aria-label="回到首页"><span aria-hidden="true">白</span></Link>
        <nav aria-label="一级导航" className="rail-nav">{sections.map(railItem)}</nav>
      </aside>

      {panelId && (
        <ModulePanel
          sections={sections}
          sectionId={panelId}
          currentPath={location.pathname}
          onPick={() => setPanelId(null)}
          onClose={() => setPanelId(null)}
        />
      )}

      <div className="app-main">
        <header className="appbar">
          <Link to="/" className="appbar-brand" aria-label="回到首页"><span aria-hidden="true">白</span></Link>
          <div className="appbar-lead">
            <div className="appbar-title" aria-label="当前位置">
              {activeSection && !appbar.bare && <small>{activeSection.label}</small>}
              <span className="appbar-page">{pageTitle || '小白全流程系统'}</span>
            </div>
            <span className="appbar-slot" ref={appbar.setSlot} />
          </div>
          <button type="button" className="appbar-search" onClick={() => setPaletteOpen(true)} aria-label="搜索页面">
            <SearchIcon />
            <span>搜索页面</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="appbar-right">
            <span className="appbar-company" title={user.companyName}>{user.companyName}</span>
            <NotificationBell />
            <div className="account">
              <button type="button" className="account-button" aria-haspopup="menu" aria-expanded={accountOpen} aria-label={`账号 ${user.name}`} onClick={() => setAccountOpen((o) => !o)}>
                <span className="avatar" aria-hidden="true">{user.name.slice(0, 1)}</span>
                <span className="user-meta"><strong>{user.name}</strong><small>{user.positionName ?? '管理员'}</small></span>
              </button>
              {accountOpen && (
                <>
                  <button type="button" className="account-backdrop" tabIndex={-1} aria-label="关闭账号菜单" onClick={() => setAccountOpen(false)} />
                  <div className="account-menu" role="menu">
                    <div className="account-menu-head"><strong>{user.name}</strong><small>{user.companyName} · {user.account}</small></div>
                    <Link role="menuitem" to="/account/password">修改密码</Link>
                    <button type="button" role="menuitem" className="danger" onClick={logout}>退出登录</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        <main className="content">
          {user.mustChangePassword && location.pathname !== '/account/password' && (
            <div role="alert" className="notice warn">
              当前是初始密码，请先<Link to="/account/password">修改密码</Link>。
            </div>
          )}
          <Outlet />
        </main>
      </div>

      <nav className="tabbar" aria-label="手机底部导航">
        {mobile.primary.map((section) => {
          const direct = directPage(section);
          const selected = section.id === activeSection?.id;
          const cls = `tabbar-item${selected ? ' active' : ''}${panelId === section.id ? ' open' : ''}`;
          const body = (<><NavIcon name={section.icon} size={22} /><span>{section.label}</span></>);
          return direct
            ? <NavLink key={section.id} to={direct.path} className={cls}>{body}</NavLink>
            : <button key={section.id} type="button" className={cls} aria-expanded={panelId === section.id} onClick={() => openPanel(section)}>{body}</button>;
        })}
        {mobile.more.length > 0 && (
          <button type="button" className={`tabbar-item${moreActive ? ' active' : ''}${panelId && mobile.more.some((s) => s.id === panelId) ? ' open' : ''}`} onClick={() => setPanelId((id) => (id && mobile.more.some((s) => s.id === id) ? null : (moreActive ? activeSection!.id : mobile.more[0].id)))}>
            <MoreIcon /><span>更多</span>
          </button>
        )}
      </nav>

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
    </AppbarContext.Provider>
  );
}
