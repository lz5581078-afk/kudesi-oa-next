import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingComponentFilter } from './PricingComponentFilter';
import { financeApi, type DebugComponents } from './financeApi';
vi.mock('./financeApi', () => ({ financeApi: { debugComponents: vi.fn() } }));
const data: DebugComponents = { categories:[{id:1,name:'水果',parentId:null},{id:2,name:'苹果',parentId:1}], rows:[{id:7,code:'APPLE-001',name:'红富士',categoryId:2}],total:1,page:1,pageSize:30 };
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable:true, value:vi.fn(function(this: HTMLDialogElement) { this.setAttribute('open',''); }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable:true, value:vi.fn(function(this: HTMLDialogElement) { this.removeAttribute('open'); }) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
describe('定价的商品编码目录', () => {
  it('使用模态目录，搜索全部商品后清空恢复原分类，选择商品带出真实ID与路径', async () => {
    vi.mocked(financeApi.debugComponents).mockResolvedValue(data);
    const change = vi.fn();
    render(<PricingComponentFilter value={{categoryId:2,label:'水果 / 苹果'}} onChange={change}/>);
    const opener = screen.getByRole('button',{name:'选择商品分类或商品'});
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog',{name:'选择商品分类或商品'});
    await within(dialog).findByRole('button',{name:/红富士 APPLE-001 水果 \/ 苹果/});
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText('搜索商品分类、名称或编码'),{target:{value:'红富士'}});
    await waitFor(() => expect(financeApi.debugComponents).toHaveBeenLastCalledWith({categoryId:undefined,keyword:'红富士',page:1}));
    expect(within(dialog).queryByRole('button',{name:'选择此分类'})).toBeNull();
    fireEvent.click(within(dialog).getByRole('button',{name:'清空搜索'}));
    await waitFor(() => expect(financeApi.debugComponents).toHaveBeenLastCalledWith({categoryId:2,keyword:undefined,page:1}));
    await within(dialog).findByRole('button',{name:/红富士 APPLE-001/});
    fireEvent.click(within(dialog).getByRole('button',{name:/红富士 APPLE-001/}));
    expect(change).toHaveBeenCalledWith({baseCodeId:7,categoryId:2,label:'红富士'});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it('搜索切换时拒绝迟到结果，Escape只关闭目录不修改筛选', async () => {
    let finish!: (value: DebugComponents) => void;
    vi.mocked(financeApi.debugComponents).mockImplementationOnce(() => new Promise(resolve => {finish=resolve;})).mockResolvedValue(data);
    const change=vi.fn();
    render(<PricingComponentFilter value={null} onChange={change}/>);
    fireEvent.click(screen.getByRole('button',{name:'选择商品分类或商品'}));
    await waitFor(() => expect(finish).toBeTruthy());
    fireEvent.change(screen.getByLabelText('搜索商品分类、名称或编码'),{target:{value:'苹果'}});
    await screen.findByRole('button',{name:/红富士 APPLE-001/});
    finish({...data,rows:[{id:8,code:'OLD',name:'过期商品',categoryId:1}]});
    await waitFor(() => expect(screen.queryByText('过期商品')).toBeNull());
    fireEvent.keyDown(screen.getByLabelText('搜索商品分类、名称或编码'),{key:'Escape'});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });
});
