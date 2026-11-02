import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TimelineItem } from './liveApi';
import { RoomTimeline } from './RoomTimeline';

afterEach(cleanup);
const day = '2026-11-02';
const item = (id: number, start: string, end: string): TimelineItem => ({ id, kind: 'adhoc', start: `${day} ${start}`, end: `${day} ${end}`, plannedEnd: `${day} ${end}`, state: 'done', sessionId: id, anchorName: '示例主播', controlName: null, operatorName: null, douyinName: '示例号' });

describe('全览时间轴起止标注', () => {
  it('相接场次的共同端点只标一次，窄卡近邻时间错层且不越出左右边界', () => {
    const { container } = render(<RoomTimeline items={[item(1,'12:00','12:10'),item(2,'12:10','12:20')]} day={day} now={`${day} 18:00`} />);
    expect(screen.getAllByText('12:10')).toHaveLength(1);
    expect(screen.getByText('12:10').getAttribute('aria-label')).toContain('下播 12:10');
    expect(screen.getByText('12:10').getAttribute('aria-label')).toContain('开播 12:10');
    const labels = [...container.querySelectorAll<HTMLElement>('.live-timeline-time')];
    expect(new Set(labels.map(e=>e.style.top)).size).toBeGreaterThan(1);
    expect(labels.every(e=>parseFloat(e.style.left)>=0 && parseFloat(e.style.left)<=100)).toBe(true);
  });
  it('跨日标明日期，直播中区分预计下播与当前进度', () => {
    const scheduled = {...item(1,'23:00','23:59'),kind:'schedule' as const,state:'live' as const,end:'2026-11-03 01:00'};
    const adhoc = {...item(2,'18:00','18:47'),state:'live' as const};
    render(<RoomTimeline items={[scheduled,adhoc]} day={day} now={`${day} 18:47`} />);
    expect(screen.getByText('11-03 01:00').getAttribute('title')).toContain('预计下播');
    expect(screen.getByText('18:47').getAttribute('title')).toContain('直播进度');
  });
  it('没有场次时保持原空时间条，不造开播下播时间', () => {
    const { container } = render(<RoomTimeline items={[]} day={day} now={`${day} 18:00`} />);
    expect(screen.getByRole('group',{name:'当天排场时间条'})).toBeTruthy();
    expect(container.querySelectorAll('.live-timeline-time')).toHaveLength(0);
  });
});
