import {describe,expect,it} from 'vitest';
import {RESOURCE_IMPORT_PROFILES,getResourceImportProfile} from './resource-import-profiles';
describe('原工作簿通用导入配置',()=>{
  it('保留7模块、原多表名称与可选明细，步骤按父记录在子引用之前排列',()=>{
    expect(RESOURCE_IMPORT_PROFILES.map(profile=>profile.id)).toEqual(['archive_categories','dictionaries','archive_units','platforms','product_archives','base_codes','bundle_codes']);
    expect(getResourceImportProfile('product_archives')!.sheets.map(sheet=>[sheet.name,!!sheet.optional])).toEqual([['商品档案',false],['原料明细',true],['包装明细',true],['OEM包装明细',true],['人工成本明细',true]]);
    expect(getResourceImportProfile('base_codes')!.sheets.map(sheet=>sheet.name)).toEqual(['商品基础编码','基础编码组成']);
    expect(getResourceImportProfile('bundle_codes')!.sheets.map(sheet=>sheet.name)).toEqual(['商品组合编码','组合BOM']);
    for(const profile of RESOURCE_IMPORT_PROFILES){
      expect(new Set(profile.steps.map(step=>step.id)).size).toBe(profile.steps.length);
      for(const step of profile.steps)expect(profile.sheets.some(sheet=>sheet.name===step.sheet)).toBe(true);
      for(const sheet of profile.sheets){expect(new Set(sheet.headers).size).toBe(sheet.headers.length);for(const example of sheet.examples)expect(Object.keys(example).every(key=>sheet.headers.includes(key))).toBe(true);}
    }
  });
  it('字典品种/编码分类保持独立事实，模板成本价和BOM控制列不丢失',()=>{
    const dictionaries=getResourceImportProfile('dictionaries')!;
    expect(dictionaries.steps.filter(step=>step.resource==='finance-code-dictionaries')).toHaveLength(3);
    expect(getResourceImportProfile('base_codes')!.sheets[0].headers).toEqual(expect.arrayContaining(['成本价','采购价','款式编码']));
    expect(getResourceImportProfile('bundle_codes')!.sheets[1].headers).toEqual(expect.arrayContaining(['损耗率','成本归类','计价处理','必选','进入聚水潭组合']));
    expect(getResourceImportProfile('bundle_codes')!.steps[0].createOnly).toBe(true);
  });
});
