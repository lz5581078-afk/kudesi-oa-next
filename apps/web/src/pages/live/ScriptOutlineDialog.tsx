import { useEffect, useRef, useState } from 'react';
import { OutlineTemplates } from './OutlineLayout';
import { reorderStage, removeStage, type Stage } from './scriptOutline';
import type { Cue } from './scriptCues';

type Article = { outline: Stage[]; body: string; cues: Cue[] };

export function ScriptOutlineDialog({
  article,
  current,
  apply,
  close,
}: {
  article: Article;
  current: number;
  apply: (draft: Article, selected: number) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(article);
  const [selected, select] = useState(current);
  const [newName, setNewName] = useState('');
  const [removing, setRemoving] = useState(false);
  const [destination, setDestination] = useState<'previous' | 'next' | 'delete'>('previous');
  const { outline } = draft;
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);

  function insert(index: number) {
    setRemoving(false);
    const stages = outline.slice();
    stages.splice(index, 0, { name: newName.trim(), length: 0 });
    setDraft({ ...draft, outline: stages });
    select(index);
    setNewName('');
  }
  function move(to: number) {
    setRemoving(false);
    setDraft(reorderStage(outline, draft.body, draft.cues, selected, to));
    select(to);
  }
  function remove() {
    setDraft(removeStage(draft, selected, destination));
    select(Math.max(0, selected - 1));
    setRemoving(false);
  }
  return (
    <dialog ref={dialog} className="sc-picker sc-outline-dialog" aria-label="管理章节" onCancel={close}>
      <header>
        <h3>管理章节</h3>
        <small>{outline.length} / 80</small>
      </header>
      <div className="sc-stage-workspace">
        <section aria-label="章节列表">
          {outline.map((stage, i) => (
            <button
              type="button"
              key={i}
              aria-current={i === selected ? 'true' : undefined}
              onClick={() => { select(i); setRemoving(false); }}
            >
              <small>{String(i + 1).padStart(2, '0')}</small>
              <strong>{stage.name || '未命名'}</strong>
              <small>{stage.length} 字</small>
            </button>
          ))}
        </section>
        <div className="sc-stage-tools">
          <label>
            章节名称
            <input
              value={outline[selected].name}
              maxLength={100}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  outline: outline.map((s, i) => (i === selected ? { ...s, name: e.target.value } : s)),
                })
              }
            />
          </label>
          <div className="sc-bar">
            <button type="button" disabled={!selected} onClick={() => move(selected - 1)}>
              上移
            </button>
            <button
              type="button"
              disabled={selected === outline.length - 1}
              onClick={() => move(selected + 1)}
            >
              下移
            </button>
            <button type="button" disabled={outline.length === 1} onClick={() => { setDestination(selected > 0 ? 'previous' : 'next'); setRemoving(true); }}>
              删除章节
            </button>
          </div>
          <small>移动章节时正文和素材标注一起移动。至少保留一个章节。</small>
          {removing && <section className="sc-remove-chapter" aria-label="删除章节的内容去向">
            <strong>删除「{outline[selected].name}」· {outline[selected].length} 字</strong>
            <label>本章内容如何处理<select value={destination} onChange={(e) => setDestination(e.target.value as typeof destination)}>
              {selected > 0 && <option value="previous">合并到上一章「{outline[selected - 1].name}」末尾</option>}
              {selected < outline.length - 1 && <option value="next">合并到下一章「{outline[selected + 1].name}」开头</option>}
              <option value="delete">同时删除本章正文及对应素材标注</option>
            </select></label>
            <small>确认后仍需应用目录并保存版本才会生效。</small>
            <div className="sc-bar"><button type="button" onClick={remove}>确认删除章节</button><button type="button" onClick={() => setRemoving(false)}>保留章节</button></div>
          </section>}
          <label>
            新环节名称
            <input
              value={newName}
              maxLength={100}
              placeholder="例如：答疑"
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          <div className="sc-bar">
            {['在本章前添加', '在本章后添加'].map((label, side) => (
              <button
                type="button"
                key={label}
                disabled={!newName.trim() || outline.length >= 80}
                onClick={() => insert(selected + side)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <OutlineTemplates
        stages={outline}
        apply={(names) => {
          if (!names.length || !window.confirm('载入目录模板？正文及素材标注将保留。')) return;
          setRemoving(false);
          const stages = names.map((name, i) => ({ name, length: outline[i]?.length ?? 0 }));
          stages[stages.length - 1].length += outline.slice(names.length).reduce((n, s) => n + s.length, 0);
          setDraft({ ...draft, outline: stages });
          select(0);
        }}
      />
      <footer className="sc-bar">
        <button className="secondary-button" onClick={close}>
          取消
        </button>
        <button
          className="primary-button"
          disabled={removing || outline.some((s) => !s.name.trim()) || !!newName.trim()}
          onClick={() =>
            apply({ ...draft, outline: outline.map((s) => ({ ...s, name: s.name.trim() })) }, selected)
          }
        >
          应用目录
        </button>
      </footer>
    </dialog>
  );
}
