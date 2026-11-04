import { useRef, useState } from 'react';
import { api } from '../../api/client';
import { ScriptPreview } from './ScriptPreview';
import { categories, moveCues, type Asset, type Category, type ScriptVersion } from './scriptCues';

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
  const [v, setV] = useState(initial),
    [edit, setEdit] = useState(manage && !initial.body);
  const [libraryOpen, setLibraryOpen] = useState(!initial.assets.length);
  const [asset, setAsset] = useState(0),
    [category, setCategory] = useState<Category>('image'),
    [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [msg, setMsg] = useState('');
  const body = useRef<HTMLTextAreaElement>(null),
    upload = useRef<HTMLInputElement>(null);
  const path = '/live/scripts/versions/' + v.id;
  function change(update: Partial<ScriptVersion>) {
    setV({ ...v, ...update });
    onDirty(true);
    setMsg('');
  }
  async function save() {
    setBusy(true);
    setMsg('');
    try {
      const { revision } = await api<{ revision: number }>(path, {
        method: 'PUT',
        body: { name: v.name, notes: v.notes, body: v.body, cues: v.cues, revision: v.revision },
      });
      setV({ ...v, name: v.name.trim(), revision });
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
  async function addFile() {
    if (!file || !name.trim()) return;
    if (file.size > 10 * 1024 * 1024) {
      setMsg('请选择 10 MB 以内的文件');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const data = new FormData();
      data.append('name', name.trim());
      data.append('category', category);
      data.append('file', file);
      const a = await api<Asset>(path + '/assets', { form: data });
      setV((old) => ({ ...old, assets: [...old.assets, a] }));
      setAsset(a.id);
      setName('');
      setFile(null);
      if (upload.current) upload.current.value = '';
      setMsg('素材已入库');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function mark() {
    const input = body.current;
    if (!input) return;
    const start = input.selectionStart,
      end = input.selectionEnd;
    if (start === end || !asset) {
      setMsg('请选中正文里的文字，再选择要展示的素材');
      return;
    }
    if (v.cues.some((c) => c.asset === asset && c.start < end && c.end > start)) {
      setMsg('同一素材在这段话里已有标注');
      return;
    }
    change({ cues: [...v.cues, { asset, start, end }].sort((a, b) => a.start - b.start) });
  }
  return (
    <fieldset className="sc-panel" disabled={busy}>
      <div className="sc-bar">
        <h2>{v.name}</h2>
        {dirty && <small>尚未保存</small>}
        {dirty && !edit && manage && (
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
          <details
            className="sc-library"
            open={libraryOpen}
            onToggle={(e) => setLibraryOpen(e.currentTarget.open)}
          >
            <summary>本版素材库（{v.assets.length}）</summary>
            <div className="sc-bar">
              <label>
                素材分类
                <select
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value as Category);
                    setFile(null);
                    if (upload.current) upload.current.value = '';
                  }}
                >
                  {Object.entries(categories).map(([k, t]) => (
                    <option key={k} value={k}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                素材名称（必填）
                <input
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：花育25籽粒特写"
                />
              </label>
              <label>
                素材文件（≤10 MB）
                <input
                  ref={upload}
                  type="file"
                  accept={category === 'video' ? 'video/mp4' : 'image/png,image/jpeg,image/gif,image/webp'}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <button className="secondary-button" disabled={!name.trim() || !file} onClick={addFile}>
                上传入库
              </button>
            </div>
            {Object.entries(categories).map(([k, t]) => (
              <p key={k}>
                <strong>{t}</strong>　
                {v.assets
                  .filter((a) => a.category === k)
                  .map((a) => a.name)
                  .join('、') || '暂无素材'}
              </p>
            ))}
          </details>
          <label>
            话术正文
            <textarea
              ref={body}
              rows={10}
              maxLength={30000}
              value={v.body}
              onChange={(e) =>
                change({
                  body: e.target.value,
                  cues: moveCues(v.body, e.target.value, e.target.selectionStart, v.cues),
                })
              }
            />
          </label>
          <p className="muted">选中要配素材的一段话。选区开头提示展示，结尾提示撤下。</p>
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
            <button className="secondary-button" disabled={!asset} onClick={mark}>
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
          <button className="primary-button" disabled={!v.name.trim()} onClick={save}>
            保存版本
          </button>
        </>
      ) : (
        <>
          {v.notes && <p className="sc-notes">{v.notes}</p>}
          <ScriptPreview v={v} />
        </>
      )}
      {msg && <p role="status">{msg}</p>}
    </fieldset>
  );
}
