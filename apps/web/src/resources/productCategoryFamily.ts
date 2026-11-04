/** 原采购分类树有可信导入标记时，原装采购与供应商OEM引用同一树。 */
export function matchesProductCategoryFamily(family:string,category:{archiveType?:unknown;importArchiveType?:unknown}) {
 return category.archiveType===family || ['original_purchase','supplier_oem'].includes(family) && category.archiveType==='original_purchase' && category.importArchiveType==='purchased';
}
