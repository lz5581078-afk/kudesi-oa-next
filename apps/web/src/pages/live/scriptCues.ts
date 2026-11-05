export type Category = 'background' | 'image' | 'video';
export const categories = { background: '背景图', image: '图片', video: '视频' };
export interface Asset {
  id: number;
  name: string;
  category: Category;
}
export interface Cue {
  asset: number;
  start: number;
  end: number;
}
export interface ScriptVersion {
  id: number;
  folderId: number;
  outline?: import('./scriptOutline').Stage[] | null;
  faq?: {question:string;answer:string}[];
  faqRevision?:number;
  name: string;
  notes: string;
  body: string;
  cues: Cue[];
  revision: number;
  assets: Asset[];
}

// DOM selection and stored offsets both use UTF-16. Anchor edits to the actual caret,
// including when the same sentence occurs more than once.
export function editRange(before: string, after: string, caret: number) {
  let end = before.length,
    nextEnd = after.length;
  while (nextEnd > caret && end > 0 && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  let start = 0;
  while (start < end && start < nextEnd && before[start] === after[start]) start++;
  return {start,end,nextEnd};
}
export function moveCues(before: string, after: string, caret: number, cues: Cue[]): Cue[] {
  if (before === after) return cues;
  const {start,end,nextEnd}=editRange(before,after,caret);
  return replaceCueRange(cues, start, end, nextEnd - start);
}

// Use a known document range when editing a chapter, so repeated prose in other chapters cannot move the edit.
export function replaceCueRange(cues: Cue[], start: number, end: number, inserted: number): Cue[] {
  const delta = inserted - (end - start), nextEnd = start + inserted;
  return cues.flatMap((c) => {
    if (c.end <= start) return [c];
    if (c.start >= end) return [{ ...c, start: c.start + delta, end: c.end + delta }];
    const left = Math.min(c.start, start),
      right = c.end > end ? c.end + delta : nextEnd;
    return right > left ? [{ ...c, start: left, end: right }] : [];
  });
}
