import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import type { ResourceDef } from '@kudesi/shared';
import { MasterImportPage } from './MasterImportPage';

vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({can:()=>true})}));
vi.mock('../../resources/ImportDialog',()=>({ImportDialog:({def,embedded,onDone}:{def:ResourceDef;embedded:boolean;onDone:(message:string)=>void})=><section aria-label="资料导入"><p>{def.label} · {embedded?'页内预检':'弹窗预检'}</p><button onClick={()=>onDone('新增 2 条，更新 1 条')}>完成导入</button></section>}));
vi.mock('./DataToolPages',()=>({MasterResetPage:({embedded}:{embedded:boolean})=><p>{embedded?'同页清理范围与快照':'独立重置页'}</p>}));
afterEach(cleanup);

describe('商品数据导入页',()=>{
  it('按模块选择并在同一页预检，保留同页清理与快照入口',()=>{
    render(<MasterImportPage/>);
    expect(screen.getByText('商品分类 · 页内预检')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('导入类型'),{target:{value:'finance-base-codes'}});
    expect(screen.getByText('商品基础编码 · 页内预检')).toBeTruthy();
    expect(screen.queryByText('商品分类 · 页内预检')).toBeNull();
    expect(screen.getByText('同页清理范围与快照')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'完成导入'}));
    expect(screen.getByRole('status').textContent).toContain('新增 2 条，更新 1 条');
  });
});
