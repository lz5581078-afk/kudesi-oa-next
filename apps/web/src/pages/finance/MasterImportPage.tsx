import { useState } from 'react';
import { getResourceDef, permissionOwner } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { ImportDialog } from '../../resources/ImportDialog';
import { MasterResetPage } from './DataToolPages';

/** 导入要有先后：后面的资料会引用前面的（商品引用分类，基础编码引用商品，组合构成引用基础编码）。 */
const STEPS: Array<{ title: string; hint: string; types: string[] }> = [
  { title: '1. 商品分类', hint: '先导入分类树：上级分类写在“上级分类”列，分类码用大写字母或数字。', types: ['finance-categories'] },
  { title: '2. 品牌、销售平台、销售场景、仓库', hint: '这些是下拉选项的来源，量不大。平台和场景新公司已带默认值。', types: ['finance-brands', 'finance-platforms', 'finance-scenarios', 'finance-warehouses'] },
  { title: '3. 供应商、客户', hint: '商品档案的“供应商”、单据的往来方来自这里。', types: ['finance-suppliers', 'finance-customers'] },
  { title: '4. 商品档案', hint: '必须挂最末级分类；成本、重量会自动汇总，编码不填会自动生成。', types: ['finance-products'] },
  { title: '5. 自制品构成', hint: '自制品由哪些商品做成；成本和重量按这里自动汇总。', types: ['finance-product-boms'] },
  { title: '6. 商品基础编码', hint: '给商品建聚水潭用的基础编码；导入后需要在页面上逐个验证。', types: ['finance-base-codes'] },
  { title: '7. 聚水潭商品镜像、组合命名规则', hint: '聚水潭镜像是从聚水潭导出的现有普通商品和组合装编码，用来在建组合时检查有没有重名；命名规则按分类定组合编码怎么拼，只有管理员能导入。', types: ['finance-jst-skus', 'finance-bundle-naming-rules'] },
  { title: '8. 商品组合编码和构成', hint: '先导入组合，再导入组合构成（只能用已验证的基础编码）；组合编码和名称会自动生成。', types: ['finance-bundles', 'finance-bundle-lines'] },
];

/** 商品数据导入：按顺序把老数据一类一类导进来。每一类都先预览、逐行校验，有错整体不导入。 */
export function MasterImportPage() {
  const { can } = useAuth();
  const types = STEPS.flatMap(step => step.types).filter(type => can(`resource.${permissionOwner(type)}.import`));
  const [type, setType] = useState(types[0] ?? '');
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState('');
  const def = type ? getResourceDef(type) : undefined;
  return <div className="master-data-import-page">
    <div className="page-head"><h1>商品基础数据导入</h1></div>
    <p className="muted">Excel 先预检、再写入；仅处理当前公司的本地商品基础资料。</p>
    <section className="card">
      <h2>分模块 Excel 导入</h2>
      <p className="muted">建议按分类、字典/单位/平台、档案、基础编码、组合编码的顺序执行。</p>
      <label>导入类型<select aria-label="导入类型" value={type} onChange={e => { setType(e.target.value); setNotice(''); }}>
        {STEPS.map(step => <optgroup key={step.title} label={step.title}>{step.types.filter(t => types.includes(t)).map(t => <option key={t} value={t}>{getResourceDef(t)!.label}</option>)}</optgroup>)}
      </select></label>
      {notice && <div role="status" className="notice ok">{notice}</div>}
      {def ? <ImportDialog key={`${type}-${tick}`} embedded def={def} onClose={() => setTick(n => n + 1)} onDone={message => { setNotice(message || '导入完成'); setTick(n => n + 1); }} /> : <p className="muted">当前账号没有资料导入权限。</p>}
    </section>
    {can('finance.master-reset.view') && <section className="card"><MasterResetPage embedded /></section>}
  </div>;
}
