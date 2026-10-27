import { describe, expect, it } from 'vitest';
import { ASSET_ACTIONS, ASSET_ACTIONS_BY_STATE, type AssetState } from './asset-flow';

describe('固定资产状态机', () => {
  it('每个状态下列出的动作，都允许从该状态出发；反过来也一样', () => {
    for (const [state, actions] of Object.entries(ASSET_ACTIONS_BY_STATE)) {
      for (const a of actions) expect(ASSET_ACTIONS[a].from).toContain(state as AssetState);
    }
    for (const [name, rule] of Object.entries(ASSET_ACTIONS)) {
      for (const from of rule.from) expect(ASSET_ACTIONS_BY_STATE[from]).toContain(name);
    }
  });
  it('报废是终态；报废、送修、丢失必须填原因；领用和转交必须选使用人', () => {
    expect(ASSET_ACTIONS_BY_STATE.retired).toEqual([]);
    for (const k of ['retire', 'repair', 'lost'] as const) expect(ASSET_ACTIONS[k].needsReason).toBe(true);
    for (const k of ['checkout', 'transfer'] as const) expect(ASSET_ACTIONS[k].needsUser).toBe(true);
  });
});
