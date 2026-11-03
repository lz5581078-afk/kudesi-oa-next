import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FINANCE_RESOURCE_DEFS } from '@kudesi/shared';
import { RecordForm } from './RecordForm';
import { resourceApi, draftApi, type ResourceDto } from './api';
import { api } from '../api/client';
import { resetUnitOptionsForTest } from './unitOptions';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, companyId: 1, permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('../api/client', async original => ({ ...(await original<typeof import('../api/client')>()), api: vi.fn() }));
vi.mock('./api', async original => {
  const module = await original<typeof import('./api')>();
  return { ...module, resourceApi: { ...module.resourceApi, list: vi.fn(), update: vi.fn() }, draftApi: { ...module.draftApi, get: vi.fn(), clear: vi.fn() } };
});
const def = FINANCE_RESOURCE_DEFS.find(resource => resource.key === 'finance-labor-costs')!;
const record: ResourceDto = { id: 81, type: def.key, title: '合成包装/装袋', status: 'active', statusReason: null, data: { label: '不应出现的标题', workCode: 'STORED-CODE', versionId: 1, archiveCategoryId: 2, workTypeId: 3, unitId: 4, workName: '合成装袋', unitPrice: 100 }, secretConfigured: {}, refLabels: { versionId: '合成版本', archiveCategoryId: '合成归档', workTypeId: '合成工作分类', unitId: '件' }, files: {}, createdAt: '', updatedAt: '' };
beforeEach(() => {
  vi.clearAllMocks(); resetUnitOptionsForTest({});
  vi.mocked(resourceApi.list).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
  vi.mocked(api).mockResolvedValue({ code: 'SERVER-PREVIEW' });
  vi.mocked(draftApi.get).mockResolvedValue({ draft: null });
  vi.mocked(resourceApi.update).mockResolvedValue(record);
});
afterEach(cleanup);

it('实际编辑窗只显示一处编号预览，隐藏派生标题；保存不把编号或标题回传', async () => {
  const saved = vi.fn();
  render(<RecordForm def={def} record={record} lockedFields={['versionId', 'archiveCategoryId']} onClose={vi.fn()} onSaved={saved}/>);
  expect(screen.queryByText('不应出现的标题')).toBeNull();
  expect(screen.queryByDisplayValue('STORED-CODE')).toBeNull();
  expect(await screen.findByText('SERVER-PREVIEW')).toBeTruthy();
  expect(screen.getAllByRole('status', { name: '工作编号' })).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: /工作名称/ }), { target: { value: '合成新名称' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(resourceApi.update).toHaveBeenCalled());
  const body = vi.mocked(resourceApi.update).mock.calls[0][2];
  expect(body).toMatchObject({ workName: '合成新名称', versionId: 1, archiveCategoryId: 2 });
  expect(body).not.toHaveProperty('workCode'); expect(body).not.toHaveProperty('label');
  expect(saved).toHaveBeenCalled();
});
