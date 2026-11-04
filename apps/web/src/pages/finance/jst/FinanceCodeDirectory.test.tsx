import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {FinanceCodeDirectory} from './FinanceCodeDirectory';
afterEach(cleanup);
it('四级目录沿原层级展开，同父子数量汇总且选择保留真实ID',()=>{
 const pick=vi.fn();render(<FinanceCodeDirectory cats={[{id:1,name:'一级',parentId:null},{id:2,name:'二级',parentId:1},{id:3,name:'三级',parentId:2},{id:4,name:'四级',parentId:3}]} counts={{4:2}} value={null} onPick={pick}/>);
 expect(screen.getByRole('button',{name:'一级 2'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'展开'}));fireEvent.click(screen.getByRole('button',{name:'展开'}));
 fireEvent.click(screen.getByRole('button',{name:'四级 2'}));expect(pick).toHaveBeenCalledWith(4);
 expect(screen.getAllByRole('treeitem').find(row=>row.getAttribute('aria-level')==='4')).toBeTruthy();
});
