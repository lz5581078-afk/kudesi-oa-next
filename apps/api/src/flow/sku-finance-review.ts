import {sumUnitCents,yuanToPreciseCents} from '@kudesi/shared';

export interface ReviewLine {
  id:number; role:string; name:string; code:string; qty:number; identity:string;
  netG:number|null; weightG:number|null; cost:number|null; sale:number|null;
  capacityG:number|null; unit:string; valid:boolean;
}
export interface ReviewRow {
  key:string; runId:number; revision:number; name:string; note:string; group:string;
  platform:string; lines:ReviewLine[]; notRequired:Record<string,string>; warehouseDone:boolean; historyMissing?:Array<{role:string;count:number}>;
  sale:number|null; priceSource:string; cost:number|null; weightG:number|null;
}
export interface ReviewIssue {level:'difference'|'confirm'|'unknown';title:string;detail:string;keys:string[];roles:string[]}
export const grams=(value:unknown,unit:unknown):number|null=>{
  const n=Number(value),factor:Record<string,number>={'克':1,g:1,'千克':1000,'公斤':1000,kg:1000,'斤':500};
  return value!==null&&value!==undefined&&value!==''&&Number.isFinite(n)&&n>0&&factor[String(unit).trim().toLowerCase()]?n*factor[String(unit).trim().toLowerCase()]:null;
};
export function declaredQuantity(name:string){
  const main=name.split(/赠|送|加赠|附赠/)[0];
  if(/约|左右|以上|以下|\d\s*[-~～至]\s*\d/.test(main))return null;
  const matches=[...main.matchAll(/(\d+(?:\.\d+)?)\s*(公斤|千克|kg|克|g|斤)(?![a-z])/gi)];
  if(matches.length!==1)return null;
  const hit=matches[0],rest=main.slice(hit.index!+hit[0].length);
  const multiplier=rest.match(/^\s*[×xX*]\s*(\d+)\s*(袋|包|瓶|罐|盒|件)?/);
  const prefix=main.slice(0,hit.index).match(/(\d+)\s*(袋|包|瓶|罐|盒|件)\s*[×xX*]\s*$/);
  const count=multiplier?Number(multiplier[1]):prefix?Number(prefix[1]):null;
  return {grams:grams(hit[1],hit[2])!*(count??1),count,unit:multiplier?.[2]??prefix?.[2]??null};
}
export function declaredSale(name:string,note:string):number|null{
  const text=name+' '+note;
  const matches=[...text.matchAll(/(?:售价|卖价|销售价)\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,6})?)(?![\d.])\s*元?/g)];
  if(matches.length!==1||/(?:原价|活动价|到手价|优惠|起售|区间)/.test(text))return null;
  try{return yuanToPreciseCents(matches[0][1]);}catch{return null;}
}
const same=(a:number,b:number)=>Math.abs(a-b)<=Math.max(0.000001,Math.abs(a)*0.000001);
const amount=(n:number)=>`¥${(n/100).toFixed(2)}`;
const sum=(rows:ReviewLine[],field:'netG'|'weightG'|'cost')=>rows.some(l=>l[field]===null)?null:field==='cost'?sumUnitCents(rows.map(l=>l.cost!)):rows.reduce((v,l)=>v+l[field]!,0);
const parts=(r:ReviewRow,role:string)=>r.lines.filter(l=>l.role===role);
const mainNet=(r:ReviewRow)=>sum(parts(r,'main'),'netG');
const signature=(rows:ReviewLine[])=>JSON.stringify(rows.map(l=>[l.id,l.qty,l.netG]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
export function reviewSkuRows(rows:ReviewRow[]){
  const issues:ReviewIssue[]=[];
  const add=(level:ReviewIssue['level'],title:string,detail:string,rs:ReviewRow[],roles:string[])=>issues.push({level,title,detail,keys:rs.map(r=>r.key),roles});
  for(const r of rows){
    const main=parts(r,'main'),declared=declaredQuantity(r.name),net=mainNet(r);
    if(!main.length)add('unknown','缺少主商品','无法核对主品数量和净含量',[r],['main']);
    if(declared&&net!==null&&main.length&&!same(declared.grams,net))add('difference','名称净含量与组成不一致',`名称表示 ${declared.grams} 克；主品实际 ${net} 克，相差 ${Math.abs(declared.grams-net)} 克（不含赠品及包装）`,[r],['main']);
    if(!declared)add('unknown','名称规格需人工确认','未能从名称中唯一识别净含量；品种数字、范围、混合规格不作为重量推断',[r],['main']);
    if(main.some(l=>l.netG===null))add('unknown','净含量资料不足','基础规格缺少明确重量单位，不能用发货重量代替净含量',[r],['main']);
    if(declared?.count&&main.length===1&&main[0].unit===declared.unit&&!same(main[0].qty,declared.count))add('difference','包装件数与名称不一致',`名称 ${declared.count}${declared.unit}，实际选取 ${main[0].qty}${main[0].unit}`,[r],['main']);
    for(const l of r.lines){
      if(!(l.qty>0)||!Number.isFinite(l.qty))add('difference','组成数量无效',`${l.name}：数量 ${l.qty}`,[r],[l.role]);
      if(!l.valid)add('confirm','组成资料已失效或未验证',`${l.name}：请确认是否仍可使用`,[r],[l.role]);
      if(l.role!=='labor'&&l.weightG===null)add('unknown','发货重量缺失',`${l.name} 缺少可靠重量，发货合计不能视为完整`,[r],[l.role]);
      if(l.role==='package'&&net!==null&&l.capacityG!==null&&l.capacityG<net)add('confirm','包装容量可能不足',`${l.name} 合计容量 ${l.capacityG} 克，主品净含量 ${net} 克；请确认分装和内外包装方式`,[r],['package']);
    }
    if(r.cost===null)add('unknown','成本资料不足','存在成本缺失，不能完成成本梯度核对',[r],[]);
    if(r.sale===null)add('unknown','售价暂不可比',r.priceSource==='无售价查看权限'?'没有售价查看权限；仍核对数量、重量和成本':'未取得完整同口径售价；仍核对组成数量、重量和成本',[r],[]);
    else if(r.sale===0)add('confirm','售价为零','已读取到明确的零价，请确认是否为正常设置',[r],[]);
    for(const [role,label]of [['package','包装'],['label','标签说明书'],['other','打包材料'],['labor','人工']]){
      const group=r.lines.filter(l=>l.role===role||(role==='label'&&l.role==='instruction'));
      if(!group.length&&!r.notRequired[role])add('confirm',`${label}未配置`,r.warehouseDone?'没有配置，也没有无需原因，请确认是否遗漏':'仓库尚未完成，当前缺项仅供参考',[r],[role]);
    }
    for(const hint of r.historyMissing??[])add('confirm','与已验证同款的物料配置不同',`同主品、赠品和数量的 ${hint.count} 个历史已验证组合配置了${({package:'包装',label:'标签说明书',other:'打包材料',labor:'人工'} as Record<string,string>)[hint.role]}，本次未配置；请确认是否为有意调整`,[r],[hint.role]);
    for(const gift of parts(r,'gift'))for(const material of r.lines.filter(l=>!['main','gift','labor'].includes(l.role)))if(gift.identity===material.identity)add('confirm','赠品与发货物料可能重复',`${gift.name} 已作为赠品 ×${gift.qty}，又作为发货物料 ×${material.qty}`,[r],['gift',material.role]);
    for(const [word,roles]of [['说明书',['gift','instruction','label']],['合同',['gift','other','instruction']],['好评卡',['gift','other','label']],['贴纸',['label','other','gift']]] as Array<[string,string[]]>){
      if(!r.note.includes(word))continue;
      const actual=r.lines.filter(l=>roles.includes(l.role)&&l.name.includes(word));
      if(new RegExp(`(?:不放|不要|无需|不送|不含)\\s*${word}`).test(r.note)){if(actual.length)add('confirm','运营要求与物料不一致',`运营备注要求不放${word}，组成中存在${word}`,[r],roles);}
      else if(!actual.length)add('confirm','运营备注疑似未落实',`备注提到“${word}”，组成中未找到同名物料，请确认是否使用了其他名称`,[r],roles);
    }
  }
  const groups=new Map<string,ReviewRow[]>();
  for(const row of rows){if(!row.group)continue;const list=groups.get(row.group)??[];list.push(row);groups.set(row.group,list);}
  for(const list of groups.values()){
    list.sort((a,b)=>(declaredQuantity(a.name)?.grams??mainNet(a)??Infinity)-(declaredQuantity(b.name)?.grams??mainNet(b)??Infinity));
    for(let i=1;i<list.length;i++){
      const a=list[i-1],b=list[i],an=mainNet(a),bn=mainNet(b),ad=declaredQuantity(a.name),bd=declaredQuantity(b.name),sameMain=signature(parts(a,'main'))===signature(parts(b,'main'));
      const pair=[a,b],names=`「${a.name}」→「${b.name}」`;
      if(ad&&bd&&bd.grams>ad.grams&&sameMain)add('confirm','规格增加但主品数量没变',`${names}：名称净含量 ${ad.grams}→${bd.grams} 克，主品组成和数量完全相同，疑似漏改数量`,pair,['main']);
      const costs= a.cost!==null&&b.cost!==null ? `${amount(a.cost)}→${amount(b.cost)}` : '资料不足';
      const delta=['main','gift','package','label','instruction','other','labor'].flatMap(role=>{const x=sum(parts(a,role),'cost'),y=sum(parts(b,role),'cost');return x!==null&&y!==null&&!same(x,y)?[`${({main:'主品',gift:'赠品',package:'包装',label:'标签',instruction:'说明书',other:'物料',labor:'人工'} as Record<string,string>)[role]} ${amount(y-x)}`]:[];}).join('；');
      if(an!==null&&bn!==null&&bn>an&&a.cost!==null&&b.cost!==null&&b.cost<=a.cost)add('confirm','数量增加但成本未增加',`${names}：主品 ${an}→${bn} 克，成本 ${costs}。差额：${delta||'各项成本相同'}；请检查数量、基础规格或报价`,pair,['main']);
      if(a.sale===null||b.sale===null||a.priceSource!==b.priceSource)continue;
      if(an!==null&&bn!==null&&bn>an&&b.sale<a.sale)add('confirm','大规格售价低于小规格',`${names}：主品 ${an}→${bn} 克，${a.priceSource} ${amount(a.sale)}→${amount(b.sale)}；成本 ${costs}。${delta}。请确认数量、价格或优惠`,pair,['main']);
      if(a.sale>0&&b.sale>0&&an!==null&&bn!==null&&an>0&&bn>0){
        const unitRatio=(b.sale/bn)/(a.sale/an);
        if(unitRatio>1.5||unitRatio<0.5)add('confirm','单位售价变化较大',`${names}：每公斤 ${amount(a.sale/an*1000)}→${amount(b.sale/bn*1000)}，变化超过50%；成本 ${costs}。差额：${delta||'无'}。请确认是否选错数量、价格或为特价`,pair,['main']);
        if(bn/an>=1.8&&a.cost!==null&&b.cost!==null&&a.cost>0&&b.cost/a.cost>=1.8&&b.sale/a.sale<=1.1)add('confirm','数量与成本大幅增加，售价几乎未变',`${names}：主品 ${an}→${bn} 克，成本 ${costs}，${a.priceSource} ${amount(a.sale)}→${amount(b.sale)}。差额：${delta}；请确认是否重复选料或漏改价格`,pair,['main']);
        if(sameMain&&!same(a.sale,b.sale))add('confirm','主品数量相同但售价不同',`${names}：${a.priceSource} ${amount(a.sale)}→${amount(b.sale)}，成本 ${costs}。差额：${delta||'各组成成本相同'}；请核对规格数量及价格`,pair,['main']);
      }
    }
  }
  return {issues,rows:rows.map(r=>({...r,mainNetG:mainNet(r),giftWeightG:sum(parts(r,'gift'),'weightG'),materialWeightG:sum(r.lines.filter(l=>!['main','gift','labor'].includes(l.role)),'weightG'),unitSale:r.sale!==null&&mainNet(r)!>0?r.sale/mainNet(r)!*1000:null}))};
}
