/** 核算弹窗使用的草稿身份；不作为资源记录或权限凭证保存。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function sourceQualityRowKey(row:{rowId?:number;qualityKey?:string}):string {
  return Number.isSafeInteger(row.rowId) && Number(row.rowId)>0 ? `id:${row.rowId}` : row.qualityKey && UUID.test(row.qualityKey) ? row.qualityKey : crypto.randomUUID();
}
export function withSourceQualityKey<T extends object>(row:T & {rowId?:number;qualityKey?:string}):T & {qualityKey:string} {
  return {...row,qualityKey:sourceQualityRowKey(row)};
}
export function copySourceQualityRow<T extends object>(row:T & {rowId?:number;qualityKey?:string}):Omit<T,'rowId'|'qualityKey'> & {qualityKey:string} {
  const {rowId:_id,qualityKey:_key,...rest}=row;
  return {...rest,qualityKey:crypto.randomUUID()};
}
