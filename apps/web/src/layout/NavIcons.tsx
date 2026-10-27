import type { NavIconName } from '@kudesi/shared';

/** 一级菜单图标：自绘的线条图标，统一 24 格、1.8 线宽，颜色跟随文字。 */
const PATHS: Record<NavIconName, JSX.Element> = {
  inbox: <><path d="M4 13.5 6.6 5.8A2 2 0 0 1 8.5 4.5h7a2 2 0 0 1 1.9 1.3L20 13.5" /><path d="M4 13.5h4.2l1 2.2h5.6l1-2.2H20V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z" /></>,
  flow: <><rect x="3.5" y="4" width="6" height="5" rx="1.2" /><rect x="14.5" y="4" width="6" height="5" rx="1.2" /><rect x="9" y="15" width="6" height="5" rx="1.2" /><path d="M6.5 9v2.5h11V9M12 11.5V15" /></>,
  wallet: <><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18a1.5 1.5 0 0 1 1.5 1.5V9" /><path d="M4 7.5V17a2 2 0 0 0 2 2h12.5a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18.5 8H6a2 2 0 0 1-2-.5z" /><circle cx="16" cy="13.5" r="1.1" /></>,
  database: <><ellipse cx="12" cy="6" rx="7" ry="2.6" /><path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" /><path d="M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6" /></>,
  support: <><path d="M5 13v-1.5a7 7 0 0 1 14 0V13" /><rect x="3.5" y="12.5" width="3.8" height="5.5" rx="1.4" /><rect x="16.7" y="12.5" width="3.8" height="5.5" rx="1.4" /><path d="M18.6 18c0 1.9-2.2 2.9-5.1 2.9" /><circle cx="12.2" cy="20.9" r=".9" /></>,
  shield: <><path d="M12 3.5 5.5 6v5.4c0 4 2.7 7.2 6.5 9.1 3.8-1.9 6.5-5.1 6.5-9.1V6z" /><path d="M12 8.3v4.2" /><circle cx="12" cy="15.6" r=".9" /></>,
  live: <><rect x="3.5" y="7" width="11.5" height="10" rx="2" /><path d="m15 11.2 5.5-3v7.6l-5.5-3z" /><circle cx="9.2" cy="12" r="1.3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6" /></>,
};

export function NavIcon({ name, size = 22 }: { name: NavIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

export function MoreIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5.5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18.5" cy="12" r="1.7" />
    </svg>
  );
}

export function SearchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" />
    </svg>
  );
}
