import type {FormEvent} from 'react';
import {createPortal} from 'react-dom';
import './feeSnapshotCreate.css';
/** 费用分类专属单字段外观；保存由FinanceCategoryManager原内核执行。 */
export function FeeCategoryEditor({editing,name,busy,loading,error,onName,onClose,onSubmit}:{editing:boolean;name:string;busy:boolean;loading:boolean;error:string;onName:(name:string)=>void;onClose:()=>void;onSubmit:(event:FormEvent)=>void}){
 return createPortal(<div className="fee-snapshot-create-backdrop"><form className="fee-snapshot-create" role="dialog" aria-label={editing?'编辑分类':'新增分类'} onSubmit={onSubmit}>
 <header><div><h2>{editing?'编辑分类':'新增分类'}</h2><p>分类支持多级，列表会按当前分类及下级分类筛选。</p></div><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
 <div className="fee-snapshot-create-fields"><label><span>分类名称</span><input autoFocus value={name} disabled={busy} onChange={event=>onName(event.target.value)}/></label></div>
 {error&&<p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" disabled={busy||loading}>{busy?'保存中…':'保存分类'}</button></footer>
 </form></div>,document.body);
}
