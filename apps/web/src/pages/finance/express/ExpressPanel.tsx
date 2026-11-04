import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** Express panels keep the original title, icon and action row inside one card. */
export function ExpressPanel({ title, icon: Icon, actions, children, className = '' }: { title: string; icon: LucideIcon; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`express-panel ${className}`} role="region" aria-label={title}><header className="express-panel-heading"><div className="express-panel-title"><Icon size={18} aria-hidden="true" /><h2>{title}</h2></div>{actions && <div className="express-panel-actions">{actions}</div>}</header>{children}</section>;
}
