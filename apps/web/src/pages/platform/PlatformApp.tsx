import { useState } from 'react';
import { PLATFORM_PAGES, type PlatformPageId } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApplicationsPage } from './ApplicationsPage';
import { CompaniesPage } from './CompaniesPage';

const PAGES: Record<PlatformPageId, () => JSX.Element> = {
  applications: ApplicationsPage,
  companies: CompaniesPage,
};

/** 平台管理员后台：独立于公司界面，只管企业申请和公司。 */
export function PlatformApp() {
  const { platformAdmin, logout } = useAuth();
  const [page, setPage] = useState<PlatformPageId>('applications');
  const Page = PAGES[page];
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">酷</span>
          <span>平台管理后台</span>
        </span>
        <nav aria-label="平台导航" className="topnav">
          {PLATFORM_PAGES.map((p) => (
            <button key={p.id} type="button" className={p.id === page ? 'topnav-link active' : 'topnav-link'} onClick={() => setPage(p.id)}>
              {p.title}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="user-chip">
            <span className="avatar" aria-hidden="true">{(platformAdmin?.name ?? '平').slice(0, 1)}</span>
            <span className="user-meta"><strong>{platformAdmin?.name}</strong><small>平台管理员</small></span>
          </span>
          <button type="button" className="ghost-button" onClick={logout}>退出</button>
        </div>
      </header>
      <main className="content platform-content">
        <Page />
      </main>
    </div>
  );
}
