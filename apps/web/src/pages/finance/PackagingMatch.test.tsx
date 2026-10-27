import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackagingMatchPage } from './DataToolPages';
import { financeApi } from './financeApi';

vi.mock('./financeApi', async (orig) => ({ ...(await orig<typeof import('./financeApi')>()), financeApi: { packagingMatch: vi.fn() } }));
vi.mock('./common', async (orig) => ({ ...(await orig<typeof import('./common')>()), SearchPick: () => <span /> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('包装方案匹配试算', () => {
  it('命中后可复制匹配结果（方案 + 每行包装）', async () => {
    vi.mocked(financeApi.packagingMatch).mockResolvedValue({
      selected: { scheme: { id: 1, code: 'BZ-1', name: '礼盒方案', usageScene: 'x' }, lines: [{ componentName: '大礼盒', qty: 1, lossRate: 2, costTreatment: 'include', costBucket: 'package' }] },
      matches: [], ambiguous: false, issues: [],
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PackagingMatchPage />);
    fireEvent.click(screen.getByRole('button', { name: '试算' }));
    fireEvent.click(await screen.findByRole('button', { name: '复制匹配结果' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0][0]);
    expect(text).toContain('命中方案：礼盒方案（BZ-1）');
    expect(text).toContain('大礼盒');
  });
});
