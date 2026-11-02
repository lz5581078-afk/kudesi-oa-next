import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import type { FieldDef } from '@kudesi/shared';
import { FlowFieldsForm } from './FlowFields';
import { liveApi } from '../live/liveApi';

vi.mock('../live/liveApi',()=>({liveApi:{session:vi.fn()}}));

it('待办审核复用逐店填报，保留各平台金额；空金额清除可提交数据',async()=>{
  vi.mocked(liveApi.session).mockResolvedValue({channels:[{accountId:1,accountName:'抖音号',platform:'douyin',storeIds:[10],stores:[{id:10,name:'抖音店',jstShopId:'D'}]},{accountId:2,accountName:'快手号',platform:'kuaishou',storeIds:[20],stores:[{id:20,name:'快手店',jstShopId:'K'}]}],reports:[{role:'anchor',storeLines:[{storeId:10,platform:'douyin',salesCents:10000,adSpendCents:0},{storeId:20,platform:'kuaishou',salesCents:20000,adSpendCents:0}]}]} as never);
  const fields:FieldDef[]=[{key:'finalSource',label:'最终来源',type:'select',group:'审核',options:[{value:'manual',label:'手工核定'}]},{key:'finalSalesCents',label:'手填最终销售额',type:'money',group:'审核'},{key:'storeLines',label:'逐店核定',type:'json',group:'审核'}];
  function Form(){const [values,setValues]=useState<Record<string,unknown>>({finalSource:'manual'});return <><FlowFieldsForm fields={fields} values={values} onChange={(k,v)=>setValues(old=>({...old,[k]:v}))} templateKey="live-session-review" context={{sessionId:7}}/><output data-testid="payload">{JSON.stringify(values)}</output></>;}
  render(<Form/>);
  await screen.findByLabelText('抖音店营业额');
  expect(screen.queryByLabelText('手填最终销售额')).toBeNull();
  fireEvent.change(screen.getByLabelText('抖音店营业额'),{target:{value:'125.50'}});
  await waitFor(()=>expect(JSON.parse(screen.getByTestId('payload').textContent!).storeLines[0].salesCents).toBe(12550));
  expect(JSON.parse(screen.getByTestId('payload').textContent!).storeLines[1].salesCents).toBe(20000);
  fireEvent.change(screen.getByLabelText('快手店营业额'),{target:{value:''}});
  expect(JSON.parse(screen.getByTestId('payload').textContent!).storeLines).toEqual([]);
  expect(screen.getByRole('alert').textContent).toContain('有效营业额');
});
