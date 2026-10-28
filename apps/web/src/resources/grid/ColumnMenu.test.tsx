import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getResourceDef, type ColFilter, type ColFilterKind, type FieldDef } from '@kudesi/shared';
import { ColumnMenu, type ColumnMenuProps } from './ColumnMenu';

const f = (over: Partial<FieldDef>): FieldDef => ({ key: 'k', label: '列', type: 'text', group: 'g', ...over });
function setup(kind: ColFilterKind, field: FieldDef | null, over: Partial<ColumnMenuProps> = {}) {
  const onApply = vi.fn();
  const onSort = vi.fn();
  render(<ColumnMenu label="列" field={field} kind={kind} current={[]} labels={{}} sortable sortDir={null} locked={false} today="2026-03-15" onApply={onApply} onSort={onSort} {...over} />);
  fireEvent.click(screen.getByRole('button', { name: /列列筛选/ }));
  return { onApply, onSort };
}
const applied = (m: ReturnType<typeof vi.fn>) => m.mock.calls[0][0] as ColFilter;
const opLabels = () => Array.from((screen.getByLabelText('筛选方式') as HTMLSelectElement).options).map((o) => o.textContent);

afterEach(() => cleanup());

describe('列头菜单：各类型的筛选方式', () => {
  it('文本：包含 / 等于 / 不等于 / 开头是 / 为空 / 不为空', () => {
    const { onApply } = setup('text', f({ type: 'text' }));
    expect(opLabels()).toEqual(['包含', '等于', '不等于', '开头是', '为空', '不为空']);
    fireEvent.change(screen.getByLabelText('值'), { target: { value: ' 联通 ' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(applied(onApply)).toEqual({ key: 'k', op: 'contains', value: '联通' });
  });

  it('文本：为空 / 不为空不需要填值；空内容不能应用', () => {
    const { onApply } = setup('text', f({}));
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(screen.getByRole('alert').textContent).toMatch(/请填写/);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('筛选方式'), { target: { value: 'empty' } });
    expect(screen.queryByLabelText('值')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(applied(onApply)).toEqual({ key: 'k', op: 'empty' });
  });

  it('手机号：只收数字', () => {
    const { onApply } = setup('phone', f({ type: 'phone' }));
    expect(opLabels()).toEqual(['包含', '等于', '开头是', '为空', '不为空']);
    fireEvent.change(screen.getByLabelText('值'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('值'), { target: { value: '1380' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(applied(onApply)).toMatchObject({ op: 'contains', value: '1380' });
  });

  it('数字：等于 / 大于 / 小于 / 区间；区间起点不能大于终点', () => {
    const { onApply } = setup('number', f({ type: 'number' }));
    expect(opLabels()).toEqual(['等于', '大于', '小于', '区间', '为空', '不为空']);
    fireEvent.change(screen.getByLabelText('筛选方式'), { target: { value: 'between' } });
    fireEvent.change(screen.getByLabelText('起点'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('终点'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(screen.getByRole('alert').textContent).toMatch(/起点/);
    fireEvent.change(screen.getByLabelText('终点'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(applied(onApply)).toEqual({ key: 'k', op: 'between', value: '9', value2: '20' });
  });

  it('金额：输入元，按存储的分提交；回显时换回元', () => {
    const { onApply } = setup('number', f({ type: 'money' }));
    fireEvent.change(screen.getByLabelText('筛选方式'), { target: { value: 'gt' } });
    fireEvent.change(screen.getByLabelText('值'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(applied(onApply)).toEqual({ key: 'k', op: 'gt', value: '1250' });
    cleanup();
    setup('number', f({ type: 'money' }), { current: [{ key: 'k', op: 'gt', value: '1250' }] });
    expect((screen.getByLabelText('值') as HTMLInputElement).value).toBe('12.5');
  });

  it('日期：快捷项（今天 / 近 7 天 / 本月 / 上月）直接换成区间，另有区间 / 早于 / 晚于 / 为空', () => {
    const { onApply } = setup('date', f({ type: 'date' }));
    expect(opLabels()).toEqual(['区间', '等于', '早于', '晚于', '为空', '不为空']);
    for (const [name, from, to] of [['今天', '2026-03-15', '2026-03-15'], ['近 7 天', '2026-03-09', '2026-03-15'], ['本月', '2026-03-01', '2026-03-31'], ['上月', '2026-02-01', '2026-02-28']]) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect((screen.getByLabelText('起点') as HTMLInputElement).value).toBe(from);
      expect((screen.getByLabelText('终点') as HTMLInputElement).value).toBe(to);
    }
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(applied(onApply)).toEqual({ key: 'k', op: 'between', value: '2026-02-01', value2: '2026-02-28' });
  });

  it('日期：晚于 / 日期不合法不能应用', () => {
    const { onApply } = setup('date', f({ type: 'date' }));
    fireEvent.change(screen.getByLabelText('筛选方式'), { target: { value: 'after' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('值'), { target: { value: '2026-01-02' } });
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(applied(onApply)).toEqual({ key: 'k', op: 'after', value: '2026-01-02' });
  });

  it('单选：多选值勾选，带数量', async () => {
    const options = [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }, { value: 'c', label: '丙' }];
    const { onApply } = setup('select', f({ type: 'select' }), { options, loadFacets: async () => [{ value: 'a', count: 7 }, { value: 'b', count: 2 }] });
    expect(await screen.findByText('7')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /甲/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /丙/ }));
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(applied(onApply)).toEqual({ key: 'k', op: 'in', values: ['a', 'c'] });
  });

  it('单选：一个值都不勾不能应用；已选的回显勾选', () => {
    const options = [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }];
    const { onApply } = setup('select', f({ type: 'select' }), { options, current: [{ key: 'k', op: 'in', values: ['b'] }] });
    expect((screen.getByRole('checkbox', { name: /乙/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /乙/ }));
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('布尔：全部 / 是 / 否，点一下即生效', () => {
    const { onApply } = setup('bool', f({ type: 'bool' }));
    fireEvent.click(screen.getByRole('radio', { name: '是' }));
    expect(onApply).toHaveBeenCalledWith({ key: 'k', op: 'yes' }, {});
    cleanup();
    const second = setup('bool', f({ type: 'bool' }), { current: [{ key: 'k', op: 'no' }] });
    fireEvent.click(screen.getByRole('radio', { name: '全部' }));
    expect(second.onApply).toHaveBeenCalledWith(null, {});
  });

  it('引用：按名称搜索，多选，已选以标签显示并带回名称', async () => {
    const searchRef = vi.fn(async (kw: string) => [{ value: '5', label: `张三${kw}` }, { value: '6', label: '李四' }]);
    const { onApply } = setup('ref', f({ type: 'ref', ref: 'user' }), { searchRef });
    fireEvent.click(await screen.findByRole('checkbox', { name: /张三/ }));
    fireEvent.change(screen.getByLabelText('按名称搜索'), { target: { value: '甲' } });
    await waitFor(() => expect(searchRef).toHaveBeenCalledWith('甲'));
    fireEvent.click(await screen.findByRole('checkbox', { name: /李四/ }));
    expect(screen.getByLabelText('已选').textContent).toContain('张三');
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(onApply.mock.calls[0][0]).toEqual({ key: 'k', op: 'in', values: ['5', '6'] });
    expect(onApply.mock.calls[0][1]).toEqual({ '5': '张三', '6': '李四' });
  });

  it('引用：没有权限查看候选时给出提示', async () => {
    setup('ref', f({ type: 'ref', ref: 'stores' }), { searchRef: async () => { throw new Error('403'); } });
    expect(await screen.findByText(/没有权限查看候选/)).toBeTruthy();
  });

  it('证件号 / 银行卡 / 密码：只能选已填 / 未填，并说明原因', () => {
    const { onApply } = setup('presence', f({ type: 'sensitive' }));
    expect(screen.getByText(/不能按内容筛选/)).toBeTruthy();
    expect(screen.queryByLabelText('值')).toBeNull();
    expect(screen.queryByLabelText('筛选方式')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '未填' }));
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(applied(onApply)).toEqual({ key: 'k', op: 'empty' });
  });

  it('状态列：多选状态', () => {
    const def = getResourceDef('phones')!;
    const { onApply } = setup('status', null, { options: def.statuses.map((s) => ({ value: s.value, label: s.label })) });
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(def.statuses[0].label) }));
    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(applied(onApply)).toEqual({ key: '$status', op: 'in', values: [def.statuses[0].value] });
  });
});

describe('列头菜单：入口状态、排序、清除、锁定', () => {
  it('已筛选的列高亮并显示条件数；多选显示选了几项', () => {
    render(<ColumnMenu label="类型" field={f({ type: 'select' })} kind="select" current={[{ key: 'k', op: 'in', values: ['a', 'b', 'c'] }]} labels={{}} sortable={false} sortDir={null} locked={false} today="2026-03-15" onApply={vi.fn()} onSort={vi.fn()} />);
    const b = screen.getByRole('button', { name: /类型列筛选，已有 3 个条件/ });
    expect(b.className).toContain('on');
    expect(b.textContent).toBe('3');
  });

  it('菜单里有排序：升序 / 降序，再点同一项取消', () => {
    const { onSort } = setup('text', f({}));
    fireEvent.click(screen.getByRole('button', { name: '升序 ↑' }));
    expect(onSort).toHaveBeenCalledWith('asc');
    cleanup();
    const again = setup('text', f({}), { sortDir: 'desc' });
    fireEvent.click(screen.getByRole('button', { name: '降序 ↓' }));
    expect(again.onSort).toHaveBeenCalledWith(null);
  });

  it('清除这一列', () => {
    const { onApply } = setup('text', f({}), { current: [{ key: 'k', op: 'contains', value: '甲' }] });
    fireEvent.click(screen.getByRole('button', { name: '清除这一列' }));
    expect(onApply).toHaveBeenCalledWith(null, {});
  });

  it('有未保存修改（locked）时入口不可点并说明原因', () => {
    render(<ColumnMenu label="列" field={f({})} kind="text" current={[]} labels={{}} sortable sortDir={null} locked today="2026-03-15" onApply={vi.fn()} onSort={vi.fn()} />);
    const b = screen.getByRole('button', { name: /列列筛选/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toMatch(/请先保存或放弃/);
  });

  it('Esc 关闭浮层', () => {
    setup('text', f({}));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
