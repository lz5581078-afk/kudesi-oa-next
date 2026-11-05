import { expect, it } from 'vitest';
import { moveCues } from './scriptCues';

it('相同短句重复出现时用光标定位编辑，前插、段内增字和删除关联段分别处理', () => {
  const marked = [{ asset: 4, start: 2, end: 4 }];
  expect(moveCues('看看看看', '看看看看看', 1, marked)).toEqual([{ asset: 4, start: 3, end: 5 }]);
  expect(moveCues('看看看看', '看看看新看', 4, marked)).toEqual([{ asset: 4, start: 2, end: 5 }]);
  expect(moveCues('看看看看', '看看', 2, marked)).toEqual([]);
});

import { editStages, labelRange, reorderStage } from './scriptOutline';

it('跨环节标记保留整篇正文，移动环节后素材仍对应原文', () => {
  const outline = [
    { name: '互动', length: 2 },
    { name: '塑品', length: 3 },
    { name: '互动', length: 2 },
  ];
  expect(labelRange(outline, 1, 6, '追单')).toEqual([
    { name: '互动', length: 1 },
    { name: '追单', length: 5 },
    { name: '互动', length: 1 },
  ]);
  const moved = reorderStage(outline, '甲乙丙丁戊己庚', [{ asset: 9, start: 1, end: 4 }], 0, 2);
  expect(moved.body).toBe('丙丁戊己庚甲乙');
  expect(moved.cues.map((c) => moved.body.slice(c.start, c.end))).toEqual(['丙丁', '乙']);
});

it('整篇编辑时可选中空环节开始写，跨环节替换后保留两侧原文的归属', () => {
  let stages = ['留人', '互动', '塑品'].map((name) => ({ name, length: 0 }));
  stages = editStages(stages, 0, 0, 5, 0);
  stages = editStages(stages, 5, 5, 5, 1);
  expect(stages.map((s) => s.length)).toEqual([5, 5, 0]);
  expect(editStages(stages, 3, 7, 4, 0).map((s) => s.length)).toEqual([7, 3, 0]);
});

import { removeStage, splitStage, moveStageText } from './scriptOutline';
import { replaceCueRange } from './scriptCues';

it('同样的句子在多章重复出现时，只调整实际编辑章后的标注', () => {
  expect(replaceCueRange([{asset:1,start:0,end:2},{asset:2,start:2,end:4}], 2, 2, 1))
    .toEqual([{asset:1,start:0,end:2},{asset:2,start:3,end:5}]);
});
it('拆分整篇和选区成章不改正文与UTF16素材偏移，空章节也可独立写入', () => {
  const a = {body:'甲😀乙丙',outline:[{name:'原稿',length:5}],cues:[{asset:1,start:1,end:3}]};
  expect(splitStage(a,0,3,3,'讲解')).toEqual({...a,outline:[{name:'原稿',length:3},{name:'讲解',length:2}]});
  expect(splitStage(a,0,1,3,'介绍')).toEqual({...a,outline:[{name:'原稿',length:1},{name:'介绍',length:2},{name:'原稿',length:2}]});
});
it('明确合并上一章或下一章保留全文，删除内容会截断跨界标注并移动后续偏移', () => {
  const a = {body:'甲乙丙丁戊己',outline:[{name:'一',length:2},{name:'二',length:2},{name:'三',length:2}],cues:[{asset:1,start:1,end:5},{asset:2,start:2,end:4}]};
  expect(removeStage(a,1,'previous').outline.map(s=>s.length)).toEqual([4,2]);
  expect(removeStage(a,1,'next').outline.map(s=>s.length)).toEqual([2,4]);
  expect(removeStage(a,1,'delete')).toEqual({body:'甲乙戊己',outline:[a.outline[0],a.outline[2]],cues:[{asset:1,start:1,end:3}]});
  expect(removeStage({...a,outline:[{name:'唯一',length:6}]},0,'delete').body).toBe(a.body);
});
it('选区移到前章或后章末尾，素材随原文字移动，未选文字仍留原章', () => {
  const a={body:'甲乙丙丁戊己',outline:[{name:'一',length:2},{name:'二',length:2},{name:'三',length:2}],cues:[{asset:1,start:2,end:3},{asset:2,start:4,end:6}]};
  for (const [target,body,lengths] of [[0,'甲乙丙丁戊己',[3,1,2]],[2,'甲乙丁戊己丙',[2,1,3]]] as const) {
    const r=moveStageText(a,1,target,0,1);
    expect(r.body).toBe(body); expect(r.outline.map(s=>s.length)).toEqual(lengths);
    expect(r.cues.filter(c=>c.asset===1).map(c=>r.body.slice(c.start,c.end))).toEqual(['丙']);
    expect(r.cues.filter(c=>c.asset===2).map(c=>r.body.slice(c.start,c.end))).toEqual(['戊己']);
  }
});
