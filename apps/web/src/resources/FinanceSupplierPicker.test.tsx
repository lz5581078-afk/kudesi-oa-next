import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { FinanceSupplierPicker } from './FinanceSupplierPicker';
vi.mock('./api', () => ({ resourceApi: { list: vi.fn() } }));
const row = (id: number, title: string, data = {}, status = 'active') => ({ id, title, data, status });
beforeEach(() => {
  vi.mocked(resourceApi.list).mockImplementation(async (type, params) => {
    const items = type === 'finance-supplier-categories' ? [row(1,'种子供应商'),row(2,'花生种子',{parentId:1}),row(3,'旧分类',{},'inactive')]
      : params?.page === 1 ? [row(10,'甲供应商',{shortName:'山东甲',code:'SDJ',categoryIds:[2]}),row(11,'停用供应商',{},'inactive')]
      : [row(12,'乙供应商',{code:'YI',categoryIds:[1]})];
    return { items, total: type === 'finance-suppliers' ? 3 : 3, page:params?.page ?? 1,pageSize:200 } as never;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('逐级显示直属供应商；搜索跨分类匹配简称、编号和分类路径；读取后续页', async () => {
  const onChange = vi.fn();
  render(<FinanceSupplierPicker value={10} onChange={onChange}/>);
  fireEvent.click(screen.getByRole('button',{name:'选择供应商'}));
  await screen.findByRole('heading',{name:'全部供应商 2 个'});
  expect(screen.queryByText('停用供应商')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'种子供应商'}));
  expect(screen.queryByRole('button',{name:/甲供应商/})).toBeNull();
  expect(screen.getByRole('button',{name:/乙供应商/})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'花生种子'}));
  expect(screen.getByRole('button',{name:/甲供应商/})).toBeTruthy();
  for (const word of ['YI','山东甲','种子供应商 / 花生种子']) {
    fireEvent.change(screen.getByRole('textbox',{name:'搜索供应商名称、简称或编号'}),{target:{value:word}});
    expect(screen.getByRole('heading',{name:'搜索结果 1 个'})).toBeTruthy();
  }
  fireEvent.click(screen.getByRole('button',{name:/甲供应商/}));
  expect(onChange).toHaveBeenCalledWith(10);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('简称编号：SDJ')).toBeTruthy();
});

it('读取失败保留原值，重试后才能选择；Escape只关闭选择窗口', async () => {
  vi.mocked(resourceApi.list).mockRejectedValueOnce(new Error('offline'));
  const onChange = vi.fn();
  render(<FinanceSupplierPicker value={10} labelNow="原供应商" onChange={onChange}/>);
  fireEvent.click(screen.getByRole('button',{name:'选择供应商'}));
  await screen.findByRole('alert');
  expect(screen.getByText('原供应商')).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'重新加载'}));
  await screen.findByRole('heading',{name:'全部供应商 2 个'});
  fireEvent.keyDown(document,{key:'Escape'});
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onChange).not.toHaveBeenCalled();
});
