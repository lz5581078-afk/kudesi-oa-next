import {pinyin} from 'pinyin-pro';
/** 财务现有首字母口径：英文数字保持，中文逐字取首字母。 */
export function financeCodeInitials(value:string){const result:string[]=[];for(const char of value.normalize('NFKC')){if(/[A-Za-z0-9]/.test(char))result.push(char.toUpperCase());else if(/[一-龥]/.test(char))result.push(pinyin(char,{pattern:'first',toneType:'none'}).toUpperCase());}return result.join('');}

/** 独立定义采用原整段拼音，保留词语读音；既有档案 initials 口径不变。 */
export const definitionCodeInitials=(value:string)=>pinyin(value.trim(),{pattern:'first',toneType:'none',type:'array',nonZh:'consecutive'}).join('').toUpperCase().replace(/[^A-Z0-9]/g,'');
