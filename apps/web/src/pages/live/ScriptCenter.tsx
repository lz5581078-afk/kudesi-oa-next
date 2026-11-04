import { ChevronRight, FileText, Folder } from 'lucide-react';
import { RouterLeaveBlocker } from '../../resources/grid/LeaveGuard';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ProductQuestionArticle } from './ProductQuestionArticle';
import { ScriptVersionPanel } from './ScriptVersionPanel';
import type { ScriptVersion } from './scriptCues';
import './scriptCenter.css';

interface Item {
  id: number;
  name: string;
  category?: string;
}
interface Library {
  folders: Item[];
  versions: (Item & { folderId: number })[];
}
const base = '/live/scripts';
export function ScriptCenter({ manage }: { manage: boolean }) {
  const [library, setLibrary] = useState<Library | null>(null),
    [folder, setFolder] = useState(0),
    [version, setVersion] = useState(0);
  const [entryFolder] = useState(() => Number(new URLSearchParams(location.search).get('questionArticle')));
  const [questions, setQuestions] = useState(false);
  const [detail, setDetail] = useState<ScriptVersion | null>(null),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState('');
  const [creating, setCreating] = useState<'folder' | 'version' | null>(null);
  const [classification, setClassification] = useState('');
  const [classifying, setClassifying] = useState(false);
  const [folderName, setFolderName] = useState(''),
    [versionName, setVersionName] = useState(''),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    api<Library>(base)
      .then((data) => {
        if (!live) return;
        setLibrary(data);
        if (retry === 0 && data.folders.some((f) => f.id === entryFolder)) {
          setFolder(entryFolder);
          setQuestions(true);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [retry, entryFolder]);
  useEffect(() => {
    let live = true;
    setDetail(null);
    if (version)
      api<ScriptVersion>(base + '/versions/' + version)
        .then((v) => {
          if (live) setDetail(v);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [version, retry]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function leave() {
    return !dirty || window.confirm('当前文章有未保存的修改，放弃修改并切换？');
  }
  async function add(kind: 'folder' | 'version') {
    const name = (kind === 'folder' ? folderName : versionName).trim();
    if (!library || !name || !leave()) return;
    setBusy(true);
    setError('');
    try {
      const { id } = await api<{ id: number }>(
        kind === 'folder' ? base + '/folders' : base + '/folders/' + folder + '/versions',
        { body: kind === 'folder' ? { name, category: classification.trim() } : { name } },
      );
      setDirty(false);
      setCreating(null);
      if (kind === 'folder') {
        setLibrary({
          ...library,
          folders: [...library.folders, { id, name, category: classification.trim() }],
        });
        setFolderName('');
        setFolder(id);
        setVersion(0);
      } else {
        setLibrary({ ...library, versions: [{ id, name, folderId: folder }, ...library.versions] });
        setVersionName('');
        setVersion(id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openLevel(folderId: number, versionId = 0, article = false) {
    if (busy || !leave()) return;
    setDirty(false);
    setCreating(null);
    setFolderName('');
    setVersionName('');
    setError('');
    setClassifying(false);
    setClassification('');
    setQuestions(article);
    setFolder(folderId);
    setVersion(versionId);
  }
  const versions = library?.versions.filter((v) => v.folderId === folder) ?? [];
  const folderTitle = library?.folders.find((f) => f.id === folder)?.name;
  const versionTitle = versions.find((v) => v.id === version)?.name;
  const kind = folder ? 'version' : 'folder';
  const itemName = folder ? '版本' : '文件夹';
  const draftName = folder ? versionName : folderName;
  const cards = folder ? versions : (library?.folders ?? []);
  const names = [...new Set((library?.folders ?? []).map((f) => f.category || '').filter(Boolean))].sort(
    (a, b) => a.localeCompare(b, 'zh-CN'),
  );
  const groups = folder
    ? ['']
    : [...new Set(['玉米种子', ...names, ''])].filter((key) => cards.some((c) => (c.category || '') === key));
  async function classify() {
    if (!library || busy) return;
    setBusy(true);
    try {
      const { category } = await api<{ category: string }>(base + '/folders/' + folder + '/category', {
        method: 'PUT',
        body: { category: classification.trim() },
      });
      setLibrary({
        ...library,
        folders: library.folders.map((f) => (f.id === folder ? { ...f, category } : f)),
      });
      setClassifying(false);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const categoryInput = (
    <label>
      产品分类
      <input
        list="sc-product-categories"
        maxLength={80}
        value={classification}
        placeholder="选择或输入品类"
        onChange={(e) => setClassification(e.target.value)}
      />
      <datalist id="sc-product-categories">
        {[...new Set(['玉米种子', ...names])].map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </label>
  );
  const Icon = folder ? FileText : Folder;
  return (
    <section className="sc-center card pad">
      <RouterLeaveBlocker
        when={dirty}
        onBlocked={(r) => {
          if (leave()) r.go();
          else r.cancel?.();
        }}
      />
      <header className="sc-title">
        <h2>话术中心</h2>
        {library && (
          <span>
            {library.folders.length} 个产品 · {library.versions.length} 个版本
          </span>
        )}
      </header>
      {error && (
        <p role="alert">
          {error}{' '}
          <button
            className="link-button"
            onClick={() => {
              if (leave()) {
                setDirty(false);
                setError('');
                setRetry((i) => i + 1);
              }
            }}
          >
            重新读取
          </button>
        </p>
      )}
      {!library ? (
        !error && '正在读取话术库…'
      ) : (
        <>
          {folder > 0 && (
            <nav className="sc-path" aria-label="话术目录路径">
              <button className="link-button" disabled={busy} onClick={() => openLevel(0)}>
                全部产品
              </button>
              <ChevronRight aria-hidden="true" size={15} />
              {version || questions ? (
                <>
                  <button className="link-button" onClick={() => openLevel(folder)}>
                    {folderTitle}
                  </button>
                  <ChevronRight aria-hidden="true" size={15} />
                  <strong aria-current="page">{questions ? '产品问题库' : versionTitle}</strong>
                </>
              ) : (
                <strong aria-current="page">{folderTitle}</strong>
              )}
            </nav>
          )}
          {questions ? (
            <ProductQuestionArticle
              folder={folder}
              title={folderTitle ?? ''}
              manage={manage}
              onDirty={setDirty}
            />
          ) : !version ? (
            <section className="sc-directory">
              <header className="sc-directory-head">
                <h3>{folder ? '话术版本' : '产品文件夹'}</h3>
                {manage && (
                  <button
                    type="button"
                    className="secondary-button"
                    aria-expanded={creating === kind}
                    disabled={busy}
                    onClick={() => {
                      setClassifying(false);
                      setClassification('');
                      setCreating(creating === kind ? null : kind);
                    }}
                  >
                    ＋ 新建{itemName}
                  </button>
                )}
              </header>
              {!!folder && (
                <button className="sc-question-entry" onClick={() => openLevel(folder, 0, true)}>
                  产品问题库 <small>查看产品问题文章 →</small>
                </button>
              )}
              {manage && !!folder && (
                <div className="sc-classify">
                  {classifying ? (
                    <form
                      className="sc-create"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void classify();
                      }}
                    >
                      {categoryInput}
                      <button className="secondary-button" disabled={busy}>
                        保存分类
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() => setClassifying(false)}
                      >
                        取消
                      </button>
                    </form>
                  ) : (
                    <button
                      className="link-button"
                      onClick={() => {
                        setCreating(null);
                        setClassification(library.folders.find((f) => f.id === folder)?.category || '');
                        setClassifying(true);
                      }}
                    >
                      调整产品分类 · {library.folders.find((f) => f.id === folder)?.category || '未分类'}
                    </button>
                  )}
                </div>
              )}
              {manage && creating === kind && (
                <form
                  className="sc-create"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!busy) void add(kind);
                  }}
                >
                  <input
                    autoFocus
                    aria-label={folder ? '新版本名称' : '新产品文件夹名称'}
                    maxLength={100}
                    placeholder={folder ? '输入版本名称' : '输入产品名称'}
                    value={draftName}
                    disabled={busy}
                    onChange={(e) => (folder ? setVersionName : setFolderName)(e.target.value)}
                  />
                  {!folder && categoryInput}
                  <button className="primary-button" disabled={busy || !draftName.trim()}>
                    创建
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => setCreating(null)}
                  >
                    取消
                  </button>
                </form>
              )}
              {cards.length ? (
                groups.map((group) => (
                  <section key={group} className="sc-product-group">
                    {!folder && <h4>{group || '未分类'}</h4>}
                    <div className="sc-tiles">
                      {cards
                        .filter((c) => folder || (c.category || '') === group)
                        .map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="sc-tile"
                            disabled={busy}
                            onClick={() => (folder ? openLevel(folder, item.id) : openLevel(item.id))}
                          >
                            <Icon className="sc-tile-icon" aria-hidden="true" size={26} />
                            <span>
                              <strong>{item.name}</strong>
                              <small>
                                {folder
                                  ? '打开话术'
                                  : library.versions.filter((v) => v.folderId === item.id).length + ' 个版本'}
                              </small>
                            </span>
                            <ChevronRight size={16} aria-hidden="true" />
                          </button>
                        ))}
                    </div>
                  </section>
                ))
              ) : (
                <p className="sc-empty">
                  {folder ? '这个产品还没有话术版本。' : '还没有产品文件夹。'}
                  {manage ? '点击上方新建即可开始。' : ''}
                </p>
              )}
            </section>
          ) : detail && detail.id === version ? (
            <>
              {' '}
              <ScriptVersionPanel
                key={detail.id}
                initial={detail}
                manage={manage}
                folderTitle={folderTitle ?? ''}
                onDirty={setDirty}
                onName={(name) =>
                  setLibrary({
                    ...library,
                    versions: library.versions.map((v) => (v.id === version ? { ...v, name } : v)),
                  })
                }
              />

            </>
          ) : (
            !error && <p className="sc-empty">正在读取版本…</p>
          )}
        </>
      )}
    </section>
  );
}
