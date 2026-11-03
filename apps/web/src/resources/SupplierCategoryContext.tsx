import { useEffect, useRef, useState } from 'react';
import { FolderTree } from 'lucide-react';
import { loadRefOptions } from './ResourceReferenceControls';

/** 种子供应商可同时供多类种子；其他供应商沿用列表的固定归属目录。 */
export function SupplierCategoryContext({ value, onChange, labelNow }: { value: number[]; onChange: (ids: number[]) => void; labelNow?: string }) {
  const [options, setOptions] = useState<Awaited<ReturnType<typeof loadRefOptions>> | null>(null), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const original = useRef(value);
  useEffect(() => { let alive = true; setError(''); loadRefOptions('finance-supplier-categories').then(rows => { if (alive) setOptions(rows); }).catch(() => { if (alive) setError('供应商分类读取失败，当前归属仍保留。'); }); return () => { alive = false; }; }, [revision]);
  const label = (id: number) => options?.find(option => option.value === id)?.label || (original.current.indexOf(id) >= 0 ? labelNow?.split('、')[original.current.indexOf(id)] : '') || `#${id}`;
  const seed = (original.current.length ? original.current : value).some(id => label(id).startsWith('种子供应商 / '));
  const choices = options?.filter(option => option.leaf !== false && option.label.startsWith('种子供应商 / ')) ?? [];
  return <><div className="reference-party-context"><div><FolderTree size={20}/><small>归入分类</small><strong>{value.map(label).join('；') || '未选择分类'}</strong></div><p>{seed ? '同一供应商可以关联多个种子末级分类；编号按第一个主分类生成' : '供应商建立后会显示在该目录的直属列表中'}</p></div>
    {error && <p role="alert">{error}<button type="button" className="link-button" onClick={() => setRevision(v => v+1)}>重新加载</button></p>}
    {seed && <div className="reference-supplier-categories"><h3><span className="reference-party-step"><FolderTree size={13}/></span>供应产品分类 <small>可多选</small></h3><div className="supplier-category-choice-grid">{choices.map(option => <label key={option.value} className={value.includes(option.value) ? 'is-selected' : ''}><input type="checkbox" checked={value.includes(option.value)} onChange={event => onChange(event.target.checked ? [...value,option.value] : value.filter(id => id !== option.value))}/><span>{option.label}</span></label>)}</div></div>}
  </>;
}
