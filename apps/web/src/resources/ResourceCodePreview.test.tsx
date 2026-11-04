import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';
import { api } from '../api/client';
import { ResourceCodePreview } from './ResourceCodePreview';
import type { ResourceDto } from './api';

vi.mock('../api/client', () => ({ api: vi.fn() }));
const auth = vi.hoisted(() => ({ companyId: 1, id: 2, permissions: { isCompanyAdmin: true, allow: [] as string[], deny: [] as string[] } }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: auth }) }));
const def = FINANCE_RESOURCE_DEFS.find(def => def.key === 'finance-labor-costs')!;
const values = { versionId: 1, archiveCategoryId: 2, workTypeId: 3, workName: '合成装袋', unitPrice: 999, workCode: '旧编号' };
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(201); });
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); auth.companyId = 1; auth.permissions = { isCompanyAdmin: true, allow: [], deny: [] }; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('表单自动编号预览', () => {
  it('新建只发编号依赖，不提交成本或旧编号；改名称后清旧预览并重新计算', async () => {
    vi.mocked(api).mockResolvedValueOnce({ code: 'RL-FIRST' }).mockResolvedValueOnce({ code: 'RL-NEXT' });
    const view = render(<ResourceCodePreview def={def} values={values}/>);
    await tick();
    expect(api).toHaveBeenCalledWith('/resources/finance-labor-costs/code-preview', { method: 'POST', body: { values: { versionId: 1, archiveCategoryId: 2, workTypeId: 3, workName: '合成装袋' } } });
    expect(screen.getByRole('status', { name: '工作编号' }).textContent).toBe('RL-FIRST');
    view.rerender(<ResourceCodePreview def={def} values={{ ...values, workName: '新名称' }}/>);
    expect(screen.queryByText('RL-FIRST')).toBeNull();
    await tick(); expect(screen.getByText('RL-NEXT')).toBeTruthy();
  });

  it('编辑仅有修改权限仍走所属记录的编辑预览；无权限不请求或显示旧值', async () => {
    auth.permissions = { isCompanyAdmin: false, allow: ['resource.finance-labor-costs.edit'], deny: [] };
    vi.mocked(api).mockResolvedValue({ code: 'RL-EDIT' });
    const record = { id: 51 } as ResourceDto;
    const view = render(<ResourceCodePreview def={def} values={values} record={record}/>);
    await tick(); expect(api).toHaveBeenCalledWith('/resources/finance-labor-costs/51/code-preview', expect.anything());
    auth.permissions = { isCompanyAdmin: false, allow: [], deny: [] };
    view.rerender(<ResourceCodePreview def={def} values={values} record={record}/>);
    await tick(); expect(api).toHaveBeenCalledTimes(1); expect(screen.queryByText('RL-EDIT')).toBeNull();
  });

  it('公司切换及迟到请求不覆盖新预览；失败清旧值并允许重试', async () => {
    let finish!: (result: { code: string }) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; })).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ code: 'NEW-COMPANY' });
    const view = render(<ResourceCodePreview def={def} values={values}/>);
    await tick(); auth.companyId = 9;
    view.rerender(<ResourceCodePreview def={def} values={values}/>); await tick();
    await act(async () => { finish({ code: 'OLD-COMPANY' }); });
    expect(screen.queryByText('OLD-COMPANY')).toBeNull();
    expect(screen.getByText(/编号预览暂不可用/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await tick(); expect(screen.getByText('NEW-COMPANY')).toBeTruthy();
  });
});
