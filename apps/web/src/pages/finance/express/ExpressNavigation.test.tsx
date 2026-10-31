import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { ExpressPricesPage } from './ExpressPricesPage';
import { expressApi } from './expressApi';

vi.mock('../../../resources/RecordDetail',()=>({useResourceCan:()=>()=>true}));
vi.mock('../../../auth/AuthContext',()=>({useAuth:()=>({can:()=>true,user:{permissions:{isCompanyAdmin:true,allow:[],deny:[]}}})}));
vi.mock('./expressApi',()=>({expressApi:{tree:vi.fn()}}));
vi.mock('./VersionPanel',()=>({VersionPanel:()=> <div>版本价格明细</div>}));
const tree={carriers:[{id:1,name:'顺丰',status:'normal',note:'',defaultBranchId:2,branches:[{id:2,name:'济南网点',status:'normal',jstLogisticsName:'顺丰速运',contactName:'张',contactPhone:'',isDefault:true,currentVersionId:3,versions:[{id:3,name:'秋季报价',status:'active',cooperationStatus:'active',priceSource:'manual',effectiveStart:'2026-10-01',effectiveEnd:'',shippingWeightMin:0,shippingWeightMax:30,isCurrent:true,aiRuleCount:0,manualRuleCount:2,surchargeCount:1,inUse:true}]}]}]};
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('快递价格逐级浏览',()=>{
  it('先看公司网点，再进版本列表和详情，返回保留所选网点',async()=>{
    vi.mocked(expressApi.tree).mockResolvedValue(tree as never);render(<ExpressPricesPage/>);
    await screen.findByText('济南网点');expect(screen.queryByText('版本价格明细')).toBeNull();expect(screen.queryByText('秋季报价')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'查看价格表'}));await screen.findByRole('region',{name:'价格版本列表'});expect(screen.getByText('秋季报价')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'查看价格详情'}));await screen.findByText('版本价格明细');
    fireEvent.click(screen.getByRole('button',{name:'返回版本列表'}));expect(screen.queryByText('版本价格明细')).toBeNull();expect(screen.getByText('秋季报价')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'返回快递公司'}));await waitFor(()=>expect(screen.getByRole('button',{name:'查看价格表'})).toBeTruthy());
  });
});
