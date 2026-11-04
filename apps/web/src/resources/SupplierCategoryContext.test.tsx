import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const load = vi.hoisted(()=>vi.fn());
vi.mock('./ResourceReferenceControls',()=>({loadRefOptions:load}));
import { SupplierCategoryContext } from './SupplierCategoryContext';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('种子供应商只显示种子末级多选，不把父级或其他种类供应商混入',async()=>{
  load.mockResolvedValue([{value:1,label:'种子供应商',leaf:false},{value:2,label:'种子供应商 / 花生',leaf:true},{value:3,label:'种子供应商 / 小麦',leaf:true},{value:4,label:'包装供应商 / 纸箱',leaf:true}]);
  const change=vi.fn();
  render(<SupplierCategoryContext value={[2]} onChange={change}/>);
  await screen.findByRole('checkbox',{name:'种子供应商 / 花生'});
  expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  fireEvent.click(screen.getByRole('checkbox',{name:'种子供应商 / 小麦'}));
  expect(change).toHaveBeenCalledWith([2,3]);
});
it('其他类型沿用原分类，没有跨类型多选入口',async()=>{
  load.mockResolvedValue([{value:4,label:'包装供应商 / 纸箱',leaf:true}]);
  render(<SupplierCategoryContext value={[4]} onChange={vi.fn()}/>);
  await screen.findByText('包装供应商 / 纸箱');
  expect(screen.queryByRole('checkbox')).toBeNull();
});
