import { DataSource, EntityManager } from 'typeorm';
import { AuthUser } from '../common/auth.decorators';
import { ResourceRecord } from '../entities';
import { bundleCatalog } from './bundle-catalog';
import { CostService } from './cost.service';
const record = Object.assign(new ResourceRecord(), {id:7,companyId:11,data:{salePrice:1200}});
const data = {lines:[{id:1,data:{bundleId:7,baseCodeId:2,role:'main',qty:3,unit:'袋'}},{id:2,data:{bundleId:7,baseCodeId:3,role:'package',qty:1,unit:'个'}}],baseCodes:new Map([[2,{title:'主品',data:{name:'番茄种子',styleCode:'FQ'}}],[3,{title:'纸盒',data:{}}]]),labor:new Map()};
const user = (allow:string[]):AuthUser=>({id:1,companyId:11,name:'test',permissions:{isCompanyAdmin:false,allow,deny:[]}});
describe('组合列表只读摘要',()=>{
  const load=jest.spyOn(CostService.prototype,'load');const row=jest.spyOn(CostService.prototype,'row');
  beforeEach(()=>{load.mockResolvedValue(data as never);row.mockReturnValue({weightG:1250,preShipCostCents:100.0123} as never);});
  afterEach(()=>jest.clearAllMocks());
  it('复用定点成本结果，分开组成和包装，不改记录',async()=>{
    const before=JSON.stringify(record);const result=(await bundleCatalog({} as DataSource,{} as EntityManager,user(['product.cost.view','product.price.view']),[record])).get(7)!;
    expect(result).toEqual({mainStyleCode:'FQ',weightG:1250,costCents:100.0123,saleCents:1200,composition:[{name:'番茄种子',qty:3,unit:'袋'}],packaging:[{name:'纸盒',qty:1,unit:'个'}]});
    expect(load).toHaveBeenCalledWith(11,expect.anything());expect(JSON.stringify(record)).toBe(before);
  });
  it('没有成本和售价查看权限时响应中不含价格字段',async()=>{
    const result=(await bundleCatalog({} as DataSource,{} as EntityManager,user([]),[record])).get(7)!;
    expect(result).not.toHaveProperty('costCents');expect(result).not.toHaveProperty('saleCents');expect(result.weightG).toBe(1250);
  });
  it('空列表不加载公司资料',async()=>{expect((await bundleCatalog({} as DataSource,{} as EntityManager,user([]),[])).size).toBe(0);expect(load).not.toHaveBeenCalled();});
});
