import { DUPLICATE_CATEGORY_REASON, projectUploadCategories, uploadCategoryProblem } from './jst-upload-categories';
import type { RemoteCategory } from '../outbox/outbox.service';
const category = (id: string, name: string, parentId = '0', enable = true): RemoteCategory => ({ id, name, parentId, enable, sort: null });
describe('远端上传分类可用性投影', () => {
  it('同名叶即使完整路径不同仍禁用；唯一启用叶及原唯一叶名/路径后缀输入继续有效', () => {
    const options = projectUploadCategories([category('a', '甲'), category('b', '乙'), category('a1', '苹果', 'a'), category('b1', '苹果', 'b'), category('ok', '梨', 'a')]);
    expect(options.filter(option => option.value.endsWith('/苹果')).map(option => [option.disabled, option.reason])).toEqual([[true, DUPLICATE_CATEGORY_REASON], [true, DUPLICATE_CATEGORY_REASON]]);
    expect(uploadCategoryProblem(options, '甲/苹果')).toBe(DUPLICATE_CATEGORY_REASON);
    expect(uploadCategoryProblem(options, '苹果')).toBe(DUPLICATE_CATEGORY_REASON);
    expect(uploadCategoryProblem(options, '甲/梨')).toBeNull(); expect(uploadCategoryProblem(options, '梨')).toBeNull();
    expect(options.find(option => option.value === '甲')?.reason).toMatch(/末级/);
  });
  it('完整父链、祖先启用、末级及ID唯一均须满足，其他正常分支不被坏资料拖掉', () => {
    const options = projectUploadCategories([category('root', '根'), category('ok', '正常', 'root'), category('off', '停用', '0', false), category('child', '下级', 'off'), category('orphan', '孤儿', 'missing'), category('x', '循环甲', 'y'), category('y', '循环乙', 'x'), category('dup', '重复ID甲'), category('dup', '重复ID乙')]);
    expect(options.find(option => option.value === '根/正常')).toMatchObject({ disabled: false });
    expect(options.find(option => option.value === '停用/下级')?.reason).toMatch(/上级已停用/);
    expect(options.find(option => option.value === '孤儿')?.reason).toMatch(/父级缺失/);
    expect(options.filter(option => option.label.includes('循环')).every(option => option.disabled)).toBe(true);
    expect(options.filter(option => option.label.includes('重复ID')).every(option => option.disabled)).toBe(true);
    expect(uploadCategoryProblem(options, '伪造分类')).toMatch(/已失效/);
  });
  it('与现有sender一致：同名启用父节点也会造成歧义，停用同名节点不改变唯一叶成功路径', () => {
    const ambiguous = projectUploadCategories([category('p', '苹果'), category('sub', '子项', 'p'), category('other', '其他'), category('leaf', '苹果', 'other')]);
    expect(uploadCategoryProblem(ambiguous, '其他/苹果')).toBe(DUPLICATE_CATEGORY_REASON);
    const valid = projectUploadCategories([category('off', '苹果', '0', false), category('root', '水果'), category('leaf', '苹果', 'root')]);
    expect(uploadCategoryProblem(valid, '水果/苹果')).toBeNull();
  });
});
