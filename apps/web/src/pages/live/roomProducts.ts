/** 房间常播产品按换行分项；历史自由文本保留为原有一项，不按逗号拆分名称。 */
export const roomProductItems = (value?: string) => (value ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
