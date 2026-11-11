import { DESKTOP_AFTER_SALES_ROUTES } from '@kudesi/shared';


export function isAfterSalesWindow(pathname: string, search: string) {
  return pathname === DESKTOP_AFTER_SALES_ROUTES.workspace && new URLSearchParams(search).get('window') === '1';
}

export async function launchAfterSalesTool() {
  const desktop = window.oaDesktop;
  if (desktop?.surface !== 'main' || !await desktop.openAfterSales?.()) throw new Error('实时售后处理窗口未能打开，请重试。');
}
