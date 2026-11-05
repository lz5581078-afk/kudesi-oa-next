import { Fragment, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { categories, type Asset, type ScriptVersion } from './scriptCues';

import { initialOutline, offsets, stageAt } from './scriptOutline';
import { OutlineLayout } from './OutlineLayout';
import { AssetDownload } from './ScriptAssetLibrary';

export function ScriptPreview({
  v,
  onMark,
}: {
  v: ScriptVersion;
  onMark?: (start: number, end: number) => void;
}) {
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
  const stages = initialOutline(v),
    starts = offsets(stages);
  const paragraphs = stages.flatMap((stage, chapter) => {
    const text = v.body.slice(starts[chapter], starts[chapter] + stage.length);
    const matches = Array.from(text.matchAll(/[^\n]*\n|[^\n]+$/g));
    if (!matches.length) return [{ start: starts[chapter], end: starts[chapter], cues: [], points: [starts[chapter]], chapter, first: true }];
    return matches.map((m, line) => {
    const start = starts[chapter] + m.index!,
      end = start + m[0].length;
    const cues = v.cues.filter((c) => c.start < end && c.end > start);
    const points = [
      ...new Set([
        start,
        end,
        ...starts.filter((p) => p > start && p < end),
        ...cues.flatMap((c) => [Math.max(start, c.start), Math.min(end, c.end)]),
      ]),
    ].sort((a, b) => a - b);
    return { start, end, cues, points, chapter, first: line === 0 };
    });
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
      <OutlineLayout stages={stages}>
        <div className="sc-reading">
          <div
            className="sc-lines"
            onContextMenu={(e) => {
              const sel = window.getSelection();
              if (!onMark || !sel?.rangeCount || sel.isCollapsed) return;
              const range = sel.getRangeAt(0);
              if (!e.currentTarget.contains(range.commonAncestorContainer)) return;
              // Only count original prose; the arrow controls live outside each paragraph.
              function offset(node: Node, index: number) {
                const el = node instanceof Element ? node : node.parentElement;
                const prose = el?.closest<HTMLElement>('.sc-prose');
                if (!prose) return null;
                const prefix = document.createRange();
                prefix.selectNodeContents(prose);
                prefix.setEnd(node, index);
                return Number(prose.dataset.start) + prefix.toString().length;
              }
              const start = offset(range.startContainer, range.startOffset),
                end = offset(range.endContainer, range.endOffset);
              if (start !== null && end !== null && end > start) {
                e.preventDefault();
                onMark(start, end);
              }
            }}
            onCopy={(e) => {
              const selection = window.getSelection();
              if (!selection?.rangeCount) return;
              const range = selection.getRangeAt(0);
              if (!e.currentTarget.contains(range.commonAncestorContainer)) return;
              const parts = Array.from(e.currentTarget.querySelectorAll('.sc-prose')).flatMap((prose) => {
                if (!range.intersectsNode(prose)) return [];
                const part = document.createRange();
                part.selectNodeContents(prose);
                if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0)
                  part.setStart(range.startContainer, range.startOffset);
                if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0)
                  part.setEnd(range.endContainer, range.endOffset);
                return [part.toString()];
              });
              e.clipboardData.setData('text/plain', parts.join(''));
              e.preventDefault();
            }}
          >
            {!v.body && <p className="muted">这个版本还没有正文。</p>}
            {paragraphs.map(({ start, end, cues, points, chapter, first }) => (
              <Fragment key={chapter + ':' + start}>
              {first && <h4 className="sc-reading-heading" data-stage={chapter}>第 {chapter + 1} 章 · {stages[chapter].name}</h4>}
              {start === end ? <p className="muted">本章尚未填写</p> : <div className="sc-line">
                <aside>
                  {cues.filter((c) => c.start >= start).map((c) => arrow(c.asset, true, c.start))}
                </aside>
                <span className="sc-prose" data-start={start}>
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
                        data-stage={stageAt(stages, left, -1)}
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
              </div>}
              </Fragment>
            ))}
          </div>
          {active && (
            <aside className="sc-media" aria-label="素材预览">
              <div className="sc-bar">
                <strong>
                  {categories[active.category]} · {active.name}
                </strong>
                <AssetDownload version={v.id} asset={active} />
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
      </OutlineLayout>
    </section>
  );
}
