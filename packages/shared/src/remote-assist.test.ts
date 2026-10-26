import { describe, expect, it } from 'vitest';
import cases from './remote-input.cases.json';
import { createChecker, inputAllowedIn, parseRemoteInput, permissionCatalog, REMOTE_LIMITS, SPECIAL_PERMISSIONS, validateSignal } from './index';

describe('远程协助：输入校验', () => {
  it.each(cases.valid.map((c, i) => [i, c] as const))('合法输入 %i', (_i, c) => {
    expect(parseRemoteInput(c)).not.toBeNull();
  });
  it.each(cases.invalid.map((c, i) => [i, c] as const))('非法输入 %i 被拒绝', (_i, c) => {
    expect(parseRemoteInput(c)).toBeNull();
  });
  it('点击默认左键单击；只观看模式不允许任何输入', () => {
    expect(parseRemoteInput({ t: 'click', id: 'x', x: 0.1, y: 0.1 })).toMatchObject({ button: 'left', count: 1 });
    expect(inputAllowedIn('view')).toBe(false);
    expect(inputAllowedIn('control')).toBe(true);
  });
});

describe('远程协助：信令校验', () => {
  it('方向和类型限定', () => {
    expect(validateSignal('toAgent', 'answer', { sdp: 'v=0' })).toBeNull();
    expect(validateSignal('toAgent', 'offer', { sdp: 'v=0' })).not.toBeNull(); // 网页不能发 offer
    expect(validateSignal('toViewer', 'answer', { sdp: 'v=0' })).not.toBeNull(); // 助手不能发 answer
    expect(validateSignal('toViewer', 'offer', { sdp: 'v=0' })).toBeNull();
    expect(validateSignal('toViewer', 'input', {})).not.toBeNull();
    expect(validateSignal('toAgent', 'join', {})).toBeNull();
    expect(validateSignal('toAgent', 'join', undefined)).toBeNull();
  });
  it('SDP、候选地址、大小限制', () => {
    expect(validateSignal('toViewer', 'offer', {})).not.toBeNull();
    expect(validateSignal('toViewer', 'offer', { sdp: 'x'.repeat(REMOTE_LIMITS.sdpMaxChars + 1) })).not.toBeNull();
    expect(validateSignal('toAgent', 'ice', { candidate: null })).toBeNull();
    expect(validateSignal('toAgent', 'ice', { candidate: 'candidate:1 1 UDP 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 })).toBeNull();
    expect(validateSignal('toAgent', 'ice', { candidate: 123 })).not.toBeNull();
    expect(validateSignal('toAgent', 'ice', { candidate: 'x'.repeat(5000) })).not.toBeNull();
    expect(validateSignal('toAgent', 'ice', 'str')).not.toBeNull();
    expect(validateSignal('toAgent', 'ice', [1])).not.toBeNull();
  });
});

describe('远程协助：权限键', () => {
  it('在权限目录里；没有授权的人没有', () => {
    const keys = permissionCatalog().flatMap((g) => g.items.map((i) => i.key));
    expect(keys).toContain(SPECIAL_PERMISSIONS.financeSessionRemote);
    expect(createChecker({ isCompanyAdmin: false, allow: ['finance.doc-withdrawal.view'], deny: [] })(SPECIAL_PERMISSIONS.financeSessionRemote)).toBe(false);
    expect(createChecker({ isCompanyAdmin: false, allow: [SPECIAL_PERMISSIONS.financeSessionRemote], deny: [] })(SPECIAL_PERMISSIONS.financeSessionRemote)).toBe(true);
  });
});
