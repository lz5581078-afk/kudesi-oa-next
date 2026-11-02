import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FieldDef } from '@kudesi/shared';
import { FlowFieldsForm } from './FlowFields';
import { liveApi } from '../live/liveApi';

vi.mock('../live/liveApi',()=>({liveApi:{session:vi.fn()}}));
afterEach(cleanup);

it('待办审核复用逐店填报，保留各平台金额；空金额清除可提交数据',async()=>{
  vi.mocked(liveApi.session).mockResolvedValue({channels:[{accountId:1,accountName:'抖音号',platform:'douyin',storeIds:[10],stores:[{id:10,name:'抖音店',jstShopId:'D'}]},{accountId:2,accountName:'快手号',platform:'kuaishou',storeIds:[20],stores:[{id:20,name:'快手店',jstShopId:'K'}]}],reports:[{role:'anchor',storeLines:[{storeId:10,platform:'douyin',salesCents:10000,adSpendCents:0},{storeId:20,platform:'kuaishou',salesCents:20000,adSpendCents:0}]}]} as never);
  const fields:FieldDef[]=[{key:'finalSource',label:'最终来源',type:'select',group:'审核',options:[{value:'manual',label:'手工核定'}]},{key:'finalSalesCents',label:'手填最终销售额',type:'money',group:'审核'},{key:'storeLines',label:'逐店核定',type:'json',group:'审核'}];
  function Form(){const [values,setValues]=useState<Record<string,unknown>>({finalSource:'manual'});return <><FlowFieldsForm fields={fields} values={values} onChange={(k,v)=>setValues(old=>({...old,[k]:v}))} templateKey="live-session-review" context={{sessionId:7}}/><output data-testid="payload">{JSON.stringify(values)}</output></>;}
  render(<StrictMode><Form/></StrictMode>);
  await screen.findByLabelText('抖音店营业额');
  expect(screen.queryByLabelText('手填最终销售额')).toBeNull();
  fireEvent.change(screen.getByLabelText('抖音店营业额'),{target:{value:'125.50'}});
  await waitFor(()=>expect(JSON.parse(screen.getByTestId('payload').textContent!).storeLines[0].salesCents).toBe(12550));
  expect(JSON.parse(screen.getByTestId('payload').textContent!).storeLines[1].salesCents).toBe(20000);
  fireEvent.change(screen.getByLabelText('快手店营业额'),{target:{value:''}});
  expect(JSON.parse(screen.getByTestId('payload').textContent!).storeLines).toEqual([]);
  expect(screen.getByRole('alert').textContent).toContain('有效营业额');
});

it('待办审核按业务分组，工资字段与逐店金额不挤在一个网格中',async()=>{
  vi.mocked(liveApi.session).mockResolvedValue({channels:[],reports:[]} as never);
  const fields:FieldDef[]=[{key:'finalSource',label:'最终来源',type:'select',group:'审核',options:[{value:'anchor',label:'主播所报'}]},{key:'wageHourlyRateCents',label:'主播时薪',type:'money',group:'主播工资'},{key:'controlWageHourlyRateCents',label:'中控时薪',type:'money',group:'中控工资'}];
  render(<FlowFieldsForm fields={fields} values={{finalSource:'anchor'}} onChange={vi.fn()} templateKey="live-session-review" context={{sessionId:8}}/>);
  expect(within(screen.getByRole('group',{name:'主播工资'})).getByLabelText('主播时薪')).toBeTruthy();
  expect(within(screen.getByRole('group',{name:'中控工资'})).getByLabelText('中控时薪')).toBeTruthy();
  expect(within(screen.getByRole('group',{name:'审核'})).queryByLabelText('主播时薪')).toBeNull();
});
