import {pinyin} from 'pinyin-pro';
import {definitionCodeInitials} from './code-initials';
export type FinanceDictionaryKind='brand'|'spec_unit'|'product_category';
/** 原规格字典常用码；不借现有种子的旧码重写新录入的含义。 */
const COMMON_UNITS:Readonly<Record<string,string>>={'毫克':'MG','克':'G','千克':'KG','公斤':'KG','斤':'J','吨':'T','毫升':'ML','升':'LTR','粒':'L','棵':'K','包':'B','袋':'D','盒':'BOX','箱':'CTN','瓶':'BTL','罐':'CAN','件':'PCS','个':'EA'};
const identifier=(value:string)=>value.toUpperCase().replace(/[^A-Z0-9]/g,'');
export const sourceUnitCode=(name:string)=>COMMON_UNITS[name.trim()]||definitionCodeInitials(name);
export function sourceBrandCode(name:string,existing:readonly string[]){const base=definitionCodeInitials(name)||'BRAND',used=new Set(existing.map(value=>value.toUpperCase()));let code=base;for(let suffix=2;used.has(code);suffix++)code=base+suffix;return code;}
/** 分类先扩展第一个可扩展音节，再用数字；真实手填码由保存规则单独拒冲突。 */
export function sourceCategoryCode(name:string,existing:readonly string[]){const base=definitionCodeInitials(name)||'X',syllables=pinyin(name.trim(),{pattern:'pinyin',toneType:'none',type:'array',nonZh:'consecutive'}).map(identifier).filter(Boolean),index=syllables.findIndex(value=>value.length>1),candidates=[base];if(index>=0){const expanded=syllables.map((value,i)=>value.slice(0,i===index?2:1)).join('');if(expanded&&expanded!==base)candidates.push(expanded);}const used=new Set(existing.map(identifier).filter(Boolean));for(const candidate of candidates)if(!used.has(candidate))return{code:candidate,baseCode:base,conflict:used.has(base)};const stem=candidates[candidates.length-1];let suffix=2;while(used.has(stem+suffix))suffix++;return{code:stem+suffix,baseCode:base,conflict:true};}
export function dictionaryCodeSuggestion(kind:FinanceDictionaryKind,name:string,existing:readonly string[]){if(kind==='brand'){const code=sourceBrandCode(name,existing);return{code,baseCode:definitionCodeInitials(name)||'BRAND',conflict:code!==(definitionCodeInitials(name)||'BRAND')};}if(kind==='spec_unit'){const code=sourceUnitCode(name);return{code,baseCode:code,conflict:existing.some(value=>value.toUpperCase()===code)};}return sourceCategoryCode(name,existing);}
