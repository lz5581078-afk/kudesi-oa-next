import type {DesktopSaleSnapshot} from '@kudesi/shared';
export type Shot={id:number;afterSaleId:string;image:string};
export type DesktopQuery={kind:'current'|'history';field:'afterSaleId'|'internalOrderId';value:string;sourceCompany:string;page?:number;from?:string;until?:string};
export type DesktopQueryResult={records:DesktopSaleSnapshot[];page:number;pageSize:number;hasNext:boolean|null;total:number|null;sourceCompany:string;kind:'current'|'history'};
export interface DesktopBridge {
 version:string;
 surface?:'main'|'after-sales'|'collector';
 openAfterSales?():Promise<boolean>;
 openFeishuLogin?(authorizationUrl:string):Promise<boolean>;
 preferences():Promise<{shortcut:string;registered:boolean;collection?:{clientId:string;enabled:boolean;sourceCompany?:string}}>;
 collection?(value:{enabled:boolean;sourceCompany:string}):Promise<boolean>;
 prepare?():Promise<{sourceCompany:string}>;
 prepareLatest?():Promise<{sourceCompany:string}>;
 query?(query:DesktopQuery):Promise<DesktopQueryResult>;
 latest?(query:DesktopQuery):Promise<DesktopQueryResult>;
 zoom(value:number):Promise<boolean>;
 mount(bounds:{x:number;y:number;width:number;height:number}):Promise<boolean>;
 hide():Promise<boolean>;refresh():Promise<boolean>;read():Promise<DesktopSaleSnapshot[]>;
 openOrder(id:string):Promise<boolean>;screenshot(context:{id:number;afterSaleId:string}|null):Promise<boolean>;
 context(context:{id:number;afterSaleId:string}|null):Promise<boolean>;
 shortcut(value:string):Promise<boolean>;clearLogin():Promise<boolean>;
 onScreenshot(callback:(s:Shot)=>void):()=>void;
}
declare global {interface Window {oaDesktop?:DesktopBridge}}
