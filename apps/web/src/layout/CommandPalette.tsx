import { useEffect, useMemo, useRef, useState } from 'react';
import type { VisibleSection } from '@kudesi/shared';

/** ⌘K / Ctrl+K 快速跳转：只列出当前用户有权限且已开放的页面。 */
export function CommandPalette(props: {
  sections: VisibleSection[];
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const all = props.sections.flatMap((s) => s.pages.map((p) => ({ ...p, section: s.label })));
    const q = query.trim().toLowerCase();
    return q ? all.filter((p) => `${p.section}${p.label}`.toLowerCase().includes(q)) : all;
  }, [props.sections, query]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [query]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') props.onClose();
    else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' && items[index]) props.onPick(items[index].path);
  };

  return (
    <div className="palette-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="快速跳转"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入页面名称，回车跳转"
          aria-label="搜索页面"
        />
        <ul>
          {items.length === 0 && <li className="palette-empty">没有匹配的页面</li>}
          {items.map((item, i) => (
            <li key={item.path}>
              <button
                type="button"
                className={i === index ? 'palette-item active' : 'palette-item'}
                onMouseEnter={() => setIndex(i)}
                onClick={() => props.onPick(item.path)}
              >
                <span>{item.label}</span>
                <small>{item.section}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
