import {IsBoolean,IsString,MaxLength} from 'class-validator';
/** Optional command proof. Its meaning and enforcement belong to the enabled adapter. */
export class FlowConfirmationDto {
 @IsString() @MaxLength(64) token!:string;
 @IsBoolean() confirmed!:boolean;
 @IsString() @MaxLength(500) reason!:string;
}
export interface FlowConfirmation {token:string;confirmed:boolean;reason:string}
