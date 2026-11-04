import { RouterLeaveBlocker } from '../../resources/grid/LeaveGuard';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ScriptVersionPanel } from './ScriptVersionPanel';
import type { ScriptVersion } from './scriptCues';
import './scriptCenter.css';

interface Item {
  id: number;
  name: string;
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
  const [detail, setDetail] = useState<ScriptVersion | null>(null),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState('');
  const [creating, setCreating] = useState<'folder' | 'version' | null>(null);
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
        if (!retry) {
          const first = data.folders[0]?.id || 0;
          setFolder(first);
          setVersion(data.versions.find((v) => v.folderId === first)?.id ?? 0);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [retry]);
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
    return !dirty || window.confirm('当前版本有未保存的修改，放弃修改并切换？');
  }
  async function add(kind: 'folder' | 'version') {
    const name = (kind === 'folder' ? folderName : versionName).trim();
    if (!library || !name || !leave()) return;
    setBusy(true);
    setError('');
    try {
      const { id } = await api<{ id: number }>(
        kind === 'folder' ? base + '/folders' : base + '/folders/' + folder + '/versions',
        { body: { name } },
      );
      setDirty(false);
      setCreating(null);
      if (kind === 'folder') {
        setLibrary({ ...library, folders: [...library.folders, { id, name }] });
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
  const versions = library?.versions.filter((v) => v.folderId === folder) ?? [];
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
        <div className="sc-layout">
          <fieldset className="sc-nav" disabled={busy}>
            <div className="sc-nav-head">
              <h3>产品文件夹</h3>
              {manage && (
                <button
                  className="link-button"
                  aria-expanded={creating === 'folder'}
                  onClick={() => setCreating(creating === 'folder' ? null : 'folder')}
                >
                  ＋ 新建文件夹
                </button>
              )}
            </div>
            <select
              aria-label="产品文件夹"
              value={folder}
              onChange={(e) => {
                if (leave()) {
                  setDirty(false);
                  setFolder(+e.target.value);
                  setCreating(null);
                  setVersion(library.versions.find((v) => v.folderId === +e.target.value)?.id ?? 0);
                  setVersionName('');
                }
              }}
            >
              {!folder && <option value={0}>尚无产品文件夹</option>}
              {library.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            {manage && creating === 'folder' && (
              <div className="sc-bar">
                <input
                  aria-label="新产品文件夹名称"
                  placeholder="输入产品名称"
                  value={folderName}
                  maxLength={100}
                  onChange={(e) => setFolderName(e.target.value)}
                />
                <button
                  className="secondary-button"
                  disabled={!folderName.trim()}
                  onClick={() => add('folder')}
                >
                  新建文件夹
                </button>
              </div>
            )}
            {folder > 0 && (
              <>
                <div className="sc-nav-head">
                  <h3>话术版本</h3>
                  {manage && (
                    <button
                      className="link-button"
                      aria-expanded={creating === 'version'}
                      onClick={() => setCreating(creating === 'version' ? null : 'version')}
                    >
                      ＋ 新建版本
                    </button>
                  )}
                </div>
                {!versions.length && <small>此产品还没有话术版本。</small>}
                {versions.map((v) => (
                  <button
                    key={v.id}
                    aria-pressed={v.id === version}
                    className="sc-version-link"
                    onClick={() => {
                      if (v.id !== version && leave()) {
                        setDirty(false);
                        setVersion(v.id);
                      }
                    }}
                  >
                    {v.name}
                  </button>
                ))}
                {manage && creating === 'version' && (
                  <div className="sc-bar">
                    <input
                      aria-label="新版本名称"
                      placeholder="输入新版本名称"
                      value={versionName}
                      maxLength={100}
                      onChange={(e) => setVersionName(e.target.value)}
                    />
                    <button
                      className="secondary-button"
                      disabled={!versionName.trim()}
                      onClick={() => add('version')}
                    >
                      新建版本
                    </button>
                  </div>
                )}
              </>
            )}
          </fieldset>
          {detail && detail.id === version ? (
            <ScriptVersionPanel
              key={detail.id}
              initial={detail}
              manage={manage}
              dirty={dirty}
              onDirty={setDirty}
              onName={(name) =>
                setLibrary({
                  ...library,
                  versions: library.versions.map((v) => (v.id === version ? { ...v, name } : v)),
                })
              }
            />
          ) : (
            <p className="sc-empty">{version ? '正在读取版本…' : '选择产品和版本，查看话术及素材提示。'}</p>
          )}
        </div>
      )}
    </section>
  );
}
