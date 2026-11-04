import { expect, it } from 'vitest';
import { moveCues } from './scriptCues';

it('相同短句重复出现时用光标定位编辑，前插、段内增字和删除关联段分别处理', () => {
  const marked = [{ asset: 4, start: 2, end: 4 }];
  expect(moveCues('看看看看', '看看看看看', 1, marked)).toEqual([{ asset: 4, start: 3, end: 5 }]);
  expect(moveCues('看看看看', '看看看新看', 4, marked)).toEqual([{ asset: 4, start: 2, end: 5 }]);
  expect(moveCues('看看看看', '看看', 2, marked)).toEqual([]);
});

import { labelRange, reorderStage } from './scriptOutline';

it('跨环节标记保留整篇正文，移动环节后素材仍对应原文', () => {
  const outline = [{ name:'互动',length:2 },{name:'塑品',length:3},{ name:'互动',length:2 }];
  expect(labelRange(outline,1,6,'追单')).toEqual([{name:'互动',length:1},{name:'追单',length:5},{name:'互动',length:1}]);
  const moved=reorderStage(outline,'甲乙丙丁戊己庚',[{asset:9,start:1,end:4}],0,2);
  expect(moved.body).toBe('丙丁戊己庚甲乙');
  expect(moved.cues.map(c=>moved.body.slice(c.start,c.end))).toEqual(['丙丁','乙']);
});
