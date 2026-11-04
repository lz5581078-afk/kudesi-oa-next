import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';
const mocks = vi.hoisted(() => ({ save: vi.fn(), draft: vi.fn(), pending: undefined as undefined | ((pending:boolean)=>void) }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: { isCompanyAdmin:true, allow:[], deny:[] } } }) }));
vi.mock('../api/client',async original=>{const actual=await original<typeof import('../api/client')>();return {...actual,api:vi.fn((path:string,options?:unknown)=>path==='/finance/products/code-preview'?Promise.resolve({code:'HC-REAL-PREVIEW',basicInfoFullName:'合成预览',manual:false,notes:[]}):actual.api(path,options as Parameters<typeof actual.api>[1]))};});
vi.mock('./ProductArchiveBrandSelect', () => ({ ProductArchiveBrandSelect: ({onPendingChange,onChange}:{onPendingChange?:(pending:boolean)=>void;onChange:(value:unknown)=>void}) => {
  mocks.pending = onPendingChange;
  return <button type="button" onClick={event => {onChange(null);onPendingChange?.(true);event.currentTarget.closest('form')?.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}}>新增品牌并同步提交</button>;
} }));
vi.mock('./api', async original => {
  const actual = await original<typeof import('./api')>();
  return {...actual, resourceApi:{...actual.resourceApi,saveForm:mocks.save,list:vi.fn(async()=>({items:[],total:0}))},draftApi:{...actual.draftApi,get:vi.fn(async()=>({draft:null})),save:mocks.draft}};
});
import { RecordForm } from './RecordForm';
import { resetUnitOptionsForTest } from './unitOptions';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('品牌请求开始的同一事件阻止提交，期间保存和草稿禁用；结束后恢复且回调身份稳定',async()=>{
  resetUnitOptionsForTest({});
  render(<RecordForm def={FINANCE_RESOURCE_DEFS.find(def=>def.key==='finance-products')!} record={null} initial={{archiveType:'self_made',categoryId:1,name:'合成成品'}} onClose={vi.fn()} onSaved={vi.fn()}/>);
  await waitFor(()=>expect(screen.queryByText('正在读取草稿…')).toBeNull());
  const handler = mocks.pending;
  fireEvent.click(screen.getByRole('button',{name:'新增品牌并同步提交'}));
  expect(screen.getByText('品牌正在保存，请稍后再保存档案。')).toBeTruthy();
  expect((screen.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button',{name:'保存草稿'}) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.pending).toBe(handler);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.draft).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'新增品牌并同步提交'}));
  // 请求失败也会通过同一完成回调解除门闩，输入由品牌控件保留。
  const {act}=await import('@testing-library/react');
  act(()=>mocks.pending?.(false));
  await waitFor(()=>expect((screen.getByRole('button',{name:'保存'}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole('button',{name:'保存草稿'}) as HTMLButtonElement).disabled).toBe(false);
});
