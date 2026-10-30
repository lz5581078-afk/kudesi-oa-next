import { useEffect, useState } from 'react';
import { unitYuanText } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';
import { FreightHistory } from './ReferenceProductFields';

export function BaseProfileSourceExtras({ source }: { source: ResourceDto }) {
 const [sources,setSources]=useState<ResourceDto[] | null>(null),[error,setError]=useState('');
 const hasSources=['raw','shipping_material'].includes(String(source.data.archiveType));
 useEffect(()=>{if(!hasSources)return;let alive=true;resourceApi.list('finance-product-sources',{fieldKey:'productId',fieldValue:source.id,pageSize:200}).then(r=>alive&&setSources(r.items)).catch(()=>alive&&setError('供货来源暂不可读。'));return()=>{alive=false;};},[source.id,hasSources]);
 return <>{hasSources&&<section className="base-profile-source-section"><h4>供货来源 <small>同一原料可维护多个产区和供应商</small></h4>{error?<p>{error}</p>:sources===null?<p>读取中…</p>:!sources.length?<p className="base-profile-source-empty">未维护供货来源</p>:<dl>{sources.map(r=><div key={r.id}><dt>{r.refLabels.supplierId||'供应商'}</dt><dd>{String(r.data.originArea||'—')}{r.data.purchasePrice!=null&&` · ¥${unitYuanText(Number(r.data.purchasePrice))}`}</dd></div>)}</dl>}</section>}{['freight','handlingFee','purchasePrice'].some(k=>source.data[k]!=null)&&<FreightHistory productId={source.id} values={source.data}/>}</>;
}
