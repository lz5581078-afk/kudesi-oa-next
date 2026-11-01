import type { ResourceDef } from './resources';
import { money,o,ref,select,sensitive,text,textarea } from './resource-kit';

/** One physical account can have several original registrations. These rows
 * retain each registration without becoming additional cash/bank balances. */
export const BANK_HISTORY_RESOURCE_DEF:ResourceDef={
  key:'bank-account-history',label:'原账户登记',parent:{type:'bank-accounts',field:'bankAccountId'},readOnly:true,
  titleField:'accountName',uniqueField:'sourceId',statuses:[{value:'recorded',label:'原登记',tone:'muted'}],defaultStatus:'recorded',
  fields:[
    ref('bankAccountId','现账户','来源','bank-accounts',{required:true}),
    text('sourceId','原登记编号','来源',{required:true,list:true,search:true}),
    text('sourceCreatedAt','原创建时间','来源',{required:true,list:true}),
    select('sourceScope','原账户范围','来源',o('company:公司','store:店铺')),text('sourceStatus','原状态','来源',{list:true}),
    select('kind','原账户类型','原账户',o('company_public:公司公户','company_card:公司银行卡','cashier_account:出纳账户','store_public:店铺公户','store_personal_card:店铺个人银行卡'),{required:true,list:true}),
    text('accountName','户名','原账户',{required:true,list:true,search:true}),
    text('bank','开户行','原账户',{required:true,list:true}),
    sensitive('accountNo','账号/卡号','原账户',{required:true,list:true}),
    text('ownerName','所属人','原账户'),
    ref('licenseId','所属执照','原关联','licenses'),ref('storeId','关联店铺','原关联','stores'),
    ref('keeperUserId','原保管人','原关联','user',{list:true}),
    text('reservedPhoneNumber','预留手机','原关联'),text('reservedPhoneHolder','预留手机持有人','原关联'),
    ref('phoneId','关联手机号档案','原关联','phones'),
    text('customerNo','客户号','原公户信息'),ref('openingArchiveLocationId','开户档案位置','原公户信息','locations'),
    money('originalBalance','原登记余额','原对账',{help:'仅为旧登记快照，不参与现金银行余额或再次入账'}),
    select('reconcileCycle','原对账周期','原对账',o('monthly:按月','quarterly:按季','yearly:按年'),{list:true}),text('reconcileDay','原对账提醒日','原对账'),
    text('sourceArchivedAt','原归档时间','原归档'),ref('sourceArchivedBy','原归档人','原归档','user'),
    textarea('sourceArchiveReason','原归档原因','原归档'),text('sourceArchivedFromStatus','原归档前状态','原归档'),
    textarea('abnormalReason','原异常原因','原状态'),textarea('note','原备注','原状态'),
  ],
};
