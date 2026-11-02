import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {CodeCategoryDirectory} from './CodeCategoryDirectory';
import {resourceApi} from '../../../resources/api';
vi.mock('../../../auth/AuthContext',()=>({useAuth:()=>({can:()=>true})}));
vi.mock('../../../resources/FinanceCategoryManager',()=>({FinanceCategoryManager:({maxDepth,archiveType}:{maxDepth:number;archiveType?:string})=><div role="dialog">分类管理 {maxDepth} {archiveType}</div>}));
vi.mock('../../../resources/api',()=>({resourceApi:{categoryTree:vi.fn()}}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const tree={field:'categoryId',total:3,uncategorized:0,nodes:[{id:1,title:'种子',parentId:0,status:'active',sort:0,count:3},{id:2,title:'蔬菜',parentId:1,status:'active',sort:1,count:3},{id:3,title:'零资料分类',parentId:0,status:'active',sort:2,count:0}]};
describe('24号编码分类目录',()=>{
 it('保留零资料分类；父级数量直接用去重结果；默认展开一级',async()=>{
   vi.mocked(resourceApi.categoryTree).mockResolvedValue(tree);const onPick=vi.fn();render(<CodeCategoryDirectory type="finance-base-codes" status="pending" value="" onPick={onPick} onChanged={()=>{}}/>);
   await screen.findByRole('button',{name:'蔬菜'});expect(screen.getByRole('button',{name:'零资料分类'})).toBeTruthy();
   expect(screen.getByRole('button',{name:'种子'}).parentElement?.textContent).toBe('种子3');
   fireEvent.click(screen.getByRole('button',{name:'蔬菜'}));expect(onPick).toHaveBeenCalledWith('2');
   fireEvent.click(screen.getByRole('button',{name:'收起种子'}));expect(screen.queryByRole('button',{name:'蔬菜'})).toBeNull();
 });
 it('组合目录按当前验证状态查询独立分类，管理支持四级',async()=>{
   vi.mocked(resourceApi.categoryTree).mockResolvedValue(tree);render(<CodeCategoryDirectory type="finance-bundles" status="reverify" value="2" onPick={()=>{}} onChanged={()=>{}}/>);
   await waitFor(()=>expect(resourceApi.categoryTree).toHaveBeenCalledWith('finance-bundles',expect.objectContaining({field:'bundleCategoryId',status:'reverify',tab:'bundle'})));
   fireEvent.click(screen.getByRole('button',{name:'管理分类'}));expect(screen.getByRole('dialog').textContent).toContain('4 bundle');
 });
 it('读取失败可重试，不能把失败当成空分类',async()=>{
   vi.mocked(resourceApi.categoryTree).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(tree);render(<CodeCategoryDirectory type="finance-base-codes" status="pending" value="" onPick={()=>{}} onChanged={()=>{}}/>);
   await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'重试'}));await screen.findByRole('button',{name:'蔬菜'});
 });
});
