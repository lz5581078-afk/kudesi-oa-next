import { DESKTOP_AFTER_SALES_LINK, DESKTOP_AFTER_SALES_ROUTES } from '@kudesi/shared';
import { Link, type LinkProps } from 'react-router-dom';
import { launchAfterSalesTool } from '../pages/service/afterSalesWindow';

export function WorkspaceLink({ to, onClick, ...props }: LinkProps) {
  if (to !== DESKTOP_AFTER_SALES_ROUTES.workspace) return <Link {...props} to={to} onClick={onClick} />;
  return <Link
    {...props}
    to={DESKTOP_AFTER_SALES_LINK}
    onClick={(event) => {
      onClick?.(event);
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (window.oaDesktop?.surface !== 'main' || !window.oaDesktop.openAfterSales) return;
      event.preventDefault();
      void launchAfterSalesTool().catch(() => window.alert('实时售后处理窗口未能打开，请重试。'));
    }}
  />;
}
