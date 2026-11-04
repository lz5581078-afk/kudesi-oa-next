import {api} from '../api/client';
import {FeeSnapshotCreateDialog} from './FeeSnapshotCreateDialog';
import {ReferenceFeeSnapshots} from './ReferenceFeeSnapshots';
/** 同一历史包功能的原列表区与保存入口，统一沿现有快照服务。 */
export function FeeSnapshotsDialog({canWrite,canDelete,onClose,onRestored,embedded=false}:{createOnly?:boolean;embedded?:boolean;canWrite:boolean;canDelete:boolean;onClose:()=>void;onRestored:()=>void}){
 if(embedded||!canWrite)return <ReferenceFeeSnapshots canWrite={canWrite} canDelete={canDelete} onRestored={onRestored}/>;
 return <FeeSnapshotCreateDialog onClose={onClose} onCreate={async(name,remark)=>{await api('/finance/fee-archive/snapshots',{method:'POST',body:{name,remark:remark||undefined}});}}/>;
}
