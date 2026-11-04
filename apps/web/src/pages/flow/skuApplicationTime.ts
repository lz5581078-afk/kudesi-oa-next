import {formatOaDateTime} from '../../lib/oaDateTime';
/** The original application list omits seconds. */
export const skuApplicationTime=(value:string|null)=>formatOaDateTime(value,{seconds:false,empty:''});
