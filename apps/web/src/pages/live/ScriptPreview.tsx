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
  const points = [...new Set([0, v.body.length, ...v.cues.flatMap((c) => [c.start, c.end])])].sort(
    (a, b) => a - b,
  );
  const color = (id: number) => `hsl(${(v.assets.findIndex((a) => a.id === id) * 137 + 159) % 360} 55% 87%)`;
  function arrow(assetId: number, start: boolean) {
    const a = v.assets.find((x) => x.id === assetId);
    if (!a) return null;
    const label = start ? '展示 ' + a.name + ' →' : '← 撤下 ' + a.name;
    return (
      <button
        type="button"
        key={a.id}
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
          {points.slice(0, -1).map((start, i) => {
            const end = points[i + 1],
              spans = v.cues.filter((c) => c.start <= start && c.end >= end);
            const colors = [...new Set(spans.map((c) => color(c.asset)))];
            const focusAsset = v.assets.find((a) => a.id === spans[spans.length - 1]?.asset);
            const show = () => {
              if (focusAsset) setActive(focusAsset);
            };
            return (
              <div className="sc-line" key={start}>
                <aside>
                  {[...new Set(spans.filter((c) => c.start === start).map((c) => c.asset))].map((id) =>
                    arrow(id, true),
                  )}
                </aside>
                <span
                  onMouseEnter={show}
                  onClick={show}
                  style={{
                    background:
                      colors.length > 1 ? 'linear-gradient(to bottom,' + colors.join(',') + ')' : colors[0],
                  }}
                >
                  {v.body.slice(start, end)}
                </span>
                <aside>
                  {[...new Set(spans.filter((c) => c.end === end).map((c) => c.asset))].map((id) =>
                    arrow(id, false),
                  )}
                </aside>
              </div>
            );
          })}
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
