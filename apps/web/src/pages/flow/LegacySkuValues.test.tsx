import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FieldDef } from '@kudesi/shared';
import { LegacyFlowValues } from './LegacySkuValues';
afterEach(cleanup);
const snapshot:FieldDef={key:'legacySkuPayload',label:'原SKU申请资料',type:'textarea',group:'原SKU快照',readonly:true};
describe('迁入前SKU资料只读展示',()=>{
  it('用中文字段和表格保留原编码、选项及精细数量，原稿没有编辑入口',()=>{
    const {container}=render(<LegacyFlowValues fields={[snapshot]} values={{legacySkuPayload:JSON.stringify({specName:'原规格',lines:[{sourceCode:'OLD-15',displayName:'原物料',role:'main',quantity:0.000001,isRequired:false,includeInJstBundle:true}],notRequired:{labor:'无需人工'}})}}/>);
    expect(screen.getByText('规格名称')).toBeTruthy();expect(screen.getByText('原规格')).toBeTruthy();
    expect(screen.getByText('原编码')).toBeTruthy();expect(screen.getByText('OLD-15')).toBeTruthy();
    expect(screen.getByText('0.000001')).toBeTruthy();expect(screen.getByText('主商品')).toBeTruthy();
    expect(screen.getByText('否')).toBeTruthy();expect(screen.getByText('是')).toBeTruthy();expect(screen.getByText('无需人工')).toBeTruthy();
    expect(screen.queryByText('specName')).toBeNull();expect(screen.queryByText('baseCodeId')).toBeNull();
    expect(container.querySelectorAll('input,textarea,button')).toHaveLength(0);
  });
  it('只展示接口声明可见的快照字段；原状态不和当前进度混写',()=>{
    const status:FieldDef={key:'legacyStatus',label:'原状态',type:'text',group:'迁入前记录',readonly:true};
    const cost:FieldDef={key:'legacySkuInspection',label:'原核对结果',type:'textarea',group:'原SKU快照',readonly:true,permission:'product.cost.view'};
    const values={legacyStatus:'returned',legacySkuInspection:JSON.stringify({totalCost:'0.000001',sources:[[15,'0.000002']]})};
    const view=render(<LegacyFlowValues fields={[status]} values={values}/>);
    expect(screen.getByText('已退回')).toBeTruthy();expect(screen.queryByText('原核对结果')).toBeNull();expect(screen.queryByText('0.000001')).toBeNull();
    view.rerender(<LegacyFlowValues fields={[status,cost]} values={values}/>);
    expect(screen.getByText('原核对总成本')).toBeTruthy();expect(screen.getByText('0.000001')).toBeTruthy();expect(screen.getByText('0.000002')).toBeTruthy();
  });
  it('普通自建流程的同名字段照常显示原值',()=>{
    render(<LegacyFlowValues fields={[{key:'legacySkuPayload',label:'普通文本',type:'textarea',group:'自建'},{key:'legacyStatus',label:'普通状态',type:'text',group:'自建'}]} values={{legacySkuPayload:'{"specName":"普通文本原值"}',legacyStatus:'returned'}}/>);
    expect(screen.getByText('{"specName":"普通文本原值"}')).toBeTruthy();expect(screen.getByText('returned')).toBeTruthy();expect(screen.queryByText('已退回')).toBeNull();
  });
});
