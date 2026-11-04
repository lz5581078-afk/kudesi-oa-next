import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { categories, type Asset, type ScriptVersion } from './scriptCues';

export function ScriptPreview({ v }: { v: ScriptVersion }) {
  const [active, setActive] = useState<Asset | null>(null);
  const [media, setMedia] = useState<{ id: number; url?: string; error?: string } | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!active) return;
    let current = true;
    api<{ url: string }>(`/live/scripts/versions/${v.id}/assets/${active.id}/url`)
      .then((r) => {
        if (current) setMedia({ id: active.id, url: r.url });
      })
      .catch((e) => {
        if (current) setMedia({ id: active.id, error: e.message });
      });
    return () => {
      current = false;
    };
  }, [active, v.id]);
  // Keep each original paragraph together even when a cue starts mid-sentence.
  const paragraphs = Array.from(v.body.matchAll(/[^\n]*\n|[^\n]+$/g), (m) => {
    const start = m.index!,
      end = start + m[0].length;
    const cues = v.cues.filter((c) => c.start < end && c.end > start);
    const points = [
      ...new Set([start, end, ...cues.flatMap((c) => [Math.max(start, c.start), Math.min(end, c.end)])]),
    ].sort((a, b) => a - b);
    return { start, end, cues, points };
  });
  const color = (id: number) => `hsl(${(v.assets.findIndex((a) => a.id === id) * 137 + 159) % 360} 55% 87%)`;
  function arrow(assetId: number, start: boolean, position: number) {
    const a = v.assets.find((x) => x.id === assetId);
    if (!a) return null;
    const label = start ? '展示 ' + a.name + ' →' : '← 撤下 ' + a.name;
    return (
      <button
        type="button"
        key={a.id + ':' + position}
        aria-label={label}
        data-label={label}
        style={{ background: color(a.id) }}
        onFocus={() => setActive(a)}
        onMouseEnter={() => setActive(a)}
        onClick={() => setActive(a)}
      />
    );
  }
  return (
    <section className="sc-preview">
      <div className="sc-bar">
        <h3>中控跟读</h3>
        <button
          className="secondary-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(v.body);
              setNotice('已复制纯文案');
            } catch {
              setNotice('请选中正文复制');
            }
          }}
        >
          复制文案
        </button>
        <small role="status">{notice}</small>
      </div>
      {!!v.assets.length && (
        <details className="sc-library">
          <summary>浏览本版素材（{v.assets.length}）</summary>
          {Object.entries(categories).map(([key, label]) => (
            <div className="sc-bar" key={key}>
              <strong>{label}</strong>
              {v.assets
                .filter((a) => a.category === key)
                .map((a) => (
                  <button
                    key={a.id}
                    className="link-button"
                    onClick={() => setActive(a)}
                    onMouseEnter={() => setActive(a)}
                  >
                    {a.name}
                  </button>
                ))}
            </div>
          ))}
        </details>
      )}
      <div className="sc-reading">
        <div
          className="sc-lines"
          onCopy={(e) => {
            const selection = window.getSelection();
            if (!selection?.rangeCount) return;
            const range = selection.getRangeAt(0);
            if (!e.currentTarget.contains(range.commonAncestorContainer)) return;
            e.clipboardData.setData('text/plain', range.cloneContents().textContent ?? '');
            e.preventDefault();
          }}
        >
          {!v.body && <p className="muted">这个版本还没有正文。</p>}
          {paragraphs.map(({ start, end, cues, points }) => (
            <div className="sc-line" key={start}>
              <aside>{cues.filter((c) => c.start >= start).map((c) => arrow(c.asset, true, c.start))}</aside>
              <span className="sc-prose">
                {points.slice(0, -1).map((left, i) => {
                  const right = points[i + 1],
                    spans = cues.filter((c) => c.start <= left && c.end >= right);
                  const colors = [...new Set(spans.map((c) => color(c.asset)))];
                  const asset = v.assets.find((a) => a.id === spans[spans.length - 1]?.asset);
                  const show = () => {
                    if (asset) setActive(asset);
                  };
                  return (
                    <span
                      key={left}
                      onMouseEnter={show}
                      onClick={show}
                      style={{
                        background:
                          colors.length > 1
                            ? 'linear-gradient(to bottom,' + colors.join(',') + ')'
                            : colors[0],
                      }}
                    >
                      {v.body.slice(left, right)}
                    </span>
                  );
                })}
              </span>
              <aside>{cues.filter((c) => c.end <= end).map((c) => arrow(c.asset, false, c.end))}</aside>
            </div>
          ))}
        </div>
        {active && (
          <aside className="sc-media" aria-label="素材预览">
            <div className="sc-bar">
              <strong>
                {categories[active.category]} · {active.name}
              </strong>
              <button className="link-button" onClick={() => setActive(null)}>
                收起
              </button>
            </div>
            {media?.id !== active.id ? (
              '加载中…'
            ) : media.error ? (
              <p role="alert">{media.error}</p>
            ) : active.category === 'video' ? (
              <video key={active.id} controls playsInline src={media.url} />
            ) : (
              <img alt={active.name} src={media.url} />
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
