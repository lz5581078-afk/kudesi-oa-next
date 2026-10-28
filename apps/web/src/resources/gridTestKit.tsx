import { fireEvent, screen } from '@testing-library/react';
import { getResourceDef } from '@kudesi/shared';

/** 表格编辑相关页面测试共用：把第 0 行“运营商”改成指定内容（产生一处没保存的修改） */
export async function editCarrier(value: string) {
  const label = getResourceDef('phones')!.fields.find((f) => f.key === 'carrier')!.label;
  const idx = Array.from(document.querySelectorAll('thead th')).findIndex((th) => th.querySelector('.grid-th-label')?.textContent?.startsWith(label)) - 1;
  if (idx < 0) throw new Error('找不到运营商列');
  fireEvent.mouseDown(document.querySelector(`td[data-r="0"][data-c="${idx}"]`)!);
  fireEvent.keyDown(screen.getByRole('application'), { key: 'Enter' });
  const input = screen.getByLabelText(/^编辑/) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByText('1 处修改');
}
