import type { DocRow } from './financeApi';
const statusLabels={draft:'草稿',issued:'已制单',pending:'待确认',completed:'已完成',cancelled:'已取消'};
export const documentSourceKind=(row:Pick<DocRow,'docType'|'source'|'sourceKind'>)=>row.docType==='expense'&&!(row.sourceKind?row.sourceKind==='workflow':row.source==='流程自动记账')?'expense':'document';
export const documentSummary=(row:DocRow)=>row.summary||(documentSourceKind(row)==='expense'?row.firstItemName:row.memo)||'-';
/** 旧费用单和普通单据的状态名称不同，过账状态另列，保留红冲这一真实账务事实。 */
export const documentDisplayState=(row:Pick<DocRow,'docType'|'status'|'source'|'sourceKind'>):keyof typeof statusLabels=>row.status==='draft'?'draft':row.status==='reversed'?'cancelled':documentSourceKind(row)==='expense'?row.status==='posted'?'completed':'pending':'issued';
