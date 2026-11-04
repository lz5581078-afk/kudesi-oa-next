import { useCallback, useRef, useState } from 'react';
import { api } from '../../api/client';
import { ScriptAssetLibrary } from './ScriptAssetLibrary';
import { initialOutline, offsets, labelRange, reorderStage } from './scriptOutline';
import { OutlineLayout, OutlineTemplates } from './OutlineLayout';
import { ScriptPreview } from './ScriptPreview';
import { categories, moveCues, type Asset, type ScriptVersion } from './scriptCues';

export function ScriptVersionPanel({
  initial,
  manage,
  dirty,
  onDirty,
  onName,
}: {
  initial: ScriptVersion;
  manage: boolean;
  dirty: boolean;
  onDirty: (v: boolean) => void;
  onName: (v: string) => void;
}) {
  const [v, setV] = useState({ ...initial, outline: initialOutline(initial) }),
    [edit, setEdit] = useState(manage && !initial.body);
  const [section, setSection] = useState<'script' | 'info' | 'assets'>('script');
  const [asset, setAsset] = useState(0),
    [busy, setBusy] = useState(false),
    [msg, setMsg] = useState('');
  const selection = useRef<{ start: number; end: number } | null>(null),
    picker = useRef<HTMLDialogElement>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const mergeAssets = useCallback(
    (items: Asset[]) =>
      setV((old) => {
        const existing = new Set(old.assets.map((a) => a.id));
        const fresh = items.filter((a) => !existing.has(a.id));
        return fresh.length ? { ...old, assets: [...old.assets, ...fresh] } : old;
      }),
    [],
  );
  const [stageName, setStageName] = useState('');
  const faq = v.faq ?? [],
    [faqChanged, setFaqChanged] = useState(false);
  const starts = offsets(v.outline);
  function updateFaq(items: typeof faq) {
    setFaqChanged(true);
    change({ faq: items });
  }
  const path = '/live/scripts/versions/' + v.id;
  function change(update: Partial<ScriptVersion>) {
    setV((old) => ({ ...old, ...update, outline: update.outline ?? old.outline }));
    onDirty(true);
    setMsg('');
  }
  async function save() {
    setBusy(true);
    setMsg('');
    try {
      const { revision, faqRevision } = await api<{ revision: number; faqRevision?: number }>(path, {
        method: 'PUT',
        body: {
          name: v.name,
          notes: v.notes,
          body: v.body,
          cues: v.cues,
          revision: v.revision,
          outline: v.outline,
          ...(faqChanged ? { faq, faqRevision: v.faqRevision } : {}),
        },
      });
      setV((old) => ({ ...old, name: v.name.trim(), revision, faqRevision: faqRevision ?? old.faqRevision }));
      setFaqChanged(false);
      onName(v.name.trim());
      onDirty(false);
      setMsg('已保存');
      setEdit(false);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openPicker(start: number, end: number) {
    setStageName('');
    setRange({ start, end });
    picker.current?.showModal();
  }
  function mark(start: number, end: number, id: number) {
    if (start === end || !id) {
      setMsg('请选中正文里的文字，再选择要展示的素材');
      return;
    }
    if (v.cues.some((c) => c.asset === id && c.start < end && c.end > start)) {
      setMsg('同一素材在这段话里已有标注');
      return;
    }
    change({ cues: [...v.cues, { asset: id, start, end }].sort((a, b) => a.start - b.start) });
  }
  return (
    <fieldset className="sc-panel" disabled={busy}>
      <div className="sc-bar sc-version-head">
        <h2>{v.name}</h2>
        {dirty && <small>尚未保存</small>}
        {(dirty || edit) && manage && (
          <button className="primary-button" disabled={!v.name.trim()} onClick={save}>
            保存版本
          </button>
        )}
        {manage && (
          <button className="secondary-button" onClick={() => setEdit(!edit)}>
            {edit ? '预览话术' : '编辑版本'}
          </button>
        )}
      </div>
      {edit ? (
        <>
          <div className="sc-edit-tabs" role="group" aria-label="编辑分区">
            {(
              [
                ['script', '正文与标注'],
                ['assets', '素材库'],
                ['info', '版本资料'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} aria-pressed={section === key} onClick={() => setSection(key)}>
                {label}
              </button>
            ))}
          </div>
          <div hidden={section !== 'info'} className="sc-section">
            <label>
              版本名称
              <input value={v.name} maxLength={100} onChange={(e) => change({ name: e.target.value })} />
            </label>
            <label>
              版本特色与使用说明
              <textarea
                rows={4}
                maxLength={10000}
                value={v.notes}
                onChange={(e) => change({ notes: e.target.value })}
                placeholder="适用人群、讲解重点、与上一版的区别…"
              />
            </label>
          </div>
          <div hidden={section !== 'assets'} className="sc-section">
            <h3>本版素材库</h3>
            {section === 'assets' && (
              <ScriptAssetLibrary version={v.id} assets={v.assets} onAdded={mergeAssets} />
            )}
          </div>
          <div hidden={section !== 'script'} className="sc-section">
            <OutlineTemplates
              stages={v.outline}
              apply={(names) => {
                if (!window.confirm('按模板顺序设置环节名称？已有正文按当前位置保留。')) return;
                const outline = names.map((name, i) => ({ name, length: v.outline[i]?.length ?? 0 }));
                outline[outline.length - 1].length += v.outline
                  .slice(names.length)
                  .reduce((n, s) => n + s.length, 0);
                change({ outline });
              }}
            />
            <OutlineLayout stages={v.outline}>
              {v.outline.map((s, i) => {
                const start = starts[i],
                  end = start + s.length,
                  text = v.body.slice(start, end);
                const move = (to: number) => change(reorderStage(v.outline, v.body, v.cues, i, to));
                return (
                  <section key={i} data-stage={i} className="sc-write-stage">
                    <div className="sc-bar">
                      <label>
                        环节名称
                        <input
                          value={s.name}
                          maxLength={100}
                          onChange={(e) =>
                            change({
                              outline: v.outline.map((item, j) =>
                                i === j ? { ...item, name: e.target.value } : item,
                              ),
                            })
                          }
                        />
                      </label>
                      <button className="link-button" disabled={i === 0} onClick={() => move(i - 1)}>
                        上移
                      </button>
                      <button
                        className="link-button"
                        disabled={i === v.outline.length - 1}
                        onClick={() => move(i + 1)}
                      >
                        下移
                      </button>
                      <button
                        className="link-button"
                        disabled={v.outline.length === 1}
                        onClick={() => {
                          if (s.length && !window.confirm('移除这个环节？文字会并入相邻环节。')) return;
                          const outline = v.outline.filter((_, j) => j !== i).map((t) => ({ ...t }));
                          outline[Math.max(0, i - 1)].length += s.length;
                          change({ outline });
                        }}
                      >
                        移除环节
                      </button>
                    </div>
                    <textarea
                      aria-label={s.name + '正文'}
                      rows={Math.min(18, Math.max(4, text.split('\n').length + 1))}
                      value={text}
                      placeholder={'写入' + (s.name || '本环节') + '话术…'}
                      maxLength={30000 - v.body.length + s.length}
                      onSelect={(e) => {
                        selection.current = {
                          start: start + e.currentTarget.selectionStart,
                          end: start + e.currentTarget.selectionEnd,
                        };
                      }}
                      onContextMenu={(e) => {
                        const a = e.currentTarget.selectionStart,
                          b = e.currentTarget.selectionEnd;
                        if (a < b) {
                          e.preventDefault();
                          openPicker(start + a, start + b);
                        }
                      }}
                      onChange={(e) => {
                        const value = e.target.value,
                          body = v.body.slice(0, start) + value + v.body.slice(end);
                        change({
                          body,
                          cues: moveCues(v.body, body, start + e.target.selectionStart, v.cues),
                          outline: v.outline.map((t, j) => (j === i ? { ...t, length: value.length } : t)),
                        });
                      }}
                    />
                  </section>
                );
              })}
              <button
                className="secondary-button"
                disabled={v.outline.length >= 80}
                onClick={() => change({ outline: [...v.outline, { name: '新环节', length: 0 }] })}
              >
                ＋ 添加环节
              </button>
            </OutlineLayout>
            <p className="muted">
              拖选一段正文，右键关联素材。中控会在段首看到展示提示，在段尾看到撤下提示。
            </p>
            <div className="sc-bar">
              <label>
                关联素材
                <select value={asset} onChange={(e) => setAsset(Number(e.target.value))}>
                  <option value={0}>请选择</option>
                  {v.assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {categories[a.category]} · {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="secondary-button"
                disabled={!asset}
                onClick={() => {
                  if (selection.current) mark(selection.current.start, selection.current.end, asset);
                }}
              >
                标注选中文字
              </button>
            </div>

            {v.cues.map((c, i) => (
              <div className="sc-cue" key={i}>
                <strong>{v.assets.find((a) => a.id === c.asset)?.name}</strong>　「
                {v.body.slice(c.start, c.end)}」{' '}
                <button
                  className="link-button"
                  onClick={() => change({ cues: v.cues.filter((_, n) => n !== i) })}
                >
                  移除标注
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          {v.notes && <p className="sc-notes">{v.notes}</p>}
          <ScriptPreview v={v} onMark={manage ? openPicker : undefined} />
        </>
      )}
      <section className="sc-faq">
        <div className="sc-bar">
          <h3>产品问题库</h3>
          <small>同一产品的各版话术共用</small>
        </div>
        {faq.length === 0 && <p className="muted">暂无问答。</p>}
        {faq.map((q, i) =>
          edit ? (
            <div key={i} className="sc-faq-edit">
              <label>
                问题
                <input
                  maxLength={200}
                  value={q.question}
                  onChange={(e) =>
                    updateFaq(faq.map((r, j) => (j === i ? { ...r, question: e.target.value } : r)))
                  }
                />
              </label>
              <label>
                回答
                <textarea
                  maxLength={1500}
                  value={q.answer}
                  onChange={(e) =>
                    updateFaq(faq.map((r, j) => (j === i ? { ...r, answer: e.target.value } : r)))
                  }
                />
              </label>
              <button className="link-button" onClick={() => updateFaq(faq.filter((_, j) => i !== j))}>
                移除问答
              </button>
            </div>
          ) : (
            <details key={i}>
              <summary>{q.question}</summary>
              <p>{q.answer}</p>
            </details>
          ),
        )}
        {edit && (
          <button
            className="secondary-button"
            disabled={faq.length >= 40}
            onClick={() => updateFaq([...faq, { question: '', answer: '' }])}
          >
            ＋ 添加问答
          </button>
        )}
      </section>
      {manage && (
        <dialog ref={picker} className="sc-picker" aria-label="为选中文字关联素材">
          <header>
            <h3>关联素材</h3>
            <button className="link-button" onClick={() => picker.current?.close()}>
              关闭
            </button>
          </header>
          {range && <blockquote>{v.body.slice(range.start, range.end)}</blockquote>}
          <form
            className="sc-bar"
            onSubmit={(e) => {
              e.preventDefault();
              if (!range || !stageName.trim()) return;
              const outline = labelRange(v.outline, range.start, range.end, stageName.trim());
              if (outline.length > 80) {
                setMsg('每版最多 80 个环节');
                picker.current?.close();
                return;
              }
              change({ outline });
              picker.current?.close();
            }}
          >
            <label>
              将选区设为环节
              <input
                list="sc-stage-names"
                value={stageName}
                maxLength={100}
                onChange={(e) => setStageName(e.target.value)}
              />
              <datalist id="sc-stage-names">
                {[...new Set(v.outline.map((s) => s.name))].map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </label>
            <button className="secondary-button" disabled={!stageName.trim()}>
              标记环节
            </button>
          </form>
          {!v.assets.length && <p>请先到素材库上传素材。</p>}
          {Object.entries(categories).map(([key, label]) => {
            const items = v.assets.filter((a) => a.category === key);
            return (
              items.length > 0 && (
                <section key={key}>
                  <h4>{label}</h4>
                  {items.map((a) => (
                    <button
                      className="secondary-button"
                      key={a.id}
                      onClick={() => {
                        if (range) mark(range.start, range.end, a.id);
                        picker.current?.close();
                      }}
                    >
                      {a.name}
                    </button>
                  ))}
                </section>
              )
            );
          })}
        </dialog>
      )}
      {msg && <p role="status">{msg}</p>}
    </fieldset>
  );
}
