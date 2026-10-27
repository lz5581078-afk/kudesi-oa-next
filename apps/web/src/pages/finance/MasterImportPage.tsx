import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getResourceDef, permissionOwner } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { resourceApi } from '../../resources/api';
import { ImportDialog } from '../../resources/ImportDialog';

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
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [importing, setImporting] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    for (const t of STEPS.flatMap((s) => s.types)) {
      resourceApi.list(t, { pageSize: 1, showHidden: true }).then((r) => live && setCounts((c) => ({ ...c, [t]: r.total }))).catch(() => live && setCounts((c) => ({ ...c, [t]: null })));
    }
    return () => { live = false; };
  }, [tick]);

  const def = importing ? getResourceDef(importing) : undefined;
  const loaded = STEPS.every((s) => s.types.every((t) => counts[t] !== undefined));
  const done = (s: (typeof STEPS)[number]) => s.types.every((t) => (counts[t] ?? 0) > 0);
  const nextStep = loaded ? STEPS.find((s) => !done(s))?.title : undefined;
  return (
    <div>
      <div className="page-head"><h1>商品数据导入</h1></div>
      <p className="muted">按下面的顺序一类一类导入。每次先预览，逐行校验，有错整体不导入；同一个编码再次导入会更新而不是重复。</p>
      <ol className="stack">
        {STEPS.map((s) => (
          <li key={s.title} className={s.title === nextStep ? 'card import-step-next' : 'card'} aria-current={s.title === nextStep ? 'step' : undefined}>
            <strong>{s.title}</strong> {done(s) ? <span className="pill ok">已导入</span> : s.title === nextStep ? <span className="pill warn">下一步</span> : null}
            <p className="muted">{s.hint}</p>
            <div className="table-scroll"><table className="data-table">
              <thead><tr><th>资料</th><th>现有</th><th /></tr></thead>
              <tbody>
                {s.types.map((t) => {
                  const d = getResourceDef(t)!;
                  const parent = d.parent ? getResourceDef(d.parent.type) : null;
                  const viewPath = d.nav ? `/finance/${t}` : parent?.nav ? `/finance/${parent.key}` : null;
                  return (
                    <tr key={t}>
                      <td>{d.label}</td>
                      <td className="num">{counts[t] === undefined ? '…' : counts[t] === null ? '无权限' : counts[t]}</td>
                      <td className="row-actions">
                        {can(`resource.${permissionOwner(t)}.import`) && <button type="button" className="secondary-button small" onClick={() => setImporting(t)}>导入 {d.label}</button>}
                        {viewPath && <Link to={viewPath}>打开页面</Link>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </li>
        ))}
      </ol>
      {def && <ImportDialog def={def} onClose={() => setImporting(null)} onDone={() => { setImporting(null); setTick((n) => n + 1); }} />}
    </div>
  );
}
