import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ScriptPreview } from './ScriptPreview';

it('句中及跨段标注不拆乱正文，选区复制保留原换行而不含箭头', () => {
  const body = '先看籽粒，再看采收。\n\n最后讲解。';
  const {container,getByRole}=render(<ScriptPreview v={{id:1,folderId:1,revision:1,name:'实拍',notes:'',body,
    assets:[{id:1,category:'image',name:'籽粒'}],cues:[{asset:1,start:2,end:body.length-2}]}}/>);
  const paragraphs=container.querySelectorAll('.sc-prose');
  expect(Array.from(paragraphs,p=>p.textContent)).toEqual(['先看籽粒，再看采收。\n','\n','最后讲解。']);
  expect(getByRole('button',{name:'展示 籽粒 →'})).toBeTruthy();
  expect(getByRole('button',{name:'← 撤下 籽粒'})).toBeTruthy();
  const range=document.createRange();
  range.setStartBefore(paragraphs[0]); range.setEndAfter(paragraphs[2]);
  const selection=window.getSelection()!;
  selection.removeAllRanges(); selection.addRange(range);
  const setData=vi.fn();fireEvent.copy(paragraphs[0],{clipboardData:{setData}});
  expect(setData).toHaveBeenCalledWith('text/plain',body);
  selection.removeAllRanges();
});

it('全文展示明确章节标题，跨章节复制只得到原正文，素材提示仍对应文字', () => {
  const body='开场话术产品介绍';
  const {container,getByText}=render(<ScriptPreview v={{id:2,folderId:1,revision:1,name:'分章',notes:'',body,assets:[],cues:[],outline:[{name:'留人',length:4},{name:'塑品',length:4}]}}/>);
  expect(getByText('第 1 章 · 留人')).toBeTruthy(); expect(getByText('第 2 章 · 塑品')).toBeTruthy();
  const lines=container.querySelector('.sc-lines')!;
  const range=document.createRange(); range.selectNodeContents(lines);
  const selection=window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  const setData=vi.fn(); fireEvent.copy(lines,{clipboardData:{setData}});
  expect(setData).toHaveBeenCalledWith('text/plain',body); selection.removeAllRanges();
});
