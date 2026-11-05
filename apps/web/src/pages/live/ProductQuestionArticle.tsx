import { useEffect, useState } from 'react';
import { api } from '../../api/client';

type ArticleProps = { manage: boolean; onDirty: (dirty: boolean) => void };

export function ProductQuestionArticle({
  folder,
  title,
  ...props
}: ArticleProps & { folder: number; title: string }) {
  return (
    <QuestionArticleEditor
      key={folder}
      {...props}
      heading="产品问题库"
      caption={title + ' · 产品资料'}
      path={'/live/scripts/folders/' + folder + '/question-article'}
    />
  );
}

export function PondQuestionArticle({ manage, onDirty = () => undefined }: Partial<Pick<ArticleProps, 'onDirty'>> & Pick<ArticleProps, 'manage'>) {
  return (
    <QuestionArticleEditor
      manage={manage}
      onDirty={onDirty}
      heading="鱼塘问题库"
      caption="公司共享"
      path="/live/scripts/pond-question-article"
    />
  );
}

function QuestionArticleEditor({
  path,
  heading,
  caption,
  manage,
  onDirty,
}: ArticleProps & {
  path: string;
  heading: string;
  caption: string;
}) {
  const [article, setArticle] = useState<{ body: string; revision: number } | null>(null),
    [draft, setDraft] = useState(''),
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
      setMsg('问题库已保存');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sc-question-article">
      <small>{caption}</small>
      <header className="sc-article-head">
        <h2>{heading}</h2>
        {article && manage && (
          <button
            type="button"
            className="primary-button"
            disabled={busy || draft === article.body}
            onClick={save}
          >
            {busy ? '保存中…' : '保存问题库'}
          </button>
        )}
      </header>
      {msg && <p role="status">{msg}</p>}
      {!article ? (
        msg ? (
          <button onClick={() => setRetry((r) => r + 1)}>重新读取</button>
        ) : (
          '正在读取…'
        )
      ) : manage ? (
        <textarea
          aria-label={heading + '正文'}
          placeholder="在这里输入问题和解答…"
          className="sc-editor"
          disabled={busy}
          maxLength={100000}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setMsg('');
            onDirty(e.target.value !== article.body);
          }}
        />
      ) : (
        <article>{article.body || '还没有问题库正文。'}</article>
      )}
    </section>
  );
}
