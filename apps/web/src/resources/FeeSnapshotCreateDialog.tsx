import {useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ApiError} from '../api/client';
import './feeSnapshotCreate.css';
/** 保存历史包的原版内窗；调用方继续使用现有费用快照接口。 */
export function FeeSnapshotCreateDialog({onClose,onCreate}:{onClose:()=>void;onCreate:(name:string,remark:string)=>Promise<void>}){
 const [name,setName]=useState(()=>`费用档案存档 ${new Date().toISOString().slice(0,10)}`),[remark,setRemark]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);const pending=useRef(false);
 return createPortal(<div className="fee-snapshot-create-backdrop"><form className="fee-snapshot-create" role="dialog" aria-label="保存费用档案历史包" onSubmit={async event=>{event.preventDefault();if(pending.current)return;if(!name.trim())return setError('请填写存档名称');pending.current=true;setBusy(true);setError('');try{await onCreate(name.trim(),remark);onClose();}catch(e){setError(e instanceof ApiError?e.message:'保存失败，请重试');pending.current=false;setBusy(false);}}}>
 <header><div><h2>保存费用档案历史包</h2><p>把当前费用目录和费用类型保存成一个可恢复的存档。</p></div><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
 <div className="fee-snapshot-create-fields"><label><span>存档名称</span><input autoFocus value={name} disabled={busy} onChange={e=>setName(e.target.value)}/></label><label><span>备注</span><textarea value={remark} disabled={busy} onChange={e=>setRemark(e.target.value)} placeholder="可写明这次存档对应的调整原因。"/></label></div>
 {error&&<p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" disabled={busy}>{busy?'保存中…':'保存历史包'}</button></footer>
 </form></div>,document.body);
}
