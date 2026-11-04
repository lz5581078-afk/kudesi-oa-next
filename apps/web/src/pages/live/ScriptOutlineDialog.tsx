import { useEffect, useRef, useState } from 'react';
import { OutlineTemplates } from './OutlineLayout';
import { reorderStage, type Stage } from './scriptOutline';
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
  const { outline } = draft;
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);

  function insert(index: number) {
    const stages = outline.slice();
    stages.splice(index, 0, { name: newName.trim(), length: 0 });
    setDraft({ ...draft, outline: stages });
    select(index);
    setNewName('');
  }
  function move(to: number) {
    setDraft(reorderStage(outline, draft.body, draft.cues, selected, to));
    select(to);
  }
  function remove() {
    const next = Math.max(0, selected - 1);
    const stages = outline.filter((_, i) => i !== selected);
    stages[next] = { ...stages[next], length: stages[next].length + outline[selected].length };
    setDraft({ ...draft, outline: stages });
    select(next);
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
              onClick={() => select(i)}
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
            <button type="button" disabled={outline.length === 1} onClick={remove}>
              删除章节
            </button>
          </div>
          <small>删除目录项后，正文和素材标注保留在相邻章节。至少保留一个章节。</small>
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
          disabled={outline.some((s) => !s.name.trim()) || !!newName.trim()}
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
