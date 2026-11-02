import { ChevronDown, ChevronRight, FolderTree } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../../../auth/AuthContext';
import { FinanceCategoryManager } from '../../../resources/FinanceCategoryManager';
import { resourceApi, type CategoryTreeResult } from '../../../resources/api';

/** 编码目录保持24号的独立栏；数量由服务端按状态和子树去重，不在前端再次累加。 */
export function CodeCategoryDirectory({ type, status, value, onPick, reloadKey, onChanged }: {
  type: 'finance-base-codes' | 'finance-bundles'; status: string; value: string;
  onPick: (id: string) => void; reloadKey?: unknown; onChanged: () => void;
}) {
  const { can } = useAuth();
  const bundle = type === 'finance-bundles';
  const [tree, setTree] = useState<CategoryTreeResult | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [manager, setManager] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    resourceApi.categoryTree(type, { field: bundle ? 'bundleCategoryId' : 'categoryId', status: status || undefined, showHidden: ['archived','inactive','disabled','deleted'].includes(status), ...(bundle ? {tab:'bundle'} : {}) }).then(result => {
      if (!alive) return;
      setTree(result); setError('');
      setExpanded(old => new Set([...old, ...result.nodes.filter(n => !n.parentId).map(n => n.id)]));
    }).catch(() => alive && setError('分类目录加载失败，请重试。'));
    return () => { alive = false; };
  }, [type, status, bundle, revision, reloadKey]);
  const nodes = tree?.nodes ?? [];
  const render = (parent: number, depth: number, seen: Set<number>): JSX.Element[] => nodes.filter(n => n.parentId === parent && !seen.has(n.id)).map(n => {
    const children = nodes.some(c => c.parentId === n.id), open = expanded.has(n.id);
    return <div key={n.id} className={depth === 0 ? 'code-category-root' : 'code-category-child'}>
      <div className={`code-category-row${value === String(n.id) ? ' selected' : ''}`} style={{paddingLeft: 8 + depth * 18}}>
        <button type="button" className="code-category-expand" aria-label={`${open ? '收起' : '展开'}${n.title}`} aria-expanded={children ? open : undefined} disabled={!children} onClick={() => setExpanded(old => {const next=new Set(old); if(next.has(n.id))next.delete(n.id);else next.add(n.id);return next;})}>{children ? open ? <ChevronDown size={15}/> : <ChevronRight size={15}/> : <span className="code-category-dot"/>}</button>
        <button type="button" className="code-category-name" aria-current={value === String(n.id) ? 'true' : undefined} onClick={() => {onPick(value === String(n.id) ? '' : String(n.id));if(children)setExpanded(old=>new Set([...old,n.id]));}}>{n.title.replace(/^组合-/, '')}</button><span>{n.count}</span>
      </div>{open && render(n.id,depth+1,new Set([...seen,n.id]))}
    </div>;
  });
  return <><aside className="code-category-directory">
    <header><div><small>{bundle ? '商品组合编码' : '商品编码'}分类</small><h2>分类目录</h2></div>{can('resource.finance-categories.view') && <button type="button" className="secondary-button" onClick={()=>setManager(true)}><FolderTree size={15}/>管理分类</button>}</header>
    <button type="button" className={`code-category-all${value ? '' : ' active'}`} onClick={()=>onPick('')}><FolderTree size={16}/><span>全部商品</span><b>{tree?.total ?? 0}</b></button>
    <nav aria-label={`${bundle ? '商品组合编码' : '商品编码'}分类目录`}>{error ? <p role="alert">{error}<button type="button" className="link-button" onClick={()=>setRevision(n=>n+1)}>重试</button></p> : !tree ? <p role="status">正在加载分类…</p> : nodes.length ? render(0,0,new Set()) : <p>暂无分类，请先管理分类</p>}</nav>
  </aside>{manager && <div className="code-category-manager"><FinanceCategoryManager target="finance-categories" archiveType={bundle ? 'bundle' : undefined} maxDepth={4} selectedId={value ? Number(value) : undefined} counts={Object.fromEntries(nodes.map(n=>[n.id,n.count]))} onPick={id=>onPick(String(id))} onChanged={()=>{setRevision(n=>n+1);onChanged();}} onClose={()=>setManager(false)}/></div>}</>;
}
