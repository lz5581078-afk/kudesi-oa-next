import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScriptVersionPanel } from './ScriptVersionPanel';
import { PondQuestionArticle } from './ProductQuestionArticle';
import { api } from '../../api/client';

vi.mock('../../api/client', () => ({ api: vi.fn() }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('templates') ? [] : { body: '原问题', revision: 1 },
  );
});
afterEach(cleanup);

function openEditor() {
  const dirty = vi.fn();
  render(
    <ScriptVersionPanel
      manage
      folderTitle="玉米"
      onDirty={dirty}
      onName={vi.fn()}
      initial={{
        id: 1,
        folderId: 2,
        name: '第一版',
        notes: '',
        body: '甲乙',
        revision: 1,
        assets: [],
        cues: [{ asset: 4, start: 1, end: 2 }],
        outline: [
          { name: '开场', length: 1 },
          { name: '互动', length: 1 },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByText('编辑版本'));
  return dirty;
}
it('删除目录保留稿件和标注，在选中章节前插入；取消管理不改动稿件', async () => {
  openEditor();
  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
  click('管理章节');
  click('删除章节');
  click('取消');
  expect(screen.getByRole('button', { name: /01 开场/ })).toBeTruthy();
  click('管理章节');
  click('删除章节');
  fireEvent.change(screen.getByLabelText('新环节名称'), { target: { value: '留人' } });
  click('在本章前添加');
  click('应用目录');
  click('保存版本');
  expect(api).toHaveBeenCalledWith(
    '/live/scripts/versions/1',
    expect.objectContaining({
      body: expect.objectContaining({
        body: '甲乙',
        cues: [{ asset: 4, start: 1, end: 2 }],
        outline: [
          { name: '留人', length: 0 },
          { name: '互动', length: 2 },
        ],
      }),
    }),
  );
});
it('问题库独立保存，切换页签保留版本草稿和离开提示', async () => {
  const dirty = openEditor();
  fireEvent.change(screen.getByLabelText('话术正文'), { target: { value: '甲乙丙' } });
  fireEvent.click(screen.getByRole('button', { name: '问题库' }));
  await screen.findByLabelText('产品问题库正文');
  fireEvent.change(screen.getByLabelText('产品问题库正文'), { target: { value: '谁适合种？' } });
  fireEvent.click(screen.getByRole('button', { name: '正文与标注' }));
  expect((screen.getByLabelText('话术正文') as HTMLTextAreaElement).value).toBe('甲乙丙');
  fireEvent.click(screen.getByRole('button', { name: '问题库' }));
  fireEvent.click(screen.getByText('保存问题库'));
  await screen.findByText('问题库已保存');
  expect(api).toHaveBeenCalledWith('/live/scripts/folders/2/question-article', {
    method: 'PUT',
    body: { body: '谁适合种？', revision: 1 },
  });
  expect(dirty).toHaveBeenLastCalledWith(true);
});

it('鱼塘文章允许管理员直接填写保存，普通查看者只能阅读', async () => {
  const page = render(<PondQuestionArticle manage />);
  fireEvent.change(await screen.findByRole('textbox', {name:'鱼塘问题库正文'}), {target:{value:'鱼塘答疑'}});
  fireEvent.click(screen.getByRole('button',{name:'保存问题库'}));
  await screen.findByText('问题库已保存');
  expect(api).toHaveBeenCalledWith('/live/scripts/pond-question-article', {
    method: 'PUT', body: {body:'鱼塘答疑', revision:1}
  });
  page.rerender(<PondQuestionArticle manage={false}/>);
  expect(screen.getByText('鱼塘答疑')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button',{name:'保存问题库'})).toBeNull();
});


it('鱼塘问题库位于版本问题库之后，切换分区保留鱼塘草稿并纳入离开保护', async () => {
  const dirty = openEditor();
  expect(within(screen.getByRole('group', {name:'编辑分区'})).getAllByRole('button').map(b => b.textContent))
    .toEqual(['正文与标注', '问题库', '鱼塘问题库', '素材库', '版本资料']);
  fireEvent.click(screen.getByRole('button', {name:'鱼塘问题库'}));
  const input = await screen.findByRole('textbox', {name:'鱼塘问题库正文'});
  fireEvent.change(input, {target:{value:'保留的鱼塘草稿'}});
  expect(dirty).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole('button', {name:'保存版本'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'正文与标注'}));
  fireEvent.click(screen.getByRole('button', {name:'鱼塘问题库'}));
  expect((screen.getByRole('textbox', {name:'鱼塘问题库正文'}) as HTMLTextAreaElement).value).toBe('保留的鱼塘草稿');
  fireEvent.click(screen.getByRole('button', {name:'保存问题库'}));
  await screen.findByText('问题库已保存');
  expect(api).toHaveBeenCalledWith('/live/scripts/pond-question-article', {method:'PUT', body:{body:'保留的鱼塘草稿', revision:1}});
  expect(dirty).toHaveBeenLastCalledWith(false);
});
