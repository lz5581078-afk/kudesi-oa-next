import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyRecruitForm } from '@kudesi/shared';
import { recruitApplyApi } from './recruitApi';
import { RecruitApplyPage } from './RecruitApplyPage';

const token = 'b'.repeat(43);
beforeEach(() => {
  window.history.replaceState(null, '', '/apply#' + token);
  vi.spyOn(recruitApplyApi, 'preview').mockResolvedValue({ companyName: '测试公司', channel: '招聘网站' });
  vi.spyOn(recruitApplyApi, 'submit').mockResolvedValue({ ok: true, id: 1 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const page = () => render(<MemoryRouter initialEntries={['/apply#' + token]}><RecruitApplyPage /></MemoryRouter>);
const val = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

it('首页可选手工填写或图片识别；手工填写提交成功', async () => {
  page();
  expect(await screen.findByRole('button', { name: /手工填写/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /已有简历图片/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /手工填写/ }));
  fireEvent.click(screen.getByRole('button', { name: '确认无误，提交' }));
  expect((await screen.findByRole('alert')).textContent).toContain('请填写姓名');
  val('姓名', '张三'); val('性别', '男'); val('出生日期', '1990-05-01'); val('学历', '本科');
  val('手机号', '13800138000'); val('身份证号码', '11010519491231002X');
  fireEvent.click(screen.getByRole('button', { name: '确认无误，提交' }));
  await waitFor(() => expect(recruitApplyApi.submit).toHaveBeenCalled());
  const body = vi.mocked(recruitApplyApi.submit).mock.calls[0][0];
  expect(body).toMatchObject({ token, sourceMode: 'manual', form: { name: '张三', sourceChannel: '招聘网站' } });
  expect(await screen.findByText('提交成功')).toBeTruthy();
});

it('图片识别后进入确认页，需求职者点提交才入库', async () => {
  vi.spyOn(recruitApplyApi, 'recognize').mockResolvedValue({ filled: 6, form: { ...emptyRecruitForm('招聘网站'), name: '李四', gender: '女', birthDate: '1995-03-08', education: '大专', phone: '13900139000', idNo: '11010519491231002X' } });
  page();
  await screen.findByRole('button', { name: /手工填写/ });
  fireEvent.change(screen.getByTestId('resume-file'), { target: { files: [new File(['x'], 'cv.png', { type: 'image/png' })] } });
  expect((await screen.findByLabelText('姓名') as HTMLInputElement).value).toBe('李四');
  expect(screen.getByText(/请逐项核对/)).toBeTruthy();
  expect(recruitApplyApi.submit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认无误，提交' }));
  await waitFor(() => expect(recruitApplyApi.submit).toHaveBeenCalled());
  expect(vi.mocked(recruitApplyApi.submit).mock.calls[0][0].sourceMode).toBe('image');
});

it('二维码无效时只提示，不显示表单', async () => {
  window.history.replaceState(null, '', '/apply#bad');
  render(<MemoryRouter initialEntries={['/apply#bad']}><RecruitApplyPage /></MemoryRouter>);
  expect((await screen.findByRole('alert')).textContent).toContain('二维码无效');
  expect(screen.queryByRole('button', { name: /手工填写/ })).toBeNull();
});
