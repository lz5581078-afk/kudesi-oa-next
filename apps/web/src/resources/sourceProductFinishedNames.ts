export const SOURCE_FINISHED_NAMES_COMMAND='__sourceFinishedNames';
export interface SourceFinishedNameRow {name:string;rowToken:string;aliasRecordId?:number;version?:string;code?:string;fullName?:string}
export interface SourceFinishedNamesState {rows:SourceFinishedNameRow[];expected:Array<{aliasRecordId:number;version:string}>}
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
/** 只继承服务端唯一同名实际alias事实；新增和复制始终创建独立行身份。 */
export function sourceFinishedNamesState(data:Record<string,unknown>,inherit:boolean):SourceFinishedNamesState{
 const names=String(data.rawFinishedNames||'').split(/\r?\n/).filter(name=>name.trim()).map(name=>name.trim()),details=Array.isArray(data.__finishedNameDetails)?data.__finishedNameDetails.filter((value):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)):[];
 const rows=names.map(name=>{const facts=inherit?details.filter(row=>row.name===name):[],fact=facts.length===1?facts[0]:undefined,known=fact&&Number.isSafeInteger(fact.aliasRecordId)&&Number(fact.aliasRecordId)>0&&typeof fact.version==='string'&&fact.version;
 return{name,rowToken:inherit&&uuid(fact?.rowToken)?String(fact!.rowToken):crypto.randomUUID(),...(known?{aliasRecordId:Number(fact.aliasRecordId),version:String(fact.version)}:{}),...(inherit&&typeof fact?.code==='string'?{code:fact.code}:{}),...(inherit&&typeof fact?.fullName==='string'?{fullName:fact.fullName}:{})};});
 return{rows,expected:rows.flatMap(row=>row.aliasRecordId&&row.version?[{aliasRecordId:row.aliasRecordId,version:row.version}]:[])};
}
export function sourceFinishedNamesCommand(state:SourceFinishedNamesState){return{version:1,expected:state.expected.map(row=>({...row})),rows:state.rows.map(({name,rowToken,aliasRecordId,version})=>({name:name.trim(),rowToken,...(aliasRecordId?{aliasRecordId,version}:{})}))};}
