import { expect, it } from 'vitest';
import { moveCues } from './scriptCues';

it('相同短句重复出现时用光标定位编辑，前插、段内增字和删除关联段分别处理', () => {
  const marked = [{ asset: 4, start: 2, end: 4 }];
  expect(moveCues('看看看看', '看看看看看', 1, marked)).toEqual([{ asset: 4, start: 3, end: 5 }]);
  expect(moveCues('看看看看', '看看看新看', 4, marked)).toEqual([{ asset: 4, start: 2, end: 5 }]);
  expect(moveCues('看看看看', '看看', 2, marked)).toEqual([]);
});
