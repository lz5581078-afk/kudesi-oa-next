import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ScriptArticleEditor } from './ScriptArticleEditor';
import type { ScriptVersion } from './scriptCues';
afterEach(cleanup);
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
function Fixture() {
  const [v, setV] = useState<ScriptVersion & {outline:{name:string;length:number}[]}>({id:1,folderId:1,name:'例',notes:'',body:'甲乙',revision:1,assets:[],cues:[{asset:3,start:1,end:2}],outline:[{name:'留人',length:0},{name:'互动',length:0},{name:'待分章',length:2}]});
  return <><ScriptArticleEditor v={v} change={u=>setV({...v,...u,outline:u.outline ?? v.outline})} onSelect={vi.fn()} onMark={vi.fn()}/><output data-testid="document">{JSON.stringify(v)}</output></>;
}
it('空章节各自独立输入，连续组成全文，后章内容和素材偏移保留', () => {
  render(<Fixture/>);
  fireEvent.click(screen.getByRole('button',{name:/02 互动/}));
  const input=screen.getByRole('textbox',{name:'互动正文（第2章）'});
  expect(document.activeElement).toBe(input);
  fireEvent.change(input,{target:{value:'互动内容'}});
  fireEvent.change(screen.getByRole('textbox',{name:'留人正文（第1章）'}),{target:{value:'开场'}});
  const v=JSON.parse(screen.getByTestId('document').textContent!);
  expect(v.body).toBe('开场互动内容甲乙'); expect(v.outline.map((s:{length:number})=>s.length)).toEqual([2,4,2]);
  expect(v.cues).toEqual([{asset:3,start:7,end:8}]);
  expect(screen.getByText('正在编辑：留人').textContent).toContain('留人');
});
it('光标拆章直接显示新标题和独立正文输入区', () => {
  render(<Fixture/>);
  const input=screen.getByRole('textbox',{name:'待分章正文（第3章）'}) as HTMLTextAreaElement;
  input.setSelectionRange(1,1); fireEvent.select(input);
  fireEvent.click(screen.getAllByRole('button',{name:'拆分 / 调整本章内容'})[2]);
  fireEvent.change(screen.getByLabelText('新章节名称'),{target:{value:'塑品'}});
  fireEvent.click(screen.getByRole('button',{name:'从光标处拆出新章节'}));
  expect((screen.getByRole('textbox',{name:'塑品正文（第4章）'}) as HTMLTextAreaElement).value).toBe('乙');
  expect(JSON.parse(screen.getByTestId('document').textContent!).body).toBe('甲乙');
});
