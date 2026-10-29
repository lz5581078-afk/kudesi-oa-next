import { useEffect, useRef, useState } from 'react';
import type { DocType } from '@kudesi/shared';
import { money } from '../common';
import { financeApi, type DocRow } from '../financeApi';

/** 调入草稿（管家婆“调入草稿 Ctrl+Shift+F5”）：列出这种单据的草稿，点一张就调进开单页继续改。 */
export function DraftPicker({ type, onPick, onClose }: { type: DocType; onPick: (id: number) => void; onClose: () => void }) {
  const [rows, setRows] = useState<DocRow[] | null>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    financeApi.docs({ scope: type, status: 'draft' }).then((r) => alive && setRows(r.rows)).catch(() => alive && setError('草稿加载失败，请稍后重试'));
    return () => { alive = false; };
  }, [type]);
  useEffect(() => {
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div className="vc-pop" ref={ref} role="dialog" aria-label="调入草稿">
      <div className="vc-pop-head"><strong>调入草稿</strong><button type="button" className="icon-button" aria-label="关闭草稿列表" onClick={onClose}>×</button></div>
      {error && <p className="notice error">{error}</p>}
      {!rows && !error && <p className="muted">加载中…</p>}
      {rows && rows.length === 0 && <p className="muted">这种单据暂时没有草稿。</p>}
      <ul className="vc-pop-list">
        {rows?.map((r) => (
          <li key={r.id}><button type="button" onClick={() => onPick(r.id)}>
            <span className="mono">{r.docNo}</span><span>{r.partyName || '—'}</span><span className="num">{money(r.amountCents)}</span><span className="muted">{r.docDate}</span>
          </button></li>
        ))}
      </ul>
    </div>
  );
}
