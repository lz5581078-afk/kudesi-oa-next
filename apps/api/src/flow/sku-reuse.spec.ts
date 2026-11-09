import 'reflect-metadata';
import type {EntityManager} from 'typeorm';
import {FlowEvent,FlowRun,FlowStep,ResourceRecord} from '../entities';
import {skuReuseLibrary} from './sku-reuse';
import type {AuthUser} from '../common/auth.decorators';

const user:AuthUser={id:1,name:"仓库",companyId:7,permissions:{isCompanyAdmin:false,allow:[],deny:[]}};
function fixture(){
 const steps=Array.from({length:101},(_,i)=>({id:101-i,runId:101-i,companyId:7,stepKey:'warehouse',status:'done',action:'pass',form:{_skuSource:{specs:[{name:'配置',main:[{baseCodeId:i===100?2:1,qty:1}]}]},config:[{lines:[],notRequired:{package:'无需'}}]}}));
 const find=jest.fn(async(entity,options)=>{
  if(entity===FlowStep)return options.where.runId?[]:options.where.id?steps.filter(step=>step.id===options.where.id):steps.slice(options.skip,options.skip+options.take);
  if(entity===FlowRun)return steps.map(step=>({id:step.runId,payload:{},currentStepKey:'review'}));
  if(entity===FlowEvent)return [];
  if(entity===ResourceRecord)return [{id:1,title:'最新商品',data:{name:'最新商品',code:'NEW',weightG:100}},{id:2,title:'历史苹果',data:{name:'历史苹果',code:'OLD-APPLE',weightG:500}}];
  throw new Error('unexpected entity');
 });
 return {em:{find} as unknown as EntityManager,find};
}
it('先搜索再限制100条：第101条历史商品仍可按名称和编码搜到，查询始终隔离公司',async()=>{
 for(const keyword of ['历史苹果','old-apple']){const {em,find}=fixture();const result=await skuReuseLibrary(em,user,keyword);expect(result.rows.map(row=>row.id)).toEqual(['1:0']);expect(result.rows[0].mainWeightG).toBe(500);expect(result.references.map(ref=>ref.id)).toEqual([2]);for(const [,options] of find.mock.calls)expect(options.where.companyId).toBe(7);expect(find.mock.calls.filter(([entity])=>entity===ResourceRecord)).toHaveLength(1);}
});
it('无搜索最多返回100个匹配结果，精确来源可以读取100条以外的历史',async()=>{
 const {em,find}=fixture();expect((await skuReuseLibrary(em,user,'')).rows).toHaveLength(100);expect(find.mock.calls.filter(([entity,options])=>entity===FlowStep&&!options.where.runId)).toHaveLength(1);
 expect((await skuReuseLibrary(em,user,'','1:0')).rows.map(row=>row.id)).toEqual(['1:0']);
});
