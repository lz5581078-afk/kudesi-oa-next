import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enrollmentApi } from './enrollmentApi';
import { StaffEnrollmentPage } from './StaffEnrollmentPage';
import { EnrollmentInviteDialog } from './EnrollmentInviteDialog';
const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ login }) }));
const token = 'a'.repeat(43);
const preview = { companyName: '测试公司', mode: 'general' as const, expiresAt: '2030-01-01T00:00:00Z', position: null, positions: [{ id: 7, name: '运营专员', departmentName: '运营部' }] };
beforeEach(() => {
  window.history.replaceState(null, '', '/join#' + token);
  login.mockReset().mockResolvedValue(undefined);
  vi.spyOn(enrollmentApi, 'preview').mockResolvedValue(preview);
  vi.spyOn(enrollmentApi, 'join').mockResolvedValue({ companyName: '测试公司', positionName: '运营专员', account: '13900000001' });
  vi.spyOn(enrollmentApi, 'list').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const page = () => render(<MemoryRouter initialEntries={[window.location.pathname + window.location.hash]}><StaffEnrollmentPage /></MemoryRouter>);
async function fill() {
  fireEvent.change(await screen.findByLabelText('姓名'), { target: { value: '新人' } });
  fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13900000001' } });
  fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'safe-test-password' } });
}
it('通用码填写三项并选择岗位，提交后自动登录', async () => {
  page(); await fill();
  fireEvent.change(screen.getByLabelText('选择岗位'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: '加入公司并登录' }));
  await waitFor(() => expect(login).toHaveBeenCalledWith({ account: '13900000001', password: 'safe-test-password' }));
  expect(enrollmentApi.join).toHaveBeenCalledWith({ token, name: '新人', phone: '13900000001', password: 'safe-test-password', positionId: 7 });
});
it('岗位码显示固定岗位，三项填写后提交不携带岗位参数', async () => {
  vi.mocked(enrollmentApi.preview).mockResolvedValue({ ...preview, mode: 'position', position: { id: 7, name: '运营专员' }, positions: [] });
  page(); await fill();
  expect(screen.queryByLabelText('选择岗位')).toBeNull(); expect(screen.getByText('运营专员')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '加入公司并登录' }));
  await waitFor(() => expect(enrollmentApi.join).toHaveBeenCalled());
  expect(vi.mocked(enrollmentApi.join).mock.calls[0][0]).not.toHaveProperty('positionId');
});
it('重复手机号错误保留填写内容，注册成功但登录失败时不重复注册', async () => {
  vi.mocked(enrollmentApi.join).mockRejectedValueOnce(new Error('该手机号暂不能注册'));
  login.mockRejectedValue(new Error('网络错误'));
  page(); await fill(); fireEvent.change(screen.getByLabelText('选择岗位'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: '加入公司并登录' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '该手机号暂不能注册');
  expect((screen.getByLabelText('姓名') as HTMLInputElement).value).toBe('新人');
  fireEvent.click(screen.getByRole('button', { name: '加入公司并登录' }));
  expect(await screen.findByRole('heading', { name: '入职成功' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '加入公司并登录' })).toBeNull();
  expect(screen.getByRole('link', { name: '前往登录' })).toBeTruthy();
});
it('无效码和已停用码显示明确提示', async () => {
  window.history.replaceState(null, '', '/join#bad'); page();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '入职二维码无效，请联系人事重新获取。');
  expect(enrollmentApi.preview).not.toHaveBeenCalled(); cleanup();
  window.history.replaceState(null, '', '/join#' + token);
  vi.mocked(enrollmentApi.preview).mockRejectedValue(new Error('二维码已失效')); page();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '二维码已失效');
});
it.each([undefined, { id: 7, name: '运营专员' }])('生成通用/专属码参数正确，显示二维码并可停用', async position => {
  const created = { id: 1, token, mode: position ? 'position' as const : 'general' as const, positionId: position?.id ?? null, expiresAt: preview.expiresAt };
  vi.spyOn(enrollmentApi, 'create').mockResolvedValue(created);
  vi.spyOn(enrollmentApi, 'revoke').mockResolvedValue({ ok: true });
  vi.mocked(enrollmentApi.list).mockResolvedValue([{ ...created, positionName: '运营专员', createdAt: preview.expiresAt, status: 'active' }]);
  render(<EnrollmentInviteDialog position={position} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '生成二维码' }));
  expect(await screen.findByRole('img', { name: '入职二维码' })).toBeTruthy();
  expect(enrollmentApi.create).toHaveBeenCalledWith(position ? { mode: 'position', positionId: 7, employmentType: 'regular' } : { mode: 'general', employmentType: 'regular' });
  fireEvent.click(screen.getByText(/已生成的/)); fireEvent.click(await screen.findByRole('button', { name: '停用' }));
  await waitFor(() => expect(enrollmentApi.revoke).toHaveBeenCalledWith(1));
  await waitFor(() => expect(screen.queryByRole('img', { name: '入职二维码' })).toBeNull());
});

it('同一浏览器改扫另一个码时，刷新公司岗位并清空上一份表单', async () => {
  const nextToken = 'b'.repeat(43);
  vi.mocked(enrollmentApi.preview).mockImplementation(async t => t === token ? preview : { ...preview, companyName: '另一公司', mode: 'position', positions: [], position: { id: 8, name: '另一岗位' } });
  function SwitchCode() { const navigate = useNavigate(); return <><button onClick={() => navigate('/join#' + nextToken)}>改扫另一二维码</button><StaffEnrollmentPage /></>; }
  render(<MemoryRouter initialEntries={['/join#' + token]}><SwitchCode /></MemoryRouter>);
  await fill(); fireEvent.change(screen.getByLabelText('选择岗位'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: '改扫另一二维码' }));
  expect(await screen.findByRole('heading', { name: '加入另一公司' })).toBeTruthy();
  expect(screen.getByText('另一岗位')).toBeTruthy(); expect(screen.queryByLabelText('选择岗位')).toBeNull();
  expect((screen.getByLabelText('姓名') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('登录密码') as HTMLInputElement).value).toBe('');
  await fill(); fireEvent.click(screen.getByRole('button', { name: '加入公司并登录' }));
  await waitFor(() => expect(enrollmentApi.join).toHaveBeenCalledWith(expect.objectContaining({ token: nextToken })));
});

it('生成兼职岗位码，类型和合作日期由发码人指定', async()=>{
  vi.spyOn(enrollmentApi,'create').mockResolvedValue({id:3,token,mode:'position',positionId:7,expiresAt:null,employmentType:'part_time'});
  render(<EnrollmentInviteDialog position={{id:7,name:'运营专员'}} onClose={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('入职码用工类型'),{target:{value:'part_time'}});
  expect(screen.queryByLabelText('合作开始日期')).toBeNull();
  expect(screen.queryByLabelText('合作结束日期')).toBeNull();
  expect(screen.queryByLabelText('二维码有效期')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'生成二维码'}));
  await waitFor(()=>expect(enrollmentApi.create).toHaveBeenCalledWith({mode:'position',positionId:7,employmentType:'part_time'}));
});
it('临时工码不填写日期，生成长期码并提示新码替换旧码',async()=>{
  vi.spyOn(enrollmentApi,'create').mockResolvedValue({id:4,token,mode:'position',positionId:7,expiresAt:null,employmentType:'temp'});
  render(<EnrollmentInviteDialog position={{id:7,name:'运营专员'}} onClose={()=>{}}/>);
  fireEvent.change(screen.getByLabelText('入职码用工类型'),{target:{value:'temp'}});
  expect(screen.queryByLabelText('合作结束日期')).toBeNull();
  expect((screen.getByRole('button',{name:'生成二维码'}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'生成二维码'}));
  await waitFor(()=>expect(enrollmentApi.create).toHaveBeenCalledWith({mode:'position',positionId:7,employmentType:'temp'}));
  expect(await screen.findByText('长期有效（重新生成后旧码失效）')).toBeTruthy();
});

it('临时工扫码页展示人事指定的类型和期限，不让员工自行改用工类型',async()=>{
  vi.mocked(enrollmentApi.preview).mockResolvedValue({...preview,mode:'position',position:{id:7,name:'运营专员'},positions:[],employmentType:'temp',contractStartDate:'2026-01-01',contractEndDate:'2099-12-31'});
  page();expect(await screen.findByText('用工类型：临时工')).toBeTruthy();expect(screen.getByText(/2099-12-31/)).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();expect(screen.getByLabelText('姓名')).toBeTruthy();expect(screen.getByLabelText('手机号')).toBeTruthy();expect(screen.getByLabelText('登录密码')).toBeTruthy();
});
