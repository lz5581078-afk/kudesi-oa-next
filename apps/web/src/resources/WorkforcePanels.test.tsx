import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { WorkforceTrialDialog } from './WorkforcePanels';

vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('仅凭姓名登记试播主播', async () => {
  vi.mocked(api).mockResolvedValue({ id: 21, name: '试播小白' });
  const saved = vi.fn();
  render(<WorkforceTrialDialog onClose={vi.fn()} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText('姓名'), { target: { value: ' 试播小白 ' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(api).toHaveBeenCalledWith('/workforce/trial-people', { body: { name: '试播小白' } });
});
