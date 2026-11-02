import { useEffect, useRef, useState } from 'react';
import type { TimelineItem } from './liveApi';
import { hm } from './liveFormat';

const BAR_START = 6 * 60, BAR_SPAN = 20 * 60; // 06:00 到次日 02:00，沿用原时间条范围。
function barPos(t: string, day: string) {
  const minutes = Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) + (t.slice(0, 10) > day ? 1440 : 0);
  return Math.max(0, Math.min(100, (minutes - BAR_START) / BAR_SPAN * 100));
}

export function RoomTimeline({ items, day, now }: { items: TimelineItem[]; day: string; now: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(200);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => { const measured = el.getBoundingClientRect().width; if (measured > 0) setWidth(measured); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 相邻场次共用端点只标一次；按卡片实际宽度错开过近的标签。
  const boundaries = new Map<string, { at: string; hints: string[] }>();
  for (const item of items) {
    const planned = item.state === 'upcoming' || item.state === 'missed' || item.state === 'due';
    const endHint = item.state === 'live' ? (item.kind === 'schedule' ? '预计下播' : '直播进度') : planned ? '计划下播' : '下播';
    for (const [at, hint] of [[item.start, item.kind === 'schedule' ? '排场开播' : '开播'], [item.end, endHint]]) {
      const key = at.slice(0, 16);
      const boundary = boundaries.get(key) ?? { at, hints: [] };
      boundary.hints.push(`${hint} ${hm(at, day)}`);
      boundaries.set(key, boundary);
    }
  }
  const laneEnds: number[] = [];
  const labels = [...boundaries.values()].sort((a, b) => a.at.localeCompare(b.at)).map(boundary => {
    const text = hm(boundary.at, day), position = barPos(boundary.at, day);
    const labelWidth = Math.min(width, text.length * 5.5 + 2);
    const center = Math.max(labelWidth / 2, Math.min(width - labelWidth / 2, position / 100 * width));
    const left = center - labelWidth / 2;
    let lane = laneEnds.findIndex(end => end + 3 <= left);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = left + labelWidth;
    return { ...boundary, text, position, center, lane };
  });

  return <div ref={container} className="live-timeline" role="group" aria-label="当天排场时间条">
    {labels.length > 0 && <div className="live-timeline-times" style={{ height: laneEnds.length * 12 + 4 }}>
      {labels.map(label => <span key={label.at}>
        <small className="live-timeline-time" style={{ left: `${label.center / width * 100}%`, top: label.lane * 12 }} title={label.hints.join('；')} aria-label={label.hints.join('；')}>{label.text}</small>
        <i className="live-timeline-tick" style={{ left: `${label.position}%` }} aria-hidden="true" />
      </span>)}
    </div>}
    <div className="live-bar" aria-hidden="true">
      {items.map(item => <i key={`${item.kind}${item.id}`} className={item.state === 'done' ? 'done' : item.state === 'missed' || item.state === 'due' ? 'missed' : ''} style={{ left: `${barPos(item.start, day)}%`, width: `${Math.max(1.5, barPos(item.end, day) - barPos(item.start, day))}%` }} />)}
      {day === now.slice(0, 10) && <b style={{ left: `${barPos(now, day)}%` }} />}
    </div>
  </div>;
}
