import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('./ResourcePage', () => ({ ResourcePage: ({ type }: { type: string }) => <div data-testid="page">{type}</div> }));
vi.mock('./LocationBoard', () => ({ LocationBoard: () => <div data-testid="board">看板</div> }));
import { CompanionPage } from './CompanionPage';

describe('房间与档案位置：看板和表格', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* */ } });
  afterEach(cleanup);
  it('默认进看板，可切到表格，选择会记住', () => {
    render(<CompanionPage type="locations" />);
    expect(screen.getByTestId('board')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '表格' }));
    expect(screen.getByTestId('page').textContent).toBe('locations');
    cleanup();
    render(<CompanionPage type="locations" />);
    expect(screen.queryByTestId('board')).toBeNull();
    expect(screen.getByTestId('page').textContent).toBe('locations');
  });
  it('切到“档案项”页签时用档案列表，不显示层级/表格开关', () => {
    render(<CompanionPage type="locations" />);
    fireEvent.click(screen.getByText('档案项'));
    expect(screen.getByTestId('page').textContent).toBe('archives');
    expect(screen.queryByRole('button', { name: '表格' })).toBeNull();
  });
});
