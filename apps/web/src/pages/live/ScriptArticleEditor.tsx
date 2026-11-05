import { useEffect, useId, useRef, useState } from 'react';
import { editRange, replaceCueRange, type ScriptVersion } from './scriptCues';
import { offsets, splitStage, moveStageText, type Stage } from './scriptOutline';
import { ScriptOutlineDialog } from './ScriptOutlineDialog';

type Selection = { start: number; end: number };
export function ScriptArticleEditor({ v, change, onSelect, onMark }: {
  v: ScriptVersion & { outline: Stage[] };
  change: (update: Partial<ScriptVersion>) => void;
  onSelect: (s: Selection) => void;
  onMark: (a: number, b: number) => void;
}) {
  const id = useId();
  const content = useRef<HTMLDivElement>(null);
  const inputs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const [current, setCurrent] = useState(0);
  const [selection, setSelection] = useState({ chapter: 0, start: 0, end: 0 });
  const [managing, setManaging] = useState(false);
  const [dividing, setDividing] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState(-1);
  const [message, setMessage] = useState('');
  const starts = offsets(v.outline), index = Math.min(current, v.outline.length - 1);
  useEffect(() => {
    inputs.current.forEach((el) => {
      if (el) { el.style.height = 'auto'; el.style.height = Math.max(132, el.scrollHeight) + 'px'; }
    });
  }, [v.body, v.outline]);
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      inputs.current.forEach((el) => {
        if (el) { el.style.height = 'auto'; el.style.height = Math.max(132, el.scrollHeight) + 'px'; }
      });
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  function jump(i: number, caret = 0) {
    setCurrent(i);
    setSelection({ chapter: i, start: caret, end: caret });
    const el = inputs.current[i];
    el?.closest('section')?.scrollIntoView({ block: 'nearest' });
    el?.focus({ preventScroll: true });
    el?.setSelectionRange(caret, caret);
    onSelect({ start: starts[i] + caret, end: starts[i] + caret });
  }
  function finish(update: Partial<ScriptVersion>, selected: number) {
    change(update);
    setCurrent(selected);
    setSelection({ chapter: selected, start: 0, end: 0 });
    setDividing(false);
    // The document structure changed; stale global offsets must not mark another sentence.
    onSelect({ start: 0, end: 0 });
    requestAnimationFrame(() => inputs.current[selected]?.focus({ preventScroll: true }));
  }
  const selected = selection.chapter === index && selection.end > selection.start;
  return (
    <div className="sc-outline-layout sc-article-layout">
      <nav aria-label="话术环节目录">
        <strong>章节目录</strong>
        <button type="button" className="sc-manage-stages" onClick={() => setManaging(true)}>管理章节</button>
        {v.outline.map((s, i) => (
          <button type="button" key={i} aria-current={index === i ? 'location' : undefined} onClick={() => jump(i)}>
            <small>{String(i + 1).padStart(2, '0')}</small>
            <span>{s.name || '未命名'}<small className="sc-chapter-count">{s.length ? `${s.length} 字` : '待填写'}</small></span>
          </button>
        ))}
      </nav>
      <div className="sc-outline-content" ref={content}>
        <div className="sc-article-head"><h3>按章节写话术</h3><small>{v.body.length} / 30000 字</small></div>
        <p className="sc-writing-help">在每个章节标题下填写正文，按目录顺序组成全文。已有整篇稿件可在光标处拆分，或选中文字调整归属。</p>
        <p className="sc-editing-status" role="status">正在编辑：{v.outline[index].name}</p>
        {v.outline.map((s, i) => {
          const text = v.body.slice(starts[i], starts[i] + s.length);
          return (
            <section className="sc-chapter" data-active={index === i ? true : undefined} key={i} aria-labelledby={`${id}-heading-${i}`}>
              <header><h4 id={`${id}-heading-${i}`}><small>第 {i + 1} 章</small>{s.name || '未命名'}</h4><small>{s.length ? `${s.length} 字` : '待填写'}</small></header>
              <textarea
                ref={(el) => { inputs.current[i] = el; }}
                aria-label={`${s.name || '未命名'}正文（第${i + 1}章）`}
                spellCheck={false}
                maxLength={30000 - v.body.length + s.length}
                placeholder={`在这里填写${s.name || '本章'}话术…`}
                value={text}
                onFocus={() => setCurrent(i)}
                onSelect={(e) => {
                  const { selectionStart: start, selectionEnd: end } = e.currentTarget;
                  setCurrent(i);
                  setSelection({ chapter: i, start, end });
                  onSelect({ start: starts[i] + start, end: starts[i] + end });
                }}
                onContextMenu={(e) => {
                  const { selectionStart: a, selectionEnd: b } = e.currentTarget;
                  if (a < b) { e.preventDefault(); onMark(starts[i] + a, starts[i] + b); }
                }}
                onChange={(e) => {
                  const next = e.target.value, caret = e.target.selectionStart;
                  const { start, end, nextEnd } = editRange(text, next, caret);
                  change({
                    body: v.body.slice(0, starts[i]) + next + v.body.slice(starts[i] + s.length),
                    outline: v.outline.map((stage, n) => n === i ? { ...stage, length: next.length } : stage),
                    cues: replaceCueRange(v.cues, starts[i] + start, starts[i] + end, nextEnd - start),
                  });
                  setCurrent(i);
                  setSelection({ chapter: i, start: caret, end: caret });
                  onSelect({ start: starts[i] + caret, end: starts[i] + caret });
                }}
              />
              <footer>
                <button type="button" className="link-button" onClick={() => {
                  const el = inputs.current[i];
                  const a = el?.selectionStart ?? 0, b = el?.selectionEnd ?? a;
                  setSelection({ chapter: i, start: a, end: b }); setCurrent(i);
                  setName(''); setTarget(-1); setMessage(''); setDividing(true);
                }}>拆分 / 调整本章内容</button>
                <button type="button" className="link-button" disabled={selection.chapter !== i || selection.start === selection.end} onClick={() => onMark(starts[i] + selection.start, starts[i] + selection.end)}>为选中文字关联素材</button>
              </footer>
            </section>
          );
        })}
        {managing && <ScriptOutlineDialog article={v} current={index} close={() => setManaging(false)} apply={(draft, chapter) => { setManaging(false); finish(draft, chapter); }} />}
        {dividing && <ChapterDivision close={() => setDividing(false)}>
          <h3>调整「{v.outline[index].name}」内容</h3>
          <p>{selected ? `已选中 ${selection.end - selection.start} 字，可独立成章或移入其他章节。` : `从本章第 ${selection.start + 1} 个字的位置拆分，后面的文字归入新章节。`}</p>
          <label>新章节名称<input autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：产品介绍" /></label>
          <button type="button" className="primary-button" disabled={!name.trim()} onClick={() => {
            const draft = splitStage(v, index, selection.start, selection.end, name.trim());
            if (draft.outline.length > 80) { setMessage('每版最多 80 个章节，请先合并部分章节。'); return; }
            finish(draft, index + 1);
          }}>{selected ? '将选中文字设为新章节' : '从光标处拆出新章节'}</button>
          {selected && <><label>移入已有章节<select value={target} onChange={(e) => setTarget(Number(e.target.value))}><option value={-1}>选择目标章节</option>{v.outline.map((s, i) => i !== index && <option key={i} value={i}>第 {i + 1} 章 · {s.name}</option>)}</select></label>
            <button type="button" className="secondary-button" disabled={target < 0} onClick={() => finish(moveStageText(v, index, target, selection.start, selection.end), target)}>移到目标章节末尾（保留素材标注）</button></>}
          {message && <p role="alert">{message}</p>}
        </ChapterDivision>}
      </div>
    </div>
  );
}
function ChapterDivision({ close, children }: { close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current!; el.showModal(); return () => el.close(); }, []);
  return <dialog ref={ref} className="sc-picker sc-division-dialog" aria-label="拆分或移动章节内容" onCancel={close}>{children}<footer><button type="button" className="secondary-button" onClick={close}>取消</button></footer></dialog>;
}
