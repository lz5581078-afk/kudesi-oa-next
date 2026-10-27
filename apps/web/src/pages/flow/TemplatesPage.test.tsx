import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_TEMPLATES, type StepDef } from '@kudesi/shared';
import { designerApi, type DesignerDefinition, type DirectoryRow } from './designerApi';
import { TemplatesPage } from './TemplatesPage';

vi.mock('./designerApi', async (orig) => ({
  ...(await orig<typeof import('./designerApi')>()),
  designerApi: { directory: vi.fn(), create: vi.fn(), updateMeta: vi.fn(), remove: vi.fn(), definition: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(), deactivate: vi.fn(), activate: vi.fn(), discardDraft: vi.fn(), nodesForDesigner: vi.fn(), policy: vi.fn() },
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../resources/RecordForm', async (orig) => ({ ...(await orig<typeof import('../../resources/RecordForm')>()), loadRefOptions: vi.fn().mockResolvedValue([{ value: 3, label: '王经理' }]) }));
vi.mock('../org/orgApi', async (orig) => ({ ...(await orig<typeof import('../org/orgApi')>()), orgApi: { positions: vi.fn().mockResolvedValue([]), departments: vi.fn().mockResolvedValue([]) } }));

const tpl = FLOW_TEMPLATES[0];
const row = (o: Partial<DirectoryRow>): DirectoryRow => ({ key: tpl.key, label: tpl.label, description: '', custom: false, kind: '内置业务流程', departmentId: null, departmentName: '', status: 'active', version: 1, hasDraft: false, everPublished: true, stepCount: 3, issues: [], runCount: 2, runningCount: 1, updatedAt: null, ...o });
const draftSteps = (assigneeId?: number): StepDef[] => tpl.steps.map((s) => (s.key === 'approve' ? { ...s, assignee: { source: 'employee', id: assigneeId } } : s.key === 'handover' || s.key === 'receive_back' ? { ...s, assignee: { source: 'employee', id: 3 } } : s)) as StepDef[];
const def = (assigneeId?: number): DesignerDefinition => ({
  template: { key: tpl.key, label: tpl.label, description: tpl.description, steps: tpl.steps as StepDef[], custom: false, departmentId: null, fields: [], stepFields: {}, posting: null },
  active: null, draft: { id: 1, version: 1, status: 'draft', steps: draftSteps(assigneeId), escalateUserIds: [], publishedAt: null, createdAt: null, schema: null }, history: [], names: {},
});
const renderAt = (url: string) => render(<MemoryRouter initialEntries={[url]}><TemplatesPage /></MemoryRouter>);

beforeEach(() => {
  vi.mocked(designerApi.directory).mockResolvedValue({ canManage: true, templates: [row({}), row({ key: 'c1', label: '请假自建', custom: true, kind: '自建流程', status: 'inactive', version: null, issues: ['「审批」还没有选择办理人'], runCount: 0 })] });
  vi.mocked(designerApi.nodesForDesigner).mockResolvedValue({ templates: [], business: [], categories: [], canManage: true });
  vi.mocked(designerApi.saveDraft).mockResolvedValue({ ok: true });
  vi.mocked(designerApi.publish).mockResolvedValue({ ok: true, version: 2 });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('流程目录', () => {
  it('列出流程与配置检查，可按名称搜索、按类型筛选，空结果可清除', async () => {
    renderAt('/flow/templates');
    expect(await screen.findByText('请假自建')).toBeTruthy();
    expect(screen.getByText('「审批」还没有选择办理人')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('搜索流程'), { target: { value: '不存在' } });
    expect(screen.getByText('没有符合条件的流程')).toBeTruthy();
    fireEvent.click(screen.getByText('清除筛选，查看全部'));
    fireEvent.change(screen.getByLabelText('流程类型'), { target: { value: 'custom' } });
    expect(screen.queryByText(tpl.label)).toBeNull();
    expect(screen.getByText('请假自建')).toBeTruthy();
  });
  it('新建流程：填名称后创建并进入设计器', async () => {
    vi.mocked(designerApi.create).mockResolvedValue({ key: tpl.key });
    vi.mocked(designerApi.definition).mockResolvedValue(def(3));
    renderAt('/flow/templates');
    await screen.findByText('请假自建');
    fireEvent.click(screen.getByText('新建流程'));
    const dialog = screen.getByRole('dialog', { name: '新建流程' });
    fireEvent.change(within(dialog).getByLabelText('流程名称'), { target: { value: '外出申请' } });
    fireEvent.click(within(dialog).getByText('创建流程'));
    await waitFor(() => expect(designerApi.create).toHaveBeenCalledWith(expect.objectContaining({ name: '外出申请', departmentId: null, sourceKey: null })));
    expect(await screen.findByText('流转一览')).toBeTruthy();
  });
});

describe('流程设计器', () => {
  it('办理人没选时列出检查项并禁用“保存并发布”', async () => {
    vi.mocked(designerApi.definition).mockResolvedValue(def(undefined));
    renderAt(`/flow/templates?flow=${tpl.key}`);
    expect(await screen.findByText(/发布前还要处理/)).toBeTruthy();
    expect((screen.getByText('保存并发布') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('未选择').length).toBeGreaterThan(0);
  });
  it('改动后出现“有未保存的修改”，可放弃；检查通过后保存并发布', async () => {
    vi.mocked(designerApi.definition).mockResolvedValue(def(3));
    renderAt(`/flow/templates?flow=${tpl.key}`);
    await screen.findByText('流转一览');
    expect(screen.queryByText(/发布前还要处理/)).toBeNull();
    expect((screen.getByText('保存草稿') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('节点列表'));
    fireEvent.click(screen.getAllByText('配置')[1]);
    fireEvent.change(screen.getByLabelText('时限（分钟）'), { target: { value: '300' } });
    expect(screen.getAllByText('有未保存的修改').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('放弃修改'));
    expect(screen.queryByText('有未保存的修改')).toBeNull();
    fireEvent.click(screen.getByText('保存并发布'));
    await waitFor(() => expect(designerApi.publish).toHaveBeenCalledWith(tpl.key));
    expect(await screen.findByText(/已发布/)).toBeTruthy();
  });
  it('内置流程的申请表单只读，并提示用复制得到可改版本', async () => {
    vi.mocked(designerApi.definition).mockResolvedValue(def(3));
    renderAt(`/flow/templates?flow=${tpl.key}`);
    await screen.findByText('流转一览');
    fireEvent.click(screen.getByRole('tab', { name: /申请表单/ }));
    expect(screen.getByText(/想要一个可以自由改字段/)).toBeTruthy();
  });
  it('检查与启用页签展示版本记录，历史版本可启用', async () => {
    const d = def(3);
    d.history = [{ version: 2, status: 'active', publishedAt: '2026-01-02T00:00:00Z', stepCount: 4 }, { version: 1, status: 'retired', publishedAt: '2026-01-01T00:00:00Z', stepCount: 4 }, { version: 3, status: 'draft', publishedAt: null, stepCount: 4 }];
    vi.mocked(designerApi.definition).mockResolvedValue(d);
    vi.mocked(designerApi.activate).mockResolvedValue({ ok: true });
    renderAt(`/flow/templates?flow=${tpl.key}`);
    await screen.findByText('流转一览');
    fireEvent.click(screen.getByRole('tab', { name: /检查与启用/ }));
    fireEvent.click(screen.getByText('启用此版本'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('启用'));
    await waitFor(() => expect(designerApi.activate).toHaveBeenCalledWith(tpl.key, 1));
  });
  it('自建流程：办理人可按岗位类型/职责组/关联资料，节点可设并行分支和异常连线，不合法时禁用发布', async () => {
    const steps: StepDef[] = [
      { key: 'apply', name: '提交申请', type: 'submit', assignee: { source: 'requester' } },
      { key: 'a', name: '老板审', type: 'approval', assignee: { source: 'employee', id: 3 } },
      { key: 'b', name: '财务核', type: 'finance', assignee: { source: 'employee', id: 3 } },
      { key: 'fix', name: '异常处置', type: 'approval', assignee: { source: 'employee', id: 3 } },
      { key: 'end', name: '结束', type: 'end' },
    ];
    const d = def(3);
    d.template = { ...d.template, key: 'c1', label: '自建流程', custom: true, steps, fields: [{ key: 'storeId', label: '店铺', type: 'ref', ref: 'stores', group: '申请' }] };
    d.draft = { ...d.draft, steps, schema: { fields: d.template.fields, stepFields: {}, posting: null } };
    vi.mocked(designerApi.definition).mockResolvedValue(d);
    renderAt('/flow/templates?flow=c1');
    await screen.findByText('流转一览');
    fireEvent.click(screen.getByText('流程画布'));
    fireEvent.click(screen.getByRole('button', { name: /选择节点 2/ }));
    fireEvent.change(screen.getByLabelText('办理人类型'), { target: { value: 'position_type' } });
    expect(screen.getByLabelText('岗位类型')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('办理人类型'), { target: { value: 'related_owner' } });
    expect(screen.getByLabelText('负责人种类')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('办理人类型'), { target: { value: 'duty_group' } });
    expect(screen.getByLabelText('具体对象')).toBeTruthy();
    // 只给一个步骤设并行分支：提示至少 2 个，发布按钮禁用
    fireEvent.change(screen.getByLabelText('办理人类型'), { target: { value: 'employee' } });
    fireEvent.change(screen.getByLabelText('具体对象'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('并行分支'), { target: { value: 'g1' } });
    expect(await screen.findByText(/并行分支「g1」至少要有 2 个步骤/)).toBeTruthy();
    expect((screen.getByText('保存并发布') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /选择节点 3/ }));
    fireEvent.change(screen.getByLabelText('并行分支'), { target: { value: 'g1' } });
    expect(screen.queryByText(/并行分支「g1」至少要有 2 个步骤/)).toBeNull();
    // 异常连线：先把“异常处置”设为仅异常步骤，再让别的步骤指向它
    fireEvent.click(screen.getByRole('button', { name: /选择节点 4/ }));
    fireEvent.click(screen.getByLabelText(/仅异常步骤/));
    expect(await screen.findByText(/没有任何步骤的异常连线指向它/)).toBeTruthy();
  });
});
