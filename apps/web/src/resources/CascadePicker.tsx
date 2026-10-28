import { useEffect, useMemo, useState } from 'react';
import { childrenMap, loadTreeNodes, pathOf, type TreeNode } from './treeNodes';

const LEVEL = ['一级', '二级', '三级', '四级', '五级', '六级', '七级', '八级'];
const TYPE_LABEL: Record<string, string> = { building: '楼', floor: '楼层', room: '房间', cabinet: '柜子', asset_slot: '资产内部', shelf: '层', drawer: '抽屉', box: '格/盒' };

/**
 * 树形资料（资产分类、房间与档案位置）的分栏选择器：一级一级往下点，选中哪一级就是哪一级；
 * 也可以直接搜名字。选项很多时比平铺下拉好找，路径一直显示在上面。
 */
export function CascadePicker({ target, label, value, onChange, labelNow }: { target: string; label: string; value: number | null; onChange: (v: number | null) => void; labelNow?: string }) {
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [kw, setKw] = useState('');
  useEffect(() => {
    let alive = true;
    loadTreeNodes(target).then((n) => alive && setNodes(n)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [target]);
  const byId = useMemo(() => new Map((nodes ?? []).map((n) => [n.id, n])), [nodes]);
  const kids = useMemo(() => childrenMap((nodes ?? []).filter((n) => n.status !== 'inactive' || n.id === value)), [nodes, value]);
  const path = value ? pathOf(value, byId) : [];
  const word = kw.trim().toLowerCase();
  const found = useMemo(() => {
    if (!word) return [];
    return (nodes ?? []).filter((n) => n.status !== 'inactive' && (n.title.toLowerCase().includes(word) || n.code.toLowerCase().includes(word))).slice(0, 12);
  }, [nodes, word]);

  if (failed) return <input disabled value={labelNow ?? ''} placeholder="没有权限查看可选项" />;
  if (!nodes) return <span className="muted">加载中…</span>;
  if (nodes.length === 0) return <span className="muted">还没有{label}可选，先去维护</span>;

  // 每一级一栏：第一栏是顶层，之后是已选路径上每个节点的下级
  const columns: Array<{ parent: number; rows: TreeNode[] }> = [{ parent: 0, rows: kids.get(0) ?? [] }];
  for (const n of path) { const rows = kids.get(n.id) ?? []; if (rows.length) columns.push({ parent: n.id, rows }); }
  const shownPath = path.length ? path.map((n) => n.title).join(' / ') : labelNow && value ? labelNow : '';

  return (
    <div className="cascade" role="group" aria-label={`${label}选择`}>
      <div className="cascade-current">
        <span className="muted">当前{label}</span>
        <strong>{shownPath || '未选择'}</strong>
        {value ? <button type="button" className="link-button" onClick={() => onChange(null)}>清空</button> : null}
      </div>
      <input type="search" className="cascade-search" aria-label={`搜索${label}`} placeholder={`搜名称或编号，直接选${label}`} value={kw} onChange={(e) => setKw(e.target.value)} />
      {word ? (
        <div className="cascade-found">
          {found.map((n) => (
            <button key={n.id} type="button" className={n.id === value ? 'active' : ''} onClick={() => { onChange(n.id); setKw(''); }}>
              <span>{pathOf(n.id, byId).map((x) => x.title).join(' / ')}</span>
              <small>{TYPE_LABEL[n.locationType] ?? ''}</small>
            </button>
          ))}
          {found.length === 0 && <span className="muted">没有找到「{kw.trim()}」</span>}
        </div>
      ) : (
        <div className="cascade-cols">
          {columns.map((c, i) => (
            <div key={c.parent} className="cascade-col">
              <strong>{LEVEL[i] ?? `${i + 1}级`}{label}</strong>
              <div>
                {c.rows.map((n) => {
                  const sub = kids.get(n.id)?.length ?? 0;
                  const on = path.some((p) => p.id === n.id);
                  return (
                    <button key={n.id} type="button" className={n.id === value ? 'active' : on ? 'trail' : ''} aria-pressed={n.id === value} onClick={() => onChange(n.id)}>
                      <span>{n.title}</span>
                      <small>{sub ? `${sub} 个下级` : TYPE_LABEL[n.locationType] ?? ''}</small>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
