import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_TEMPLATES, type StepDef } from '@kudesi/shared';
import { flowApi } from './flowApi';
import { TemplatesPage } from './TemplatesPage';

vi.mock('./flowApi', async (orig) => ({ ...(await orig<typeof import('./flowApi')>()), flowApi: { templates: vi.fn(), definition: vi.fn(), saveDraft: vi.fn(), publish: vi.fn() } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../resources/RecordForm', async (orig) => ({ ...(await orig<typeof import('../../resources/RecordForm')>()), loadRefOptions: vi.fn().mockResolvedValue([{ value: 3, label: '王经理' }]) }));
vi.mock('../org/orgApi', async (orig) => ({ ...(await orig<typeof import('../org/orgApi')>()), orgApi: { positions: vi.fn().mockResolvedValue([]), departments: vi.fn().mockResolvedValue([]) } }));

const tpl = FLOW_TEMPLATES[0];
const draftSteps = (assigneeId?: number): StepDef[] => tpl.steps.map((s) => (s.key === 'approve' ? { ...s, assignee: { source: 'employee', id: assigneeId } } : s.key === 'handover' || s.key === 'receive_back' ? { ...s, assignee: { source: 'employee', id: 3 } } : s)) as StepDef[];
const def = (assigneeId?: number) => ({
  template: { key: tpl.key, label: tpl.label, description: tpl.description, steps: tpl.steps },
  active: null, draft: { id: 1, version: 1, steps: draftSteps(assigneeId), escalateUserIds: [] }, history: [], names: {},
});
beforeEach(() => {
  vi.mocked(flowApi.templates).mockResolvedValue([{ key: tpl.key, label: tpl.label, description: tpl.description, fields: [], stepFields: {}, active: false, version: null }]);
  vi.mocked(flowApi.saveDraft).mockResolvedValue({ ok: true });
  vi.mocked(flowApi.publish).mockResolvedValue({ ok: true, version: 2 });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('流程配置', () => {
  it('办理人没选时列出检查项并禁用“保存并发布”，选好后可发布', async () => {
    vi.mocked(flowApi.definition).mockResolvedValue(def(undefined) as never);
    render(<TemplatesPage />);
    expect(await screen.findByText(/发布前还要处理/)).toBeTruthy();
    const publish = screen.getByText('保存并发布') as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    expect(screen.getByText('未选择')).toBeTruthy();
  });
  it('改动后出现“有未保存的修改”，可放弃；检查通过后能保存并发布', async () => {
    vi.mocked(flowApi.definition).mockResolvedValue(def(3) as never);
    render(<TemplatesPage />);
    await screen.findByText('流转一览');
    expect(screen.queryByText(/发布前还要处理/)).toBeNull();
    expect((screen.getByText('保存草稿') as HTMLButtonElement).disabled).toBe(true);
    const hours = screen.getAllByLabelText(/时限/)[0] as HTMLInputElement;
    fireEvent.change(hours, { target: { value: '5' } });
    expect(screen.getByText('有未保存的修改')).toBeTruthy();
    fireEvent.click(screen.getByText('放弃修改'));
    expect(screen.queryByText('有未保存的修改')).toBeNull();
    fireEvent.click(screen.getByText('保存并发布'));
    await waitFor(() => expect(flowApi.publish).toHaveBeenCalledWith(tpl.key));
    expect(await screen.findByText(/已发布/)).toBeTruthy();
  });
});
