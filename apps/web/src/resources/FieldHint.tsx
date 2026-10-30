import type { SyntheticEvent } from 'react';

/** 悬停提示往哪边弹：不超出所在滚动区的左右边，靠近底部时改往上弹（滚动区会裁掉越界内容） */
function place(el: HTMLElement) {
  const box = el.closest<HTMLElement>('.rf-scroll, .modal-body, .rd-scroll') ?? document.body;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const w = Math.min(260, Math.max(160, b.width - 24));
  el.style.setProperty('--tip-w', `${w}px`);
  const shift = Math.min(0, b.right - 10 - (r.left - 8 + w)) + Math.max(0, b.left + 10 - (r.left - 8));
  el.style.setProperty('--tip-x', `${-8 + shift}px`);
  el.dataset.pos = b.bottom - r.bottom < 90 ? 'up' : 'down';
}

/**
 * 字段 / 分区旁的小 ⓘ：说明文字默认不占版面，鼠标悬停或键盘聚焦时才弹出。
 * 文字同时写在 aria-label 里，读屏和测试都能取到；点击不会触发所在 label 的聚焦。
 */
export function FieldHint({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  const on = (e: SyntheticEvent<HTMLElement>) => place(e.currentTarget);
  return (
    <span className={`rf-hint${className ? ` ${className}` : ''}`} role="img" aria-label={text} data-tip={text} tabIndex={0}
      onMouseEnter={on} onFocus={on} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7.2v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="8" cy="5.1" r=".85" fill="currentColor" /></svg>
    </span>
  );
}
