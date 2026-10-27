import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { permissions: { isCompanyAdmin: true, allow: [], deny: [] } } }) }));
vi.mock('./ResourcePage', () => ({ ResourcePage: ({ type }: { type: string }) => <div data-testid="page">{type}</div> }));
import { CompanionPage } from './CompanionPage';

describe('账号与服务页：软件订阅是同页页签', () => {
  afterEach(cleanup);
  it('备忘页带「软件订阅」页签，点开显示软件资料', () => {
    render(<CompanionPage type="memos" />);
    expect(screen.getByTestId('page').textContent).toBe('memos');
    fireEvent.click(screen.getByText('软件订阅'));
    expect(screen.getByTestId('page').textContent).toBe('software');
  });
});
