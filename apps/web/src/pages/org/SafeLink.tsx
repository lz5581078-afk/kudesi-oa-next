import { Link, useInRouterContext } from 'react-router-dom';
import type { ReactNode } from 'react';

/** 站内链接；没有路由环境（单独渲染、测试）时退化成普通链接。 */
export function SafeLink({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  const inRouter = useInRouterContext();
  return inRouter ? <Link to={to} className={className}>{children}</Link> : <a href={to} className={className}>{children}</a>;
}
