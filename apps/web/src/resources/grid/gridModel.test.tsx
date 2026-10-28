import { describe, expect, it } from 'vitest';
import { getResourceDef } from '@kudesi/shared';
import type { ResourceDto } from '../api';
import { parseTsv, toTsv } from './clipboard';
import {
  applyChanges, applyResponse, buildColumns, buildRequest, chunkRequest, fillChanges, fillDownChanges, historyInit, historyPush, historyRedo, historyUndo,
  isChanged, rowFromDto, summarize, textToChange, toggleDelete,
} from './gridModel';

const def = getResourceDef('software')!;
const fields = ['name', 'account', 'renewAt', 'annualFee', 'storeId', 'password'].map((k) => def.fields.find((f) => f.key === k)!);
const all = () => true;
const cols = buildColumns(def, fields, all, true);
const dto = (id: number, data: Record<string, unknown>): ResourceDto => ({ id, type: 'software', title: String(data.name), status: 'normal', statusReason: null, data, secretConfigured: {}, refLabels: {}, files: {}, createdAt: '', updatedAt: '', version: `v${id}` });
const rows0 = () => [rowFromDto(dto(1, { name: 'A', account: 'a' })), rowFromDto(dto(2, { name: 'B', account: 'b' }))];

describe('剪贴板（Excel/飞书 TSV）', () => {
  it('多行多列、带引号和换行的单元格', () => {
    expect(parseTsv('a\tb\n1\t2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseTsv('"x\ny"\t"he said ""hi"""\r\nz\t')).toEqual([['x\ny', 'he said "hi"'], ['z', '']]);
    expect(toTsv([['a', 'b\tc'], ['d"e', 'f']])).toBe('a\t"b\tc"\n"d""e"\tf');
    expect(parseTsv(toTsv([['x\ny', 'q"']]))).toEqual([['x\ny', 'q"']]);
  });
});

describe('网格模型', () => {
  it('列：统计/系统列、密码按权限；状态列只读', () => {
    expect(cols.find((c) => c.key === 'password')?.editable).toBe(true);
    expect(buildColumns(def, fields, all, false).find((c) => c.key === 'password')?.editable).toBe(false);
    expect(cols.find((c) => c.key === '$status')?.editable).toBe(false);
  });

  it('改单元格只产生差异；改回原值就不算改动', () => {
    const seq = { n: 0 };
    const r1 = applyChanges(rows0(), cols, [{ row: 0, key: 'account', value: 'x' }], seq);
    expect(isChanged(r1[0], cols.find((c) => c.key === 'account')!)).toBe(true);
    expect(summarize(r1, cols).total).toBe(1);
    const r2 = applyChanges(r1, cols, [{ row: 0, key: 'account', value: 'a' }], seq);
    expect(summarize(r2, cols).total).toBe(0);
  });

  it('底部空行输入=新增；整行没填不算；格式不对的内容留在格子里并阻止保存', async () => {
    const seq = { n: 0 };
    const r = applyChanges(rows0(), cols, [{ row: 2, key: 'name', value: '新' }, { row: 3, key: 'account', value: 'z' }], seq);
    expect(r).toHaveLength(4);
    expect(r[2].isNew).toBe(true);
    expect(summarize(r, cols).created).toBe(2);
    const bad = await textToChange(cols.find((c) => c.key === 'renewAt')!, r[0], 0, '明天', {});
    expect(bad.invalid?.error).toContain('日期');
    const r2 = applyChanges(r, cols, [bad], seq);
    expect(summarize(r2, cols).invalid).toBe(1);
    const ok = await textToChange(cols.find((c) => c.key === 'annualFee')!, r2[0], 0, '12.5', {});
    expect(ok.value).toBe(1250);
  });

  it('保存请求：只带改动的字段、清空=null、新增带全部填写的值、待删除走归档；密码只在填了时提交', () => {
    const seq = { n: 0 };
    let r = applyChanges(rows0(), cols, [{ row: 0, key: 'account', value: null }, { row: 1, key: 'password', value: 'pw' }, { row: 2, key: 'name', value: 'N' }], seq);
    r = toggleDelete(r, [1]).map((x) => x);
    const req = buildRequest(r, cols, '作废');
    expect(req.updates).toEqual([{ id: 1, version: 'v1', data: { account: null } }]);
    expect(req.creates).toEqual([{ clientId: 'new-1', data: { name: 'N' } }]);
    expect(req.archives).toEqual([{ id: 2, version: 'v2', reason: '作废' }]);
  });

  it('保存结果合并：成功的换成服务端最新并清掉标记，失败的留着标红，归档成功的移除', () => {
    const seq = { n: 0 };
    let r = applyChanges(rows0(), cols, [{ row: 0, key: 'account', value: 'x' }, { row: 1, key: 'account', value: 'y' }, { row: 2, key: 'name', value: 'N' }], seq);
    r = applyResponse(r, { saved: 1, failed: 2, results: [
      { kind: 'update', id: 1, ok: true, row: dto(1, { name: 'A', account: 'x' }) },
      { kind: 'update', id: 2, ok: false, code: 'conflict', message: '刚被别人修改过' },
      { kind: 'create', clientId: 'new-1', ok: false, code: 'invalid', message: '账号不能为空' },
    ] });
    expect(r[0].version).toBe('v1');
    expect(isChanged(r[0], cols.find((c) => c.key === 'account')!)).toBe(false);
    expect(r[1].error?.code).toBe('conflict');
    expect(r[1].data.account).toBe('y');
    expect(r[2].error?.message).toBe('账号不能为空');
    const gone = applyResponse(toggleDelete(rows0(), [0]), { saved: 1, failed: 0, results: [{ kind: 'archive', id: 1, ok: true }] });
    expect(gone.map((x) => x.id)).toEqual([2]);
    const created = applyResponse(applyChanges([], cols, [{ row: 0, key: 'name', value: 'N' }], { n: 0 }), { saved: 1, failed: 0, results: [{ kind: 'create', clientId: 'new-1', ok: true, row: dto(9, { name: 'N', account: 'q' }) }] });
    expect(created[0]).toMatchObject({ id: 9, isNew: false, key: 'new-1' });
  });

  it('撤销/重做只在未保存的改动里', () => {
    const seq = { n: 0 };
    let h = historyInit(rows0());
    h = historyPush(h, applyChanges(h.rows, cols, [{ row: 0, key: 'account', value: '1' }], seq));
    h = historyPush(h, applyChanges(h.rows, cols, [{ row: 0, key: 'account', value: '2' }], seq));
    expect(h.rows[0].data.account).toBe('2');
    h = historyUndo(h);
    expect(h.rows[0].data.account).toBe('1');
    h = historyUndo(h);
    h = historyUndo(h);
    expect(h.rows[0].data.account).toBe('a');
    h = historyRedo(h);
    expect(h.rows[0].data.account).toBe('1');
  });

  it('向下填充：Ctrl+D 抄第一行；拖拽按多行源循环', () => {
    const seq = { n: 0 };
    const base = applyChanges(rows0(), cols, [{ row: 2, key: 'name', value: 'C' }, { row: 3, key: 'name', value: 'D' }], seq);
    const name = cols.findIndex((c) => c.key === 'name');
    const down = applyChanges(base, cols, fillDownChanges(base, cols, { r1: 0, r2: 3, c1: name, c2: name }), seq);
    expect(down.map((r) => r.data.name)).toEqual(['A', 'A', 'A', 'A']);
    const drag = applyChanges(base, cols, fillChanges(base, cols, { r1: 0, r2: 1, c1: name, c2: name }, 3), seq);
    expect(drag.map((r) => r.data.name)).toEqual(['A', 'B', 'A', 'B']);
  });

  it('分批：每批不超过上限', () => {
    const req = { updates: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, data: {} })), creates: Array.from({ length: 3 }, (_, i) => ({ clientId: `c${i}`, data: {} })) };
    const parts = chunkRequest(req, 3);
    expect(parts.map((p) => (p.updates?.length ?? 0) + (p.creates?.length ?? 0))).toEqual([3, 3, 2]);
  });
});
