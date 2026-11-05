import { useEffect, useState } from 'react';
import { api } from '../../api/client';
export function ProductQuestionArticle({
  folder,
  title,
  manage,
  onDirty,
}: {
  folder: number;
  title: string;
  manage: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const path = '/live/scripts/folders/' + folder + '/question-article';
  const [article, setArticle] = useState<{ body: string; revision: number } | null>(null),
    [draft, setDraft] = useState(''),
    [edit, setEdit] = useState(false),
    [busy, setBusy] = useState(false),
    [msg, setMsg] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ body: string; revision: number }>(path)
      .then((r) => {
        if (live) {
          setArticle(r);
          setDraft(r.body);
          setMsg('');
        }
      })
      .catch((e) => {
        if (live) setMsg(e.message);
      });
    return () => {
      live = false;
    };
  }, [path, retry]);
  async function save() {
    if (!article) return;
    setBusy(true);
    try {
      const { revision } = await api<{ revision: number }>(path, {
        method: 'PUT',
        body: { body: draft, revision: article.revision },
      });
      setArticle({ body: draft, revision });
      onDirty(false);
      setEdit(false);
      setMsg('问题库已保存');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sc-question-article">
      <small>{title} · 产品资料</small>
      <header className="sc-article-head">
        <h2>产品问题库</h2>
        {article &&
          manage &&
          (edit ? (
            <div className="sc-bar">
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setDraft(article.body);
                  setEdit(false);
                  setMsg('');
                  onDirty(false);
                }}
              >
                取消
              </button>
              <button className="primary-button" disabled={busy} onClick={save}>
                保存问题库
              </button>
            </div>
          ) : (
            <button className="secondary-button" onClick={() => setEdit(true)}>
              编辑文章
            </button>
          ))}
      </header>
      {msg && <p role="status">{msg}</p>}
      {!article ? (
        msg ? (
          <button onClick={() => setRetry((r) => r + 1)}>重新读取</button>
        ) : (
          '正在读取…'
        )
      ) : edit ? (
        <textarea
          aria-label="产品问题库正文"
          className="sc-editor"
          disabled={busy}
          maxLength={100000}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onDirty(e.target.value !== article.body);
          }}
        />
      ) : (
        <article>{article.body || '还没有问题库正文。'}</article>
      )}
    </section>
  );
}
