import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScriptVersionPanel } from './ScriptVersionPanel';
import { api } from '../../api/client';
import type { Asset } from './scriptCues';

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

function openVersion(manage = true, assets: Asset[] = []) {
  const dirty = vi.fn();
  render(
    <ScriptVersionPanel
      manage={manage}
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
        assets,
        cues: [{ asset: 4, start: 1, end: 2 }],
        outline: [
          { name: '开场', length: 1 },
          { name: '互动', length: 1 },
        ],
      }}
    />,
  );
  return dirty;
}

function openEditor() {
  const dirty = openVersion();
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
  click('确认删除章节');
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
  fireEvent.change(screen.getByLabelText('互动正文（第2章）'), { target: { value: '乙丙' } });
  fireEvent.click(screen.getByRole('button', { name: '问题库' }));
  fireEvent.click(await screen.findByText('编辑文章'));
  fireEvent.change(screen.getByLabelText('产品问题库正文'), { target: { value: '谁适合种？' } });
  fireEvent.click(screen.getByRole('button', { name: '正文与标注' }));
  expect((screen.getByLabelText('互动正文（第2章）') as HTMLTextAreaElement).value).toBe('乙丙');
  fireEvent.click(screen.getByRole('button', { name: '问题库' }));
  fireEvent.click(screen.getByText('保存问题库'));
  await screen.findByText('问题库已保存');
  expect(api).toHaveBeenCalledWith('/live/scripts/folders/2/question-article', {
    method: 'PUT',
    body: { body: '谁适合种？', revision: 1 },
  });
  expect(dirty).toHaveBeenLastCalledWith(true);
});

it.each([true, false])('预览直接打开原素材，按直播管理权限显示上传入口（%s）', (manage) => {
  openVersion(manage, [{ id: 4, name: '籽粒示意图', category: 'image' }]);
  fireEvent.click(screen.getByRole('button', { name: '素材库' }));
  const zone = within(screen.getByRole('region', { name: '图片素材区' }));
  expect(zone.getByRole('button', { name: '下载 籽粒示意图' })).toBeTruthy();
  expect(Boolean(zone.queryByLabelText('选择图片'))).toBe(manage);
  expect(Boolean(zone.queryByRole('button', { name: '手机扫码上传' }))).toBe(manage);
  expect(screen.queryByRole('button', { name: '保存版本' })).toBeNull();
});
