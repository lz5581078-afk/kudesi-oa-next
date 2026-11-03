import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
const mocks = vi.hoisted(() => ({ create:vi.fn(), getDraft:vi.fn(), saveDraft:vi.fn(), removeDraft:vi.fn(), api:vi.fn() }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({user:{permissions:{isCompanyAdmin:true,allow:[],deny:[]}}}) }));
vi.mock('../api/client', async orig => ({ ...await orig<typeof import('../api/client')>(), api: (...args:unknown[]) => mocks.api(...args) }));
vi.mock('./api', async orig => ({ ...await orig<typeof import('./api')>(), resourceApi:{...await orig<typeof import('./api')>().then(m => m.resourceApi),create:(...args:unknown[])=>mocks.create(...args),list:vi.fn().mockResolvedValue({items:[],total:0}),similarCheck:vi.fn().mockResolvedValue({warnings:[],blocked:[]})},draftApi:{key:()=> 'party-draft',get:()=>mocks.getDraft(),save:(...args:unknown[])=>mocks.saveDraft(...args),remove:()=>mocks.removeDraft()} }));
import { RecordForm } from './RecordForm';
beforeEach(() => { mocks.create.mockResolvedValue({id:8,title:'新资料',data:{}});mocks.getDraft.mockResolvedValue({draft:null});mocks.saveDraft.mockResolvedValue({});mocks.removeDraft.mockResolvedValue({});mocks.api.mockImplementation(async (_path:string,body:{body:{values:Record<string,unknown>}}) => ({code:'GYS-AUTO',shortCode:body.body.values.shortName==='简称'?'JC':'X'})); });
afterEach(() => {cleanup();vi.clearAllMocks();});
const mount = (type='finance-suppliers') => render(<RecordForm def={getResourceDef(type)!} record={null} initial={{categoryIds:[3],categoryId:3}} onClose={()=>undefined} onSaved={()=>undefined} onContinued={()=>undefined}/>);

it('供应商简称跟随名称直到人工修改，编号可预览和人工修正，继续新增保留分类并清空资料', async () => {
  mount();
  fireEvent.change(screen.getByLabelText(/供应商名称/),{target:{value:'甲种业'}});
  expect((screen.getByLabelText('供应商简称') as HTMLInputElement).value).toBe('甲种业');
  fireEvent.change(screen.getByLabelText('供应商简称'),{target:{value:'简称'}});
  fireEvent.change(screen.getByLabelText(/供应商名称/),{target:{value:'乙种业'}});
  expect((screen.getByLabelText('供应商简称') as HTMLInputElement).value).toBe('简称');
  await waitFor(()=>expect((screen.getByLabelText('供应商编号') as HTMLInputElement).value).toBe('GYS-AUTO'));
  expect((screen.getByLabelText('简称编号') as HTMLInputElement).value).toBe('JC');
  fireEvent.click(screen.getByRole('button',{name:'保存并继续新增'}));
  await screen.findByText(/可以继续新增/);
  expect(mocks.create).toHaveBeenCalledWith('finance-suppliers',expect.objectContaining({name:'乙种业',shortName:'简称',categoryIds:[3]}),'active');
  expect((screen.getByLabelText(/供应商名称/) as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('供应商简称') as HTMLInputElement).value).toBe('');
  fireEvent.change(screen.getByLabelText(/供应商名称/),{target:{value:'丙种业'}});
  fireEvent.click(screen.getByRole('button',{name:'保存草稿'}));
  await waitFor(()=>expect(mocks.saveDraft).toHaveBeenCalledWith('party-draft',expect.objectContaining({payload:expect.objectContaining({categoryIds:[3],name:'丙种业'})})));
});

it('费用保存并继续新增清空名称与备注，保留目录、挂账节点和费用口径', async () => {
  mount('finance-fee-items');
  expect((screen.getByLabelText('适用平台') as HTMLSelectElement).value).toBe('any');
  expect((screen.getByLabelText('是否走流程') as HTMLSelectElement).value).toBe('by_amount');
  fireEvent.click(screen.getByRole('button',{name:'店铺'}));
  fireEvent.click(screen.getByRole('button',{name:'手机号'}));
  fireEvent.change(screen.getByLabelText(/费用类型名称/),{target:{value:'测试费用'}});
  fireEvent.click(screen.getByRole('button',{name:'保存并继续新增'}));
  await screen.findByText(/可以继续新增/);
  expect((screen.getByLabelText(/费用类型名称/) as HTMLInputElement).value).toBe('');
  expect(mocks.create).toHaveBeenCalledWith('finance-fee-items',expect.objectContaining({categoryId:3,direction:'expense',defaultObject:'店铺、手机号'}),'active');
  expect(screen.getByRole('button',{name:'店铺'}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button',{name:'不固定'}));
  expect(screen.getByRole('button',{name:'店铺'}).getAttribute('aria-pressed')).toBe('false');
  expect(mocks.removeDraft).toHaveBeenCalled();
});
