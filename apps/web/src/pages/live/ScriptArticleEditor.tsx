import { useEffect, useRef, useState } from 'react';
import { editRange, moveCues, type ScriptVersion } from './scriptCues';
import { offsets, editStages, stageAt, type Stage } from './scriptOutline';

import { ScriptOutlineDialog } from './ScriptOutlineDialog';

type Selection = { start: number; end: number };
export function ScriptArticleEditor({
  v,
  change,
  onSelect,
  onMark,
}: {
  v: ScriptVersion & { outline: Stage[] };
  change: (update: Partial<ScriptVersion>) => void;
  onSelect: (s: Selection) => void;
  onMark: (a: number, b: number) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null),
    mirror = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0),
    preferred = useRef(0);
  const starts = offsets(v.outline),
    index = Math.min(current, v.outline.length - 1);
  function jump(i: number) {
    const el = input.current;
    if (!el) return;
    preferred.current = i;
    setCurrent(i);
    el.focus({ preventScroll: true });
    el.setSelectionRange(starts[i], starts[i]);
    mirror.current?.children[i]?.scrollIntoView({ block: 'nearest' });
    onSelect({ start: starts[i], end: starts[i] });
  }
  useEffect(() => {
    function track() {
      const nodes = Array.from(mirror.current?.children ?? []);
      const target = Math.min(window.innerHeight / 3, 220);
      const node = nodes.find((n) => n.textContent && n.getBoundingClientRect().bottom >= target);
      if (node) setCurrent(nodes.indexOf(node));
    }
    window.addEventListener('scroll', track, true);
    return () => window.removeEventListener('scroll', track, true);
  }, []);
  const [managing, setManaging] = useState(false);
  return (
    <div className="sc-outline-layout sc-article-layout">
      <nav aria-label="话术环节目录">
        <strong>文内目录</strong>
        <button type="button" className="sc-manage-stages" onClick={() => setManaging(true)}>
          管理章节
        </button>
        {v.outline.map((s, i) => (
          <button
            type="button"
            key={i}
            aria-current={index === i ? 'location' : undefined}
            onClick={() => jump(i)}
          >
            <small>{String(i + 1).padStart(2, '0')}</small>
            {s.name || '未命名'}
          </button>
        ))}
      </nav>
      <div className="sc-outline-content">
        <div className="sc-article-head">
          <h3>话术正文</h3>
          <small>{v.body.length} 字</small>
        </div>
        <div className="sc-manuscript">
          <div className="sc-text-measure" aria-hidden="true" ref={mirror}>
            {v.outline.map((s, i) => (
              <span key={i} data-current={i === index ? true : undefined}>
                {v.body.slice(starts[i], starts[i] + s.length)}
              </span>
            ))}
            {'\u200b'}
          </div>
          <textarea
            aria-label="话术正文"
            spellCheck={false}
            ref={input}
            maxLength={30000}
            placeholder="在这里连续写稿，或粘贴整篇话术。选中文字后，可右键标记环节或关联素材。"
            value={v.body}
            onSelect={(e) => {
              const el = e.currentTarget;
              onSelect({ start: el.selectionStart, end: el.selectionEnd });
              const i = stageAt(v.outline, el.selectionStart, preferred.current);
              preferred.current = i;
              setCurrent(i);
            }}
            onMouseMove={(e) => {
              const nodes = mirror.current?.children;
              if (!nodes) return;
              for (let i = 0; i < nodes.length; i++) {
                if (!v.outline[i].length) continue;
                if (
                  Array.from(nodes[i].getClientRects()).some(
                    (r) =>
                      e.clientX >= r.left &&
                      e.clientX <= r.right &&
                      e.clientY >= r.top &&
                      e.clientY <= r.bottom,
                  )
                ) {
                  setCurrent(i);
                  break;
                }
              }
            }}
            onContextMenu={(e) => {
              const { selectionStart: a, selectionEnd: b } = e.currentTarget;
              if (a < b) {
                e.preventDefault();
                onMark(a, b);
              }
            }}
            onChange={(e) => {
              const text = e.target.value,
                caret = e.target.selectionStart;
              const { start, end, nextEnd } = editRange(v.body, text, caret);
              const outline = editStages(v.outline, start, end, nextEnd - start, preferred.current);
              preferred.current = stageAt(v.outline, start, preferred.current);
              setCurrent(preferred.current);
              change({ body: text, outline, cues: moveCues(v.body, text, caret, v.cues) });
            }}
          />
        </div>
        {managing && (
          <ScriptOutlineDialog
            article={v}
            current={index}
            close={() => setManaging(false)}
            apply={(draft, selected) => {
              change(draft);
              preferred.current = selected;
              setCurrent(selected);
              setManaging(false);
              const start = offsets(draft.outline)[selected];
              onSelect({ start, end: start });
              requestAnimationFrame(() => {
                input.current?.focus({ preventScroll: true });
                input.current?.setSelectionRange(start, start);
              });
            }}
          />
        )}
      </div>
    </div>
  );
}
