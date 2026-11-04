import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplyPage } from './ApplyPage';
import { flowApi } from './flowApi';
import { skuApi } from './SkuApply';

vi.mock('./flowApi', async (orig) => ({ ...(await orig<typeof import('./flowApi')>()), flowApi: { templates: vi.fn(), start: vi.fn() } }));
vi.mock('./SkuApply', async (orig) => ({ ...(await orig<typeof import('./SkuApply')>()), skuApi: { startSplit: vi.fn() } }));
vi.mock('./RunDetail', () => ({ RunDetail: ({ id }: { id: number }) => <div>详情 #{id}</div> }));
vi.mock('./FlowFields', () => ({
  FlowFieldsForm: ({ onChange }: { onChange: (k: string, v: unknown) => void }) => (
    <button type="button" onClick={() => { onChange('specs', [{ name: 'A' }, { name: 'B' }]); onChange('splitSpecs', true); }}>填好</button>
  ),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('申请中心：SKU 规格独立办理', () => {
  it('勾选独立办理后走拆分接口，不带 splitSpecs 标记，并列出各条流程编号', async () => {
    vi.mocked(flowApi.templates).mockResolvedValue([{ key: 'sku-batch-apply', label: 'SKU 批量申请', description: '', active: true, fields: [], steps: [] }] as never);
    vi.mocked(skuApi.startSplit).mockResolvedValue({ batchKey: 'B1', runs: [{ id: 31, specName: 'A' }, { id: 32, specName: 'B' }], failed: [] });
    render(<MemoryRouter><ApplyPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText('发起申请'));
    fireEvent.click(screen.getByText('填好'));
    fireEvent.click(screen.getByRole('button', { name: /提交/ }));
    await screen.findByText(/拆成 2 条独立流程（#31、#32）/);
    expect(skuApi.startSplit).toHaveBeenCalledWith({ specs: [{ name: 'A' }, { name: 'B' }] }, expect.any(String));
    expect(flowApi.start).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('详情 #31')).toBeTruthy());
  });
});

it('拆分全失败保留现普通申请表单与同一requestKey，不能打开空汇总',async()=>{
 vi.mocked(flowApi.templates).mockResolvedValue([{key:'sku-batch-apply',label:'SKU 批量申请',description:'',active:true,fields:[],steps:[]}]as never);vi.mocked(skuApi.startSplit).mockResolvedValueOnce({batchKey:'Bempty',runs:[],failed:[{specName:'A',message:'合成失败'}]}).mockResolvedValueOnce({batchKey:'Bdone',runs:[{id:88,specName:'A'}],failed:[]});render(<MemoryRouter><ApplyPage/></MemoryRouter>);fireEvent.click(await screen.findByText('发起申请'));fireEvent.click(screen.getByText('填好'));fireEvent.click(screen.getByRole('button',{name:'提交申请'}));await screen.findByText(/所有规格均未发起成功/);expect(screen.getByRole('dialog',{name:/发起SKU/})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'提交申请'}));await screen.findByText('详情 #88');expect(vi.mocked(skuApi.startSplit).mock.calls[1]).toEqual(vi.mocked(skuApi.startSplit).mock.calls[0]);
});
