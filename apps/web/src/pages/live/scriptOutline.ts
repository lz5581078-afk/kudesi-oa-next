import { replaceCueRange, type Cue, type ScriptVersion } from './scriptCues';

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

// A boundary can belong to either neighbour, including an empty template stage.
// Prefer the stage the writer explicitly opened at that position.
export function stageAt(stages: Stage[], position: number, preferred: number) {
  const starts = offsets(stages);
  if (
    stages[preferred] &&
    position >= starts[preferred] &&
    position <= starts[preferred] + stages[preferred].length
  )
    return preferred;
  const i = stages.findIndex((s, j) => position >= starts[j] && position < starts[j] + s.length);
  return i < 0 ? Math.max(0, stages.length - 1) : i;
}
export function editStages(stages: Stage[], start: number, end: number, inserted: number, preferred: number) {
  const starts = offsets(stages),
    owner = stageAt(stages, start, preferred);
  return stages.map((s, i) => ({
    ...s,
    length:
      s.length -
      Math.max(0, Math.min(starts[i] + s.length, end) - Math.max(starts[i], start)) +
      (i === owner ? inserted : 0),
  }));
}


export type ScriptArticle = { outline: Stage[]; body: string; cues: Cue[] };

// Removing a heading must make its content destination explicit.
export function removeStage(article: ScriptArticle, index: number, destination: 'previous' | 'next' | 'delete'): ScriptArticle {
  const { outline, body, cues } = article;
  if (outline.length <= 1) return article;
  const start = offsets(outline)[index], length = outline[index].length;
  const stages = outline.filter((_, i) => i !== index).map((s) => ({ ...s }));
  if (destination === 'delete') return {
    outline: stages,
    body: body.slice(0, start) + body.slice(start + length),
    cues: replaceCueRange(cues, start, start + length, 0),
  };
  const target = destination === 'previous' ? index - 1 : index;
  if (!stages[target]) return article;
  stages[target].length += length;
  return { outline: stages, body, cues };
}

export function splitStage(article: ScriptArticle, index: number, from: number, to: number, name: string): ScriptArticle {
  const stage = article.outline[index];
  const outline = article.outline.slice();
  // A cursor splits the chapter; a selection becomes a chapter of its own.
  const end = from === to ? stage.length : to;
  outline.splice(index, 1,
    { ...stage, length: from },
    { name, length: end - from },
    ...(end < stage.length ? [{ ...stage, length: stage.length - end }] : []),
  );
  return { ...article, outline };
}

// Move the selected prose with its asset cues to the end of another chapter.
export function moveStageText(article: ScriptArticle, source: number, target: number, from: number, to: number): ScriptArticle {
  if (source === target || from >= to) return article;
  const pieces = article.outline.flatMap((s, i) => i === source
    ? [{ name: s.name, length: from }, { name: s.name, length: to - from }, { name: s.name, length: s.length - to }]
    : [s]);
  const selected = source + 1, destination = target < source ? target + 1 : target + 2;
  const moved = reorderStage(pieces, article.body, article.cues, selected, destination);
  const outline = article.outline.map((s, i) => ({ ...s, length: s.length + (i === source ? from - to : i === target ? to - from : 0) }));
  // Original chapter boundaries stay intact; only selected text changes chapters.
  return { ...moved, outline };
}
