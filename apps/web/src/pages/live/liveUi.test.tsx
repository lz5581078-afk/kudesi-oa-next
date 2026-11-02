import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal } from './liveUi';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('长表单失败反馈与操作保留在同一底栏，关闭后焦点回到入口', () => {
  function Form() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>新增排场</button>{open && <Modal title="排场" error="保存失败，请重试" onClose={() => setOpen(false)} foot={<button>保存</button>}><label>备注<textarea /></label>{Array.from({length:30},(_,i)=><p key={i}>场次资料 {i}</p>)}</Modal>}</>;
  }
  render(<Form />);
  const opener=screen.getByRole('button',{name:'新增排场'});opener.focus();fireEvent.click(opener);
  const dialog=screen.getByRole('dialog',{name:'排场'});
  expect(document.activeElement).toBe(dialog);
  const footer=within(dialog).getByRole('button',{name:'保存'}).closest('.modal-foot');
  expect(within(footer as HTMLElement).getByRole('alert').textContent).toContain('保存失败');
  expect(dialog.querySelector('.modal-body [role=alert]')).toBeNull();
  fireEvent.keyDown(dialog,{key:'Escape'});
  expect(screen.queryByRole('dialog')).toBeNull();expect(document.activeElement).toBe(opener);
});

it('嵌套弹窗只响应最上层Escape，Tab在当前弹窗首尾循环', () => {
  const outer=vi.fn(), inner=vi.fn();
  vi.spyOn(HTMLElement.prototype,'getClientRects').mockReturnValue([{width:10,height:10}] as unknown as DOMRectList);
  render(<><Modal title="结算详情" onClose={outer} foot={<button>提交结算</button>}>结算单</Modal><Modal title="场次详情" onClose={inner} foot={<button>确认</button>}><input aria-label="场次备注" /></Modal></>);
  const dialog=screen.getByRole('dialog',{name:'场次详情'}), close=within(dialog).getByRole('button',{name:'关闭'}), last=within(dialog).getByRole('button',{name:'确认'});
  last.focus();fireEvent.keyDown(last,{key:'Tab'});expect(document.activeElement).toBe(close);
  close.focus();fireEvent.keyDown(close,{key:'Tab',shiftKey:true});expect(document.activeElement).toBe(last);
  fireEvent.keyDown(dialog,{key:'Escape'});expect(inner).toHaveBeenCalledOnce();expect(outer).not.toHaveBeenCalled();
});
