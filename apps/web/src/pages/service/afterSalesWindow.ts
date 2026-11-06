import { DESKTOP_AFTER_SALES_ROUTES } from '@kudesi/shared';

export const AFTER_SALES_WINDOW_PATH = `${DESKTOP_AFTER_SALES_ROUTES.workspace}?window=1`;
export const AFTER_SALES_DESKTOP_URL = 'https://github.com/lz5581078-afk/kudesi-oa-next/releases/download/oa-desktop-v0.2.3/KudesiOA-Portable-0.2.3-x64.zip';

export function isAfterSalesWindow(pathname: string, search: string) {
  return pathname === DESKTOP_AFTER_SALES_ROUTES.workspace && new URLSearchParams(search).get('window') === '1';
}

export async function launchAfterSalesTool() {
  const desktop = window.oaDesktop;
  if (desktop?.surface !== 'main' || !await desktop.openAfterSales?.()) throw new Error('实时售后处理窗口未能打开，请重试。');
}
