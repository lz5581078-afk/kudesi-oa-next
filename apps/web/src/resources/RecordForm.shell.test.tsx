import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef } from '@kudesi/shared';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
const create = vi.fn();
vi.mock('./api', async (orig) => {
  const mod = await orig<typeof import('./api')>();
  return { ...mod, resourceApi: { ...mod.resourceApi, create: (...a: unknown[]) => create(...a), similarCheck: vi.fn().mockResolvedValue({ blocked: [], warnings: [] }), list: vi.fn().mockResolvedValue({ items: [], total: 0 }), users: vi.fn().mockResolvedValue([]) } };
});
import { RecordForm } from './RecordForm';

const def = getResourceDef('stores')!;
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('资料表单通用壳', () => {
  it('必填没填：保存前就在表单里标出来并列出汇总，不请求服务器；填了就清掉提示', () => {
    render(<RecordForm def={def} record={null} onClose={() => undefined} onSaved={() => undefined} />);
    expect(screen.getByText(/为必填项/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText(/还有 \d+ 项需要补充或修改/)).toBeTruthy();
    expect(screen.getAllByText(/^请填写/).length).toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('失焦即时校验：必填字段点进去再离开，立刻提示“请填写…”，填了就消失', () => {
    render(<RecordForm def={def} record={null} onClose={() => undefined} onSaved={() => undefined} />);
    const req = def.fields.find((f) => f.required && f.type === 'text')!;
    const input = document.querySelector<HTMLInputElement>(`[data-field="${req.key}"] input`)!;
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(screen.getByText(`请填写${req.label}`)).toBeTruthy();
    fireEvent.change(input, { target: { value: '甲' } });
    expect(screen.queryByText(`请填写${req.label}`)).toBeNull();
  });

  it('填了内容没保存就关：先确认；没动过直接关；Esc 同样', () => {
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<RecordForm def={def} record={null} onClose={onClose} onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const nameInput = screen.getAllByRole('textbox')[0];
    fireEvent.change(nameInput, { target: { value: '某店' } });
    expect(screen.getByText('已填写内容尚未保存')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(confirm).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });
});
