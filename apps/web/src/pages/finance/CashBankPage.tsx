import {getResourceDef} from '@kudesi/shared';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Building2,Database,Landmark,Search,Store,WalletCards} from 'lucide-react';
import {useAuth} from '../../auth/AuthContext';
import {resourceApi} from '../../resources/api';
import {referenceMoney} from './common';
import {FinanceModal} from './FinanceModal';
import {financeApi,type BankBalance,type StoreFund} from './financeApi';
import {AccountNo,Fresh,KIND_LABEL,STORE_KINDS,has} from './query/AccountParts';
import {QueryPage,QueryPanel,QueryTable,type Col} from './query/QueryKit';
import {ReferenceSearch} from './query/ReferenceSearch';
import './cashBank.css';
const ACCOUNT_STATUSES=getResourceDef('bank-accounts')?.statuses??[];
const COMPANY_KINDS=['company_public','company_card','cashier_account'];
const sum=(rows:BankBalance[])=>rows.reduce((total,row)=>total+row.balanceCents,0);
type Data={banks:BankBalance[];stores:StoreFund[];keys:number[];numbers:Map<number,string>};
type Relation={title:string;accounts:BankBalance[]}|{title:string;stores:StoreFund[]};
export function CashBankPage(){const {user}=useAuth();return <CashBankQuery key={JSON.stringify([user?.companyId,user?.id,user?.permissions])}/>;}
function CashBankQuery(){
  const {can}=useAuth(),canRead=can('resource.bank-accounts.view');
  const [data,setData]=useState<Data|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[saveError,setSaveError]=useState(''),[saving,setSaving]=useState(false);
  const [keyword,setKeyword]=useState(''),[platform,setPlatform]=useState('all'),[opened,setOpened]=useState({funds:false,store:false,company:false}),[relation,setRelation]=useState<Relation|null>(null);
  const [now]=useState(()=>Date.now());const mounted=useRef(false),serial=useRef(0),working=useRef(false);
  const load=useCallback(async()=>{
    const request=++serial.current,current=()=>mounted.current&&serial.current===request;setLoading(true);setError('');
    const numbers=async()=>{
      const values=new Map<number,string>();if(!canRead)return values;let total:number|undefined;
      for(let page=1;;page++){
        if(!current())return values;const result=await resourceApi.list('bank-accounts',{page,pageSize:200,showHidden:true});if(!current())return values;
        if(total===undefined)total=result.total;else if(total!==result.total)throw new Error('读取期间账户资料发生变动，请重新打开页面。');
        for(const item of result.items){if(values.has(item.id))throw new Error('账户资料未能完整读取，请重新打开页面。');values.set(item.id,String(item.data.accountNo??''));}
        if(values.size===total)return values;if(!result.items.length||values.size>total)throw new Error('账户资料未能完整读取，请重新打开页面。');
      }
    };
    try{const [banks,stores,keys,accountNumbers]=await Promise.all([financeApi.banks(),financeApi.storeFunds(),financeApi.keyAccounts(),numbers()]);if(current())setData({banks,stores,keys,numbers:accountNumbers});}
    catch(error){if(current())setError(error instanceof Error?error.message:'账户资料读取失败');}finally{if(current())setLoading(false);}
  },[canRead]);
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;serial.current++;};},[load]);
  const banks=data?.banks??[],funds=data?.stores??[],keys=data?.keys??[];
  const accountText=useCallback((row:BankBalance)=>[row.bank,row.title,row.ownerName,canRead?data?.numbers.get(row.id):'',...row.storeNames??[],row.licenseName].join(' '),[data?.numbers,canRead]);
  const accountSearchText=(row:BankBalance)=>[accountText(row),row.kind,KIND_LABEL[row.kind],row.keeperName,row.balanceCents/100].join(' ');
  const accounts=useMemo(()=>banks.filter(row=>has(accountText(row),keyword)),[banks,accountText,keyword]);
  const stores=useMemo(()=>funds.filter(row=>(platform==='all'||row.platform===platform)&&has([row.name,row.platform,row.platformLabel,row.storeNo,row.platformStoreId].join(' '),keyword)),[funds,keyword,platform]);
  const platforms=[...new Map(funds.filter(row=>row.platform).map(row=>[row.platform!,row.platformLabel||row.platform!])).entries()];
  const storeAccounts=accounts.filter(row=>STORE_KINDS.includes(row.kind)),companyAccounts=accounts.filter(row=>COMPANY_KINDS.includes(row.kind)),keyAccounts=accounts.filter(row=>keys.includes(row.id));
  const withdrawable=stores.reduce((total,row)=>total+row.withdrawableCents,0);
  const toggle=async(id:number)=>{
    if(working.current||!data)return;working.current=true;setSaving(true);setSaveError('');const previous=data.keys,on=!previous.includes(id),request=serial.current,current=()=>mounted.current&&serial.current===request;
    setData({...data,keys:on?[...previous,id]:previous.filter(key=>key!==id)});
    try{const saved=await financeApi.setKeyAccount(id,on);if(current())setData(value=>value?{...value,keys:saved}:value);}
    catch(error){if(current()){setSaveError(error instanceof Error?error.message:'重点账户保存失败');try{const confirmed=await financeApi.keyAccounts();if(current())setData(value=>value?{...value,keys:confirmed}:value);}catch{if(current())setData(value=>value?{...value,keys:previous}:value);}}}
    finally{working.current=false;if(current())setSaving(false);}
  };
  const key:Col<BankBalance>={key:'key',head:'重点',cell:row=><button type="button" className="link-button" disabled={saving} onClick={()=>void toggle(row.id)}>{keys.includes(row.id)?'取消重点':'设为重点'}</button>,csv:row=>keys.includes(row.id)?'取消重点':'设为重点'};
  const A={
    type:{key:'type',head:'账户类型',cell:row=>KIND_LABEL[row.kind]||row.kind,csv:row=>KIND_LABEL[row.kind]||row.kind},
    name:{key:'name',head:'账户名称',cell:row=><strong className="cash-reference-main">{row.title||row.ownerName||'-'}</strong>,csv:row=>row.title||row.ownerName||'-'},
    bank:{key:'bank',head:'开户行',cell:row=>row.bank||'-',csv:row=>row.bank||'-'},
    no:{key:'no',head:'账号',cell:row=><AccountNo value={data?.numbers.get(row.id)} canView={canRead}/>,csv:row=>canRead?data?.numbers.get(row.id)||'':''},
    related:{key:'related',head:'关联主体/店铺',cell:row=>row.storeNames?.join('、')||row.licenseName||'-',csv:row=>row.storeNames?.join('、')||row.licenseName||'-'},
    balance:{key:'balance',head:'当前余额',cell:row=>referenceMoney(row.balanceCents),csv:row=>row.balanceCents/100},
    fresh:{key:'fresh',head:'余额最后更新',cell:row=><Fresh at={row.updatedAt} now={now}/>,csv:row=>row.updatedAt||''},
    status:{key:'status',head:'状态',cell:row=><span className={`cash-reference-status ${row.status}`}>{ACCOUNT_STATUSES.find(status=>status.value===row.status)?.label||row.status||'正常'}</span>,csv:row=>row.status},
    keeper:{key:'keeper',head:'保管人',cell:row=>row.keeperName||'-',csv:row=>row.keeperName||'-'},
    stores:{key:'stores',head:'关联店铺',cell:row=><button type="button" className="link-button" onClick={()=>setRelation({title:`${row.title||row.ownerName} / 关联店铺`,stores:funds.filter(store=>row.storeIds?.includes(store.storeId))})}>查看店铺</button>,csv:()=> '查看店铺'},
  } satisfies Record<string,Col<BankBalance>>;
  const accountTable=(rows:BankBalance[],cols:Col<BankBalance>[],caption:string,searchPlaceholder:string)=><QueryTable cols={cols} rows={rows} rowKey={row=>row.id} empty="暂无数据" caption={caption} foot={false} controls={{storageKey:`oa.finance.cash.${caption}.reference.v1`,pageSize:9999,searchPlaceholder,searchText:accountSearchText}}/>;
  const fundsCols:Col<StoreFund>[]=[
    {key:'store',head:'店铺',cell:row=><><strong className="cash-reference-main">{row.platformLabel||row.platform||'-'} / {row.name||'-'}</strong><small className="cash-reference-store-no">{row.storeNo||row.platformStoreId||'未填写店铺编号'}</small></>,csv:row=>`${row.platformLabel||row.platform||'-'} / ${row.name}`},
    ...([['withdrawableCents','可提现余额'],['depositCents','保证金'],['frozenCents','冻结资金'],['promotionCents','推广费余额']] as const).map(([field,head])=>({key:field,head,cell:(row:StoreFund)=><div className="finance-fund-amount"><strong>{referenceMoney(row[field])}</strong><Fresh at={row.updatedAt} now={now} compact/></div>,csv:(row:StoreFund)=>row[field]/100})),
    {key:'action',head:'操作',action:true,cell:row=><button type="button" className="link-button" onClick={()=>setRelation({title:`${row.name} / 关联收款账户`,accounts:banks.filter(account=>STORE_KINDS.includes(account.kind)&&account.storeIds?.includes(row.storeId))})}>查看账户</button>},
  ];
  const collapse=(title:string,detail:string)=><div className="cash-reference-collapsed"><strong>{title}</strong><span>{detail}</span></div>;
  const expand=(name:keyof typeof opened,count:number,store=false)=><button type="button" className="secondary-button" onClick={()=>setOpened(value=>({...value,[name]:!value[name]}))}>{opened[name]?store?'收起店铺资金':'收起账户':`展开 ${count} ${store?'家店铺':'个账户'}`}</button>;
  const metric=[['重点账户',data?`${keyAccounts.length} 个`:'—','purple'],['店铺可提现余额',data?referenceMoney(withdrawable):'—','green'],['店铺账户余额',data?referenceMoney(sum(storeAccounts)):'—','blue'],['公司账户余额',data?referenceMoney(sum(companyAccounts)):'—','amber']];
  return <QueryPage className="finance-reference-query cash-bank-reference" title="现金银行查询" subtitle="按电商资金路径查看重点账户、店铺可提现资金、店铺收款账户和公司层面账户余额。">
    <QueryPanel title="账户查询" icon={<Search size={18}/>}><div className="reference-query-filters"><label className="reference-query-keyword"><span>关键词</span><ReferenceSearch label="搜索账户" value={keyword} onChange={setKeyword} placeholder="搜索银行、账户名称、账号、主体或店铺"/></label></div></QueryPanel>
    {saveError&&<div className="notice error" role="alert">{saveError}</div>}
    <div className="reference-query-metrics" aria-label="汇总">{metric.map(([label,value,tone])=><div key={label} className={`reference-query-metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <QueryPanel title="重点账户" icon={<Landmark size={18}/>}>
      {loading||error?<section className="reference-query-empty" role={error?'alert':'status'}><Database size={34}/><h2>{error?'账户查询失败':'正在读取账户余额'}</h2><p>{error||'仅加载当前企业的账户资料。'}</p></section>:accountTable(keyAccounts,[A.type,A.name,A.bank,A.no,A.related,A.balance,A.fresh,{...key,head:'操作',action:true}],'重点账户','搜索重点账户')}
    </QueryPanel>
    {!loading&&!error&&data&&<>
      <QueryPanel title="店铺资金" icon={<Store size={18}/>} actions={expand('funds',stores.length,true)}>
        <div className="cash-reference-platforms" role="tablist" aria-label="平台"><button type="button" role="tab" aria-selected={platform==='all'} className={platform==='all'?'active':''} onClick={()=>setPlatform('all')}>全部店铺 <small>{funds.length}</small></button>{platforms.map(([key,label])=><button key={key} type="button" role="tab" aria-selected={platform===key} className={platform===key?'active':''} onClick={()=>setPlatform(key)}>{label} <small>{funds.filter(row=>row.platform===key).length}</small></button>)}</div>
        {opened.funds?<QueryTable cols={fundsCols} rows={stores} rowKey={row=>row.storeId} caption="店铺资金" empty="暂无数据" foot={false} controls={{storageKey:'oa.finance.cash.funds.reference.v1',pageSize:9999,searchable:false}}/>:collapse(`已折叠 ${stores.length} 家店铺资金`,`可提现余额合计 ${referenceMoney(withdrawable)}；选择平台后可按平台展开查看。`)}
      </QueryPanel>
      <QueryPanel title="店铺公户与店铺个人银行卡" icon={<WalletCards size={18}/>} actions={expand('store',storeAccounts.length)}>{opened.store?accountTable(storeAccounts,[A.type,A.name,A.bank,A.no,A.balance,A.fresh,A.status,A.stores,key],'店铺收款账户','搜索店铺收款账户'):collapse(`已折叠 ${storeAccounts.length} 个店铺收款账户`,`当前余额合计 ${referenceMoney(sum(storeAccounts))}；点击右上角展开后查看全部账户。`)}</QueryPanel>
      <QueryPanel title="公司账户" icon={<Building2 size={18}/>} actions={expand('company',companyAccounts.length)}>{opened.company?accountTable(companyAccounts,[A.type,A.name,A.bank,A.no,A.keeper,A.balance,A.fresh,A.status,key],'公司账户','搜索公司账户'):collapse(`已折叠 ${companyAccounts.length} 个公司账户`,`当前余额合计 ${referenceMoney(sum(companyAccounts))}；点击右上角展开后查看全部账户。`)}</QueryPanel>
    </>}
    {relation&&<FinanceModal presentation="reference" className="cash-reference-relations" title={relation.title} subtitle="当前有效的关联资料。" onClose={()=>setRelation(null)}>{'accounts'in relation?<QueryTable cols={[A.type,{...A.name,cell:row=>row.title||row.ownerName||'-'},A.bank,A.no,A.balance,A.fresh]} rows={relation.accounts} rowKey={row=>row.id} caption="关联收款账户" empty="暂无数据" foot={false} controls={{storageKey:'oa.finance.cash.relation-accounts.reference.v1',searchable:false}}/>:<QueryTable cols={[
      {key:'platform',head:'平台',cell:row=>row.platformLabel||row.platform||'-',csv:row=>row.platformLabel||row.platform||'-'},
      {key:'name',head:'店铺',cell:row=>row.name||'-',csv:row=>row.name||'-'},
      {key:'no',head:'店铺编号',cell:row=>row.storeNo||row.platformStoreId||'-',csv:row=>row.storeNo||row.platformStoreId||'-'},
      {key:'amount',head:'可提现余额',cell:row=>referenceMoney(row.withdrawableCents),csv:row=>row.withdrawableCents/100},
    ]} rows={relation.stores} rowKey={row=>row.storeId} caption="关联店铺" empty="暂无数据" foot={false} controls={{storageKey:'oa.finance.cash.relation-stores.reference.v1',searchable:false}}/>}</FinanceModal>}
  </QueryPage>;
}
