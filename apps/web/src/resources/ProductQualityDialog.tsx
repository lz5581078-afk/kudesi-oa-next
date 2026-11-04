import { useEffect, useRef, useState } from 'react';
import {X} from 'lucide-react';
import {useAuth} from '../auth/AuthContext';
import {referenceIdentity} from './referenceOptionsCache';
import {ProductZeroReasonInput,ProductZeroReasonManager,useProductQualityReasons} from './ProductQualityReasons';
import { archiveQualityContext, validSourceQualityConfirmation, type SourceQualityFacts, type SourceQualityConfirmations, archiveQualityFields, archiveQualityIssues, mergeQualityReasons, parseQualityReasons, LOGISTICS_CENT_SCALE, unitYuanText, type QualityField, type QualityOptions } from '@kudesi/shared';

const MONEY = new Set(['purchasePrice', 'freight', 'handlingFee']);
const confirmLabel = (f: QualityField) => (f.mode === 'weight' ? '确认不计重量' : f.mode === 'optionalGroup' ? '确认不需要' : '确认该项为0');

function valueText(f: QualityField, confirmedReason: string | undefined,values:Record<string,unknown>): string {
  if (confirmedReason) return `已确认：${confirmedReason}`;
  if (f.value === null || f.value === undefined || String(f.value).trim() === '') return '未填写';
  const n = Number(f.value);
  if (n === 0) return '0 · 待确认';
  if (MONEY.has(f.id)||f.id.endsWith(':purchasePrice')) return unitYuanText(n,['freight','handlingFee'].includes(f.id)?LOGISTICS_CENT_SCALE:4);
  if(f.id==='weightG'){const packaging=['package','oem_package'].includes(String(values.archiveType)),unit=packaging?String(values.weightUnit||'g'):'kg',factor=unit==='g'?1:unit==='jin'?500:1000;return `${n/factor} ${unit==='g'?'克':unit==='jin'?'斤':packaging?'千克':'kg'}`;}
  return `${f.value}${f.unit ? ` ${f.unit}` : ''}`;
}

/**
 * 核算资料确认（旧 ArchiveQualityConfirmation）：保存商品档案前，逐项列出采购价、运费、装卸费、重量、包装/人力组成等，
 * 填 0 或空的要选或写原因后“确认该项为0”；下面列出还没完成的项目，没有未完成项才能“确认并保存”。
 * 原因写进档案的“零值说明”（每项一行）。
 */
type Props={values:Record<string,unknown>;options:QualityOptions;onCancel:()=>void;onConfirm:(next:Record<string,unknown>)=>void|Promise<void>};
export function ProductQualityDialog(props:Props){const{user}=useAuth();return <QualityDialog key={referenceIdentity(user)} {...props}/>;}
function QualityDialog({values,options,onCancel,onConfirm}:Props){
  const [form, setForm] = useState<Record<string, unknown>>(values);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sourceFacts,setSourceFacts]=useState<SourceQualityFacts|undefined>(options.sourceFacts),[confirmations,setConfirmations]=useState<SourceQualityConfirmations>(options.confirmations??{});
  const qualityOptions={...options,...(sourceFacts?{sourceFacts,confirmations}:{})};
  const context=sourceFacts?archiveQualityContext(sourceFacts):undefined;
  const catalog=useProductQualityReasons(),dialog=useRef<HTMLDivElement>(null),savingRef=useRef(false);
  const [saving,setSaving]=useState(false),[saveError,setSaveError]=useState('');
  useEffect(()=>{const previous=document.activeElement;dialog.current?.focus();return()=>{if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
  async function save(){if(savingRef.current||issues.length)return;savingRef.current=true;setSaving(true);setSaveError('');try{await onConfirm(sourceFacts?{...form,__sourceQuality:{version:1,confirmations}}:form);}catch(error){setSaveError(error instanceof Error?error.message:'保存失败');savingRef.current=false;setSaving(false);}}
  const issues = archiveQualityIssues(form, qualityOptions);
  const reasons = parseQualityReasons(form.zeroValueReason);
  const rows = archiveQualityFields(form, qualityOptions).filter((f) => ['zero', 'weight', 'optionalGroup'].includes(f.mode)||!!sourceFacts&&f.id==='weightG');

  function confirmRow(f: QualityField) {
    const reason = (drafts[f.id] ?? '').trim();
    if (!reason) return;
    const sourcePrice=/^source:(.+):purchasePrice$/.exec(f.id);
    const next: Record<string, unknown> = { ...form,...(!sourceFacts||!sourcePrice?{zeroValueReason:mergeQualityReasons(form.zeroValueReason,{[f.label]:reason})}:{}) };
    if (f.mode === 'zero' || f.mode === 'weight') next[f.id] = 0;
    if (f.mode === 'weight') next.weightManual = true;
    if(sourceFacts){const nextFacts:SourceQualityFacts={...sourceFacts,parent:{...sourceFacts.parent},sources:sourceFacts.sources.map(row=>({...row}))};if(sourcePrice){nextFacts.sources=nextFacts.sources.map(row=>row.key===sourcePrice[1]?{...row,purchasePrice:0}:row);}else if(f.mode==='zero'||f.mode==='weight'){nextFacts.parent[f.id]=0;if(f.mode==='weight')nextFacts.parent.weightManual=true;}setSourceFacts(nextFacts);setConfirmations(current=>({...current,[f.id]:{reason,context:archiveQualityContext(nextFacts)}}));}
    setForm(next);
  }
  return (
    <div className="product-quality-overlay" role="presentation" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();if(!savingRef.current)onCancel();}if(event.key==='Tab'){const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')??[]),first=controls[0],last=controls.at(-1);if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}}>
      <div ref={dialog} tabIndex={-1} className="product-quality-dialog" role="dialog" aria-modal="true" aria-label="核算资料确认">
        <header><div><h2>核算资料确认</h2><p>{String(form.name??'')}</p></div><button type="button" className="secondary-button" aria-label="返回修改" disabled={saving} onClick={onCancel}><X size={18}/></button></header>
        <div className="product-quality-body">
          <ProductZeroReasonManager catalog={catalog} disabled={saving}/>
          {rows.length === 0 && <p className="muted">没有需要确认的核算项目。</p>}
          {rows.map((f) => {
            const receipt=confirmations[f.id];
            const reason = sourceFacts?(validSourceQualityConfirmation(receipt,context!)?receipt.reason:undefined):reasons[f.label];
            const n = f.value === null || f.value === undefined || String(f.value).trim() === '' ? null : Number(f.value);
            const confirmed = Boolean(reason) && n === 0;
            const needs = !confirmed && (n === null || n === 0) && f.mode !== 'positive';
            // 原料、发货物料的采购价取自供货来源，空着不用确认
            const optionalBlank = !sourceFacts&&f.id === 'purchasePrice' && n === null && ['raw', 'shipping_material'].includes(String(form.archiveType));
            return (
              <div key={f.id} className="product-quality-row">
                <strong>{f.label}</strong>
                <span>{optionalBlank ? '取自供货来源' : valueText(f, confirmed ? reason : undefined,form)}</span>
                {needs && !optionalBlank && (
                  <>
                    <ProductZeroReasonInput label={`${f.label}零值原因`} value={drafts[f.id]??''} rows={catalog.rows} disabled={saving||catalog.busy} onChange={value=>setDrafts({...drafts,[f.id]:value})}/>
                    <button type="button" className="secondary-button" disabled={saving||catalog.busy||!(drafts[f.id] ?? '').trim()} onClick={() => confirmRow(f)}>{confirmLabel(f)}</button>
                  </>
                )}
              </div>
            );
          })}
          {issues.length > 0 && (
            <div className="product-quality-errors" role="status"><strong>尚未完成的项目</strong>
              <ul>{issues.map((i, idx) => <li key={`${i.id}-${idx}`}>{i.message}</li>)}</ul>
            </div>
          )}
          {saveError&&<p role="alert" className="product-quality-save-error">保存失败：{saveError}</p>}
        </div>
        <footer>
          <button type="button" className="secondary-button" disabled={saving} onClick={onCancel}>返回修改</button>
          <button type="button" className="primary-button" disabled={saving||catalog.busy||issues.length > 0} onClick={()=>void save()}>{saving?'保存中':'确认并保存'}</button>
        </footer>
      </div>
    </div>
  );
}
