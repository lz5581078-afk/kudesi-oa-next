import {FEE_BOOKING_NODES} from '@kudesi/shared';

/** 原档案维护的顺序与制单挂账选择不同；仓库旧值保留，普通新增不追加原来没有的按钮。 */
export const FEE_ARCHIVE_NODE_OPTIONS=[...FEE_BOOKING_NODES.map(option=>option.node).filter(node=>!['公司','不固定','仓库'].includes(node)),'公司','不固定'];
export const feeBookingNodes=(value:unknown)=>[...new Set((Array.isArray(value)?value:String(value??'').split(/[、,，/]+/)).map(value=>String(value).trim()).filter(value=>value&&value!=='不固定'))];
export const feeBookingOptions=(nodes:string[])=>[...FEE_ARCHIVE_NODE_OPTIONS,...nodes.filter(node=>!FEE_ARCHIVE_NODE_OPTIONS.includes(node))];
