import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { Link, MemoryRouter, RouterProvider, createMemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceApi } from './api';
import { editCarrier } from './gridTestKit';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('./RecordForm', () => ({ RecordForm: () => <div>表单</div>, loadRefOptions: async () => [] }));
vi.mock('./RecordDetail', () => ({ RecordDetail: () => <div>详情</div>, useResourceCan: () => () => true }));
vi.mock('./CategoryTree', () => ({ CategoryTree: () => null }));
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, list: vi.fn(), gridSave: vi.fn(), columnFacets: vi.fn().mockResolvedValue({ items: [] }), users: vi.fn().mockResolvedValue([]) } };
});
import { ResourcePage } from './ResourcePage';

const row = (id: number, carrier: string) => ({ id, type: 'phones', title: `1380013800${id}`, status: 'normal', statusReason: null, data: { number: `1380013800${id}`, carrier, usageType: 'company_kept' }, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '', version: `v${id}` });
const list = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 20, tabCounts: {} }) as never;
const saveOk = () => vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 1, failed: 0, results: [{ kind: 'update', id: 1, ok: true, row: { ...row(1, '电信') } as never }] });
const saveFail = () => vi.mocked(resourceApi.gridSave).mockResolvedValue({ saved: 0, failed: 1, results: [{ kind: 'update', id: 1, ok: false, code: 'invalid', message: '运营商不合法' }] } as never);

function Harness() {
  const loc = useLocation();
  const nav = useNavigate();
  return (
    <div>
      <nav>
        <Link to="/other">侧栏：别的页面</Link>
        <Link to="/resources/phones?open=7">只是打开记录</Link>
        <button type="button" onClick={() => nav('/search-result')}>顶栏搜索跳转</button>
        <button type="button" onClick={() => nav('/resources/phones?tab=b', { replace: true })}>页面内标签页</button>
      </nav>
      <output aria-label="地址">{loc.pathname + loc.search}</output>
      {loc.pathname.startsWith('/resources') ? <ResourcePage type="phones" /> : <p>别处</p>}
    </div>
  );
}
function mountRouter() {
  const router = createMemoryRouter([{ path: '*', element: <Harness /> }], { initialEntries: ['/start', '/resources/phones'], initialIndex: 1 });
  render(<RouterProvider router={router} />);
  return router;
}
const where = () => screen.getByLabelText('地址').textContent;
async function dirtyGrid() {
  fireEvent.click(await screen.findByRole('button', { name: '表格编辑' }));
  await screen.findByRole('application');
  await editCarrier('电信');
}
const dialog = () => screen.queryByRole('alertdialog');

beforeEach(() => {
  localStorage.clear();
  vi.mocked(resourceApi.list).mockResolvedValue(list([row(1, '移动'), row(2, '联通')]));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('表格编辑：有未保存修改时离开要确认', () => {
  describe('页面内：退出表格编辑', () => {
    const open = async () => {
      render(<MemoryRouter><ResourcePage type="phones" /></MemoryRouter>);
      await dirtyGrid();
      fireEvent.click(screen.getByRole('button', { name: '退出表格编辑' }));
    };
    it('弹出三个选项，说明还有几处修改', async () => {
      await open();
      expect(dialog()).toBeTruthy();
      expect(dialog()!.textContent).toMatch(/1 处修改/);
      expect(screen.getByRole('button', { name: '保存并退出' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '放弃修改并退出' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '继续编辑' })).toBeTruthy();
    });
    it('继续编辑：关掉弹窗，修改还在', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
      expect(dialog()).toBeNull();
      expect(screen.getByText('1 处修改')).toBeTruthy();
      expect(screen.getByRole('application')).toBeTruthy();
    });
    it('Esc 等同继续编辑', async () => {
      await open();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(dialog()).toBeNull();
      expect(screen.getByRole('application')).toBeTruthy();
    });
    it('放弃修改并退出：不保存就退出', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: '放弃修改并退出' }));
      await waitFor(() => expect(screen.queryByRole('application')).toBeNull());
      expect(resourceApi.gridSave).not.toHaveBeenCalled();
    });
    it('保存并退出：保存成功后退出', async () => {
      saveOk();
      await open();
      fireEvent.click(screen.getByRole('button', { name: '保存并退出' }));
      await waitFor(() => expect(screen.queryByRole('application')).toBeNull());
      expect(resourceApi.gridSave).toHaveBeenCalledTimes(1);
    });
    it('保存并退出：仍有失败的行时留在表格里并提示，不退出', async () => {
      saveFail();
      await open();
      fireEvent.click(screen.getByRole('button', { name: '保存并退出' }));
      await waitFor(() => expect(dialog()).toBeNull());
      expect(screen.getByRole('application')).toBeTruthy();
      expect(screen.getAllByRole('alert').some((a) => /没有退出/.test(a.textContent ?? ''))).toBe(true);
      expect(screen.getByText(/1 行保存失败/)).toBeTruthy();
    });
    it('没有修改时直接退出，不弹窗', async () => {
      render(<MemoryRouter><ResourcePage type="phones" /></MemoryRouter>);
      fireEvent.click(await screen.findByRole('button', { name: '表格编辑' }));
      await screen.findByRole('application');
      fireEvent.click(screen.getByRole('button', { name: '退出表格编辑' }));
      await waitFor(() => expect(screen.queryByRole('application')).toBeNull());
      expect(dialog()).toBeNull();
    });
  });

  describe('站内导航（数据路由 useBlocker）', () => {
    it('点侧栏链接：拦住并弹窗；继续编辑 → 留在原页，修改还在', async () => {
      mountRouter();
      await dirtyGrid();
      fireEvent.click(screen.getByRole('link', { name: '侧栏：别的页面' }));
      await waitFor(() => expect(dialog()).toBeTruthy());
      expect(where()).toBe('/resources/phones');
      fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
      expect(dialog()).toBeNull();
      expect(where()).toBe('/resources/phones');
      expect(screen.getByText('1 处修改')).toBeTruthy();
    });
    it('放弃修改并退出 → 去目标页，不保存', async () => {
      mountRouter();
      await dirtyGrid();
      fireEvent.click(screen.getByRole('link', { name: '侧栏：别的页面' }));
      fireEvent.click(await screen.findByRole('button', { name: '放弃修改并退出' }));
      await waitFor(() => expect(where()).toBe('/other'));
      expect(resourceApi.gridSave).not.toHaveBeenCalled();
    });
    it('保存并退出 → 保存成功后去目标页', async () => {
      saveOk();
      mountRouter();
      await dirtyGrid();
      fireEvent.click(screen.getByRole('link', { name: '侧栏：别的页面' }));
      fireEvent.click(await screen.findByRole('button', { name: '保存并退出' }));
      await waitFor(() => expect(where()).toBe('/other'));
      expect(resourceApi.gridSave).toHaveBeenCalledTimes(1);
    });
    it('保存并退出 → 仍有失败行：留在原页，不跳转', async () => {
      saveFail();
      mountRouter();
      await dirtyGrid();
      fireEvent.click(screen.getByRole('link', { name: '侧栏：别的页面' }));
      fireEvent.click(await screen.findByRole('button', { name: '保存并退出' }));
      await waitFor(() => expect(dialog()).toBeNull());
      expect(where()).toBe('/resources/phones');
      expect(screen.getByRole('application')).toBeTruthy();
    });
    it('程序里的跳转（顶栏搜索）、页面内标签页切换也被拦住', async () => {
      mountRouter();
      await dirtyGrid();
      fireEvent.click(screen.getByRole('button', { name: '顶栏搜索跳转' }));
      await waitFor(() => expect(dialog()).toBeTruthy());
      expect(where()).toBe('/resources/phones');
      fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
      fireEvent.click(screen.getByRole('button', { name: '页面内标签页' }));
      await waitFor(() => expect(dialog()).toBeTruthy());
      expect(where()).toBe('/resources/phones');
    });
    it('浏览器后退被拦住；放弃后才真正后退', async () => {
      const router = mountRouter();
      await dirtyGrid();
      act(() => { void router.navigate(-1); });
      await waitFor(() => expect(dialog()).toBeTruthy());
      expect(where()).toBe('/resources/phones');
      fireEvent.click(screen.getByRole('button', { name: '放弃修改并退出' }));
      await waitFor(() => expect(where()).toBe('/start'));
    });
    it('只是 ?open= 打开一条记录不算离开', async () => {
      mountRouter();
      await dirtyGrid();
      fireEvent.click(screen.getByRole('link', { name: '只是打开记录' }));
      await waitFor(() => expect(where()).toBe('/resources/phones'));
      expect(dialog()).toBeNull();
    });
    it('没有未保存修改时，导航不拦', async () => {
      mountRouter();
      fireEvent.click(await screen.findByRole('button', { name: '表格编辑' }));
      await screen.findByRole('application');
      fireEvent.click(screen.getByRole('link', { name: '侧栏：别的页面' }));
      await waitFor(() => expect(where()).toBe('/other'));
      expect(dialog()).toBeNull();
    });
    it('不在表格编辑模式时，导航不拦', async () => {
      mountRouter();
      await screen.findByRole('button', { name: '表格编辑' });
      fireEvent.click(screen.getByRole('link', { name: '侧栏：别的页面' }));
      await waitFor(() => expect(where()).toBe('/other'));
    });
  });

  it('刷新 / 关闭浏览器标签页：有未保存修改时挂着 beforeunload 提示，保存后撤掉', async () => {
    saveOk();
    render(<MemoryRouter><ResourcePage type="phones" /></MemoryRouter>);
    await dirtyGrid();
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '保存全部' }));
    await waitFor(() => expect(screen.queryByText('1 处修改')).toBeNull());
    const ev2 = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });
});
