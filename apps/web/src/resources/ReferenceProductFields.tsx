import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { unitYuanText, sumUnitCents, specificationWeightG, getResourceDef } from '@kudesi/shared';
import { resourceApi, type ResourceDto } from './api';
import { useUnitOptions, fieldOptions } from './unitOptions';

/** 多行编辑只改变呈现方式，仍保存原有的一行一项格式，兼容既有马甲和容量资料。 */
export function ReferenceLines({ kind, value, onChange }: { kind: 'finishedNames' | 'capacities'; value: unknown; onChange: (value: string) => void }) {
  const [lines, setLines] = useState(() => String(value ?? '').split(/\r?\n/).filter(Boolean));
  const units = useUnitOptions();
  const capacity = kind === 'capacities';
  const options = fieldOptions(getResourceDef('finance-products')!.fields.find(f => f.key === 'specUnit')!, {}, units);
  const write = (next: string[]) => { setLines(next); onChange(next.join('\n')); };
  useEffect(() => { if (String(value ?? '') !== lines.filter(Boolean).join('\n') && String(value ?? '') !== lines.join('\n')) setLines(String(value ?? '').split(/\r?\n/).filter(Boolean)); }, [value]); // retain newly added blank rows
  return <div className="reference-lines" data-field={capacity ? 'capacities' : 'rawFinishedNames'}>
    <div className="reference-lines-actions"><button type="button" className="secondary-button" onClick={() => setLines(v => [...v, ''])}><Plus size={15} />{capacity ? '增加容量' : '增加成品名'}</button></div>
    {lines.map((line, index) => {
      const match = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(line), qty = match?.[1] ?? '', unit = match?.[2] ?? '';
      return <div className="reference-line" key={index}><span>{String(index + 1).padStart(2, '0')}</span>{capacity ? <><label>容量 <b className="req">必填</b><input aria-label={`第${index + 1}条容量`} type="number" min="0" step="any" value={qty} onChange={e => write(lines.map((v, i) => i === index ? `${e.target.value}${unit}` : v))} /></label><label>单位 <b className="req">必填</b><select aria-label={`第${index + 1}条容量单位`} value={unit} onChange={e => write(lines.map((v, i) => i === index ? `${qty}${e.target.value}` : v))}><option value="">请选择单位</option>{unit && !options.some(o => o.value === unit) && <option value={unit}>{unit}</option>}{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label></> : <label>成品名<input aria-label={`第${index + 1}条成品名`} maxLength={160} value={line} onChange={e => write(lines.map((v, i) => i === index ? e.target.value : v))} placeholder="请输入原料对应的成品名" /></label>}<button type="button" className="link-button danger" aria-label={`删除第${index + 1}条${capacity ? '容量' : '成品名'}`} onClick={() => write(lines.filter((_, i) => i !== index))}><Trash2 size={16} /></button></div>;
    })}
    {!lines.length && <div className="reference-lines-empty">{capacity ? '点击“增加容量”维护适用容量。' : '暂无成品名，可按需增加。'}</div>}
  </div>;
}

export function FreightHistory({ productId, values }: { productId?: number; values: Record<string, unknown> }) {
  const [open, setOpen] = useState(false), [history, setHistory] = useState<ResourceDto[] | null>(null), [error, setError] = useState('');
  useEffect(() => { if (!open || !productId) return; let alive = true;
    (async () => { const rows: ResourceDto[] = []; for (let page = 1; ; page++) { const r = await resourceApi.list('finance-product-freight-history', { fieldKey: 'productId', fieldValue: productId, pageSize: 200, page, showHidden: true }); rows.push(...r.items); if (rows.length >= r.total || !r.items.length) break; } if (alive) setHistory(rows.sort((a,b) => b.createdAt.localeCompare(a.createdAt))); })().catch(e => alive && setError(e instanceof Error ? e.message : '历史读取失败'));
    return () => { alive = false; };
  }, [open, productId]);
  const number = (k: string) => values[k] === '' || values[k] == null || !Number.isFinite(Number(values[k])) ? null : Number(values[k]);
  const f = number('freight'), h = number('handlingFee'), p = number('purchasePrice');
  return <div className="reference-logistics s12"><div><small>运费装卸费汇总</small><strong>{f === null || h === null ? '待补齐' : `¥${unitYuanText(f + h)}`}</strong></div><div><small>关联系统规格</small><strong>{String(values.purchaseSpec || '—')}</strong></div><div><small>关联采购价</small><strong>{p === null ? '待补齐' : `¥${unitYuanText(p)}`}</strong></div><button type="button" className="secondary-button" disabled={!productId} aria-expanded={open} onClick={() => setOpen(v => !v)}>历史运费装卸费</button><p>手工修改运费、装卸费、系统规格或采购价时，保存后都会生成新的历史记录。</p>{open && <div className="reference-history">{error ? <p role="alert">{error}</p> : history === null ? '读取中…' : !history.length ? '暂无历史记录' : <table><thead><tr><th>记录时间</th><th>系统规格</th><th>采购价</th><th>运费</th><th>装卸费</th></tr></thead><tbody>{history.map(r => <tr key={r.id}><td>{r.createdAt}</td><td>{String(r.data.purchaseSpec ?? '')}</td>{['purchasePrice','freight','handlingFee'].map(k => <td key={k}>{r.data[k] == null ? '—' : `¥${unitYuanText(Number(r.data[k]))}`}</td>)}</tr>)}</tbody></table>}</div>}</div>;
}

/** 草稿核算结果只读；缺少报价时明确显示待补齐，不把缺失成本算成0。 */
export function CompositionResult({facts,values,canCost}:{facts:{cost:number|null;weightG:number|null;groups:Record<string,{cost:number|null;weightG:number}>;complete?:boolean};values:Record<string,unknown>;canCost:boolean}) {
  const g=(key:string)=>facts.groups[key]??{cost:0,weightG:0};
  const packaging=[g('package'),g('oem_package')];
  const packagingCost=packaging.some(p=>p.cost===null)?null:sumUnitCents(packaging.map(p=>p.cost!));
  const read=(key:string)=>values[key]==null||values[key]===''||!Number.isFinite(Number(values[key]))?null:Number(values[key]);
  const freight=read('freight'),handling=read('handlingFee');
  const logistics=freight===null||handling===null?null:sumUnitCents([freight,handling]);
  const oem=values.supplyMode==='supplier_oem';
  const rawPrice=read('purchasePrice');
  const componentCost=oem&&Object.keys(facts.groups).length===0&&facts.complete!==false?0:facts.cost;
  const total=componentCost===null||logistics===null||oem&&rawPrice===null?null:sumUnitCents([componentCost,logistics,oem?rawPrice!:0]);
  const rawWeight=oem?specificationWeightG(values.specQty,values.specUnit):g('raw').weightG;
  const combinedWeight=oem?(rawWeight??0)+packaging.reduce((s,p)=>s+p.weightG,0)+Number(values.oemPackageWeightG||0):facts.weightG;
  const totalWeight=values.weightManual===true&&values.weightG!=null?Number(values.weightG):combinedWeight;
  const parts=[{name:'原料',cost:oem?rawPrice:g('raw').cost,weight:rawWeight},{name:'包装',cost:packagingCost,weight:packaging.reduce((s,p)=>s+p.weightG,0)},{name:'运费装卸费',cost:logistics,weight:null},{name:'人工',cost:g('labor').cost,weight:null},{name:'成品汇总',cost:total,weight:totalWeight}];
  return <div className="reference-result-strip">{parts.map((part,i)=><div key={part.name} className={i===parts.length-1?'is-total':''}><small>{part.name}</small>{canCost&&<strong>{part.cost===null?'待补齐':`¥${unitYuanText(part.cost)}`}</strong>}<span>{part.weight===null?part.name==='人工'?'不计重量':'—':`${Math.round(part.weight/1000*1e9)/1e9} kg`}</span></div>)}</div>;
}
