import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { ScriptAssetLibrary } from './ScriptAssetLibrary';
import { initialOutline, labelRange } from './scriptOutline';
import { ScriptArticleEditor } from './ScriptArticleEditor';
import { PondQuestionArticle, ProductQuestionArticle } from './ProductQuestionArticle';
import { ScriptPreview } from './ScriptPreview';
import { categories, type Asset, type ScriptVersion } from './scriptCues';

export function ScriptVersionPanel({
  initial,
  manage,
  folderTitle,
  onDirty,
  onName,
}: {
  initial: ScriptVersion;
  manage: boolean;
  folderTitle: string;
  onDirty: (v: boolean) => void;
  onName: (v: string) => void;
}) {
  const [v, setV] = useState({ ...initial, outline: initialOutline(initial) }),
    [edit, setEdit] = useState(manage && !initial.body);
  const [section, setSection] = useState<'script' | 'questions' | 'pond' | 'info' | 'assets'>('script');
  const [versionDirty, setVersionDirty] = useState(false);
  const [questionDirty, setQuestionDirty] = useState(false);
  const [pondDirty, setPondDirty] = useState(false);
  useEffect(() => onDirty(versionDirty || questionDirty || pondDirty), [versionDirty, questionDirty, pondDirty, onDirty]);
  const [openedQuestions, setOpenedQuestions] = useState(false);
  const [openedPond, setOpenedPond] = useState(false);
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
  const path = '/live/scripts/versions/' + v.id;
  function change(update: Partial<ScriptVersion>) {
    setV((old) => ({ ...old, ...update, outline: update.outline ?? old.outline }));
    setVersionDirty(true);
    setMsg('');
  }
  async function save() {
    setBusy(true);
    setMsg('');
    try {
      const { revision } = await api<{ revision: number }>(path, {
        method: 'PUT',
        body: {
          name: v.name,
          notes: v.notes,
          body: v.body,
          cues: v.cues,
          revision: v.revision,
          outline: v.outline,
        },
      });
      setV((old) => ({ ...old, name: v.name.trim(), revision }));
      onName(v.name.trim());
      setVersionDirty(false);
      setMsg('已保存');
      setEdit(false);
      setSection('script');
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
        {versionDirty && <small>尚未保存</small>}
        {section !== 'questions' && section !== 'pond' && (versionDirty || edit) && manage && (
          <button className="primary-button" disabled={!v.name.trim()} onClick={save}>
            保存版本
          </button>
        )}
        {section !== 'questions' && section !== 'pond' && manage && (
          <button
            className="secondary-button"
            onClick={() => {
              setEdit(!edit);
              setSection('script');
            }}
          >
            {edit ? '预览话术' : '编辑版本'}
          </button>
        )}
      </div>
      <div className="sc-edit-tabs" role="group" aria-label="编辑分区">
        {(
          [
            ['script', '正文与标注'],
            ['questions', '问题库'],
            ['pond', '鱼塘问题库'],
            ['assets', '素材库'],
            ['info', '版本资料'],
          ] as const
        )
          .filter(([key]) => edit || key === 'script' || key === 'questions' || key === 'pond')
          .map(([key, label]) => (
            <button
              key={key}
              aria-pressed={section === key}
              onClick={() => {
                setSection(key);
                if (key === 'questions') setOpenedQuestions(true);
                if (key === 'pond') setOpenedPond(true);
              }}
            >
              {label}
            </button>
          ))}
      </div>
      {openedQuestions && (
        <div hidden={section !== 'questions'}>
          <ProductQuestionArticle
            folder={v.folderId}
            title={folderTitle}
            manage={manage}
            onDirty={setQuestionDirty}
          />
        </div>
      )}
      {openedPond && (
        <div hidden={section !== 'pond'}>
          <PondQuestionArticle manage={manage} onDirty={setPondDirty} />
        </div>
      )}
      {edit ? (
        <>
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
            <ScriptArticleEditor
              v={v}
              change={change}
              onSelect={(s) => {
                selection.current = s;
              }}
              onMark={openPicker}
            />
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
          <div hidden={section !== 'script'}>
            {v.notes && <p className="sc-notes">{v.notes}</p>}
            <ScriptPreview v={v} onMark={manage ? openPicker : undefined} />
          </div>
        </>
      )}
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
          {Object.entries(categories)
            .filter(([key]) => edit || key === 'script' || key === 'questions')
            .map(([key, label]) => {
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
