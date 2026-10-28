import { useCallback, useContext, useEffect, useRef } from 'react';
import { UNSAFE_DataRouterContext, useBlocker, type Blocker, type BlockerFunction, type Location } from 'react-router-dom';

/** 表格编辑里有没保存的修改时，任何会丢掉修改的离开动作都先问一声。 */

/** 页面向外暴露的表格控制：保存全部（返回是否全部成功）、当前没保存的数量 */
export interface GridControl {
  save: () => Promise<boolean>;
  counts: () => { changes: number; errors: number };
}

/** 一次待确认的离开：go = 确认后真正去做的事；cancel = 选“继续编辑”时要还原的事（路由拦截要 reset） */
export interface LeaveRequest {
  go: () => void;
  cancel?: () => void;
}

const stripOpen = (search: string) => {
  const q = new URLSearchParams(search);
  q.delete('open'); // ?open=id 只是打开一条记录，不算离开
  return q.toString();
};
const path = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const differs = (a: Location, b: Location) => path(a.pathname) !== path(b.pathname) || stripOpen(a.search) !== stripOpen(b.search);

function Blocking({ when, onBlocked }: { when: boolean; onBlocked: (r: LeaveRequest) => void }) {
  // 判断函数读 ref，而不是每次渲染换一个新闭包：路由器是在渲染之外调用它的，换新闭包要等 effect 重新登记，中间那一下会用到旧的“没有修改”
  const whenRef = useRef(when);
  whenRef.current = when;
  const shouldBlock = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => whenRef.current && differs(currentLocation, nextLocation), []);
  const blocker: Blocker = useBlocker(shouldBlock);
  const last = useRef<Blocker>(blocker);
  last.current = blocker;
  useEffect(() => {
    if (blocker.state === 'blocked') onBlocked({ go: () => last.current.state === 'blocked' && last.current.proceed(), cancel: () => last.current.state === 'blocked' && last.current.reset() });
  }, [blocker.state]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/**
 * 拦截站内导航（侧栏、顶栏搜索跳转、浏览器后退/前进、详情里的链接、切换资料类型、页面内标签页等所有路由切换）。
 * 用 react-router 数据路由的 useBlocker，只在应用确实运行在数据路由下时才挂上（单元测试里的 MemoryRouter 没有）。
 * 刷新、关闭浏览器标签页由浏览器自己的 beforeunload 提示负责（ResourceGrid 里）。
 */
export function RouterLeaveBlocker(props: { when: boolean; onBlocked: (r: LeaveRequest) => void }) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  if (!dataRouter) return null;
  return <Blocking {...props} />;
}

export function LeaveDialog({ changes, errors, busy, onSave, onDiscard, onStay }: {
  changes: number;
  errors: number;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}) {
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => { stay.current?.focus(); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); onStay(); } };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [busy, onStay]);
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal small card" role="alertdialog" aria-modal="true" aria-labelledby="leave-title" aria-describedby="leave-desc">
        <div className="modal-head"><strong id="leave-title">表格里有没保存的修改</strong></div>
        <div className="modal-body" id="leave-desc">
          <p>{changes > 0 ? `还有 ${changes} 处修改没有保存` : '表格里还有没处理的内容'}{errors > 0 ? `（其中 ${errors} 行上次保存失败）` : ''}。现在离开会丢掉这些修改。</p>
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button danger" disabled={busy} onClick={onDiscard}>放弃修改并退出</button>
          <button type="button" className="primary-button" disabled={busy} onClick={onSave}>{busy ? '保存中…' : '保存并退出'}</button>
          <button type="button" ref={stay} className="secondary-button" disabled={busy} onClick={onStay}>继续编辑</button>
        </div>
      </div>
    </div>
  );
}
