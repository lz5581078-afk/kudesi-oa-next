import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../../api/client';
import { BankFundPage } from './BankFundPage';

describe('资金概况', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('显示说明、在用账户数，最近登记的账号可复制', async () => {
    vi.spyOn(client, 'api').mockResolvedValue({
      totalCents: 100000, companyCents: 60000, storeCents: 40000, abnormalCount: 1,
      kinds: [{ kind: 'company_public', count: 3, abnormalCount: 1, inactiveCount: 1, balanceCents: 60000 }],
      recent: [{ id: 1, kind: 'company_public', title: '甲公司', status: 'normal', bank: '工行', owner: null, accountNo: '6222000011112222', balanceCents: 100 }],
    } as never);
    render(<MemoryRouter><BankFundPage /></MemoryRouter>);
    expect(await screen.findByText('2 个在用账户')).toBeTruthy();
    expect(screen.getByText('点下方类型查看')).toBeTruthy();
    expect(screen.getByLabelText('复制账号')).toBeTruthy();
    expect(screen.getByText(/余额不含已停用和已归档账户/)).toBeTruthy();
  });
});
