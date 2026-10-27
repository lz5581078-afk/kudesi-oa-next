import { useNavigate } from 'react-router-dom';
import { navPageByKey, type SummaryCard } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';

/** 汇总卡片：有数字就显示，null 显示“—”和原因（暂无该模块/无权限）；能去的页面做成可点按钮，去不了的只显示。 */
export function SummaryCards({ cards, label }: { cards: SummaryCard[]; label: string }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  return (
    <div className="ws-cards" role="group" aria-label={label}>
      {cards.map((c) => {
        const target = c.page ? navPageByKey(c.page) : null;
        const go = target && can(target.permission) ? target.path : null;
        const body = (
          <>
            <span>{c.label}</span>
            <strong>{c.value === null || c.value === undefined ? '—' : c.value}</strong>
            {c.hint && <small>{c.hint}</small>}
          </>
        );
        const cls = `ws-card ${c.tone ?? 'normal'}${c.value === null ? ' none' : ''}`;
        return go
          ? <button key={c.key} type="button" className={cls} aria-label={`${c.label}${c.value ?? ''}，点击查看`} onClick={() => navigate(go)}>{body}</button>
          : <div key={c.key} className={cls}>{body}</div>;
      })}
    </div>
  );
}
