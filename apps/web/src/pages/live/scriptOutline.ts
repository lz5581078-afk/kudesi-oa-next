import type { Cue, ScriptVersion } from './scriptCues';

export interface Stage {
  name: string;
  length: number;
}
export const defaultNames = ['留人', '互动', '塑品', '逼单', '追单'];
export function initialOutline(v: ScriptVersion): Stage[] {
  if (v.outline?.length) return v.outline;
  return [
    ...(v.body ? [{ name: '待分段', length: v.body.length }] : []),
    ...defaultNames.map((name) => ({ name, length: 0 })),
  ];
}
export function offsets(stages: Stage[]) {
  let end = 0;
  return stages.map((s) => {
    const start = end;
    end += s.length;
    return start;
  });
}
export function labelRange(stages: Stage[], start: number, end: number, name: string) {
  const starts = offsets(stages);
  return stages.flatMap((s, i) => {
    const a = starts[i],
      b = a + s.length;
    if (!s.length || b <= start || a >= end) return [s];
    return [
      ...(a < start ? [{ ...s, length: start - a }] : []),
      ...(a <= start ? [{ name, length: end - start }] : []),
      ...(b > end ? [{ ...s, length: b - end }] : []),
    ];
  });
}
export function reorderStage(stages: Stage[], body: string, cues: Cue[], from: number, to: number) {
  const starts = offsets(stages),
    order = stages.map((_, i) => i);
  order.splice(to, 0, order.splice(from, 1)[0]);
  const outline = order.map((i) => stages[i]),
    positions = offsets(outline);
  const moved = cues.flatMap((c) => {
    const pieces: Cue[] = [];
    order.forEach((i, j) => {
      const a = Math.max(c.start, starts[i]),
        b = Math.min(c.end, starts[i] + stages[i].length);
      if (a >= b) return;
      const start = positions[j] + a - starts[i],
        end = start + b - a;
      if (pieces.length && pieces[pieces.length - 1].end === start) pieces[pieces.length - 1].end = end;
      else pieces.push({ ...c, start, end });
    });
    return pieces;
  });
  return {
    outline,
    body: order.map((i) => body.slice(starts[i], starts[i] + stages[i].length)).join(''),
    cues: moved.sort((a, b) => a.start - b.start),
  };
}
