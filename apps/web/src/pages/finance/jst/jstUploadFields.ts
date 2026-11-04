export interface Field { key: string; label: string; required?: boolean; type?: 'number' | 'select' | 'textarea' | 'category'; options?: Array<[string, string]>; placeholder?: string; wide?: boolean }
export const GROUPS: Array<{ title: string; description: string; fields: Field[] }> = [
  { title: '基础信息', description: '带“必填”的字段会同时在前端和后端校验，避免上传资料不完整。', fields: [
    { key: 'skuId', label: '商品编码', required: true, placeholder: '如 SKU001' }, { key: 'styleId', label: '款式编码', required: true, placeholder: '如 STYLE001' },
    { key: 'name', label: '商品名称', required: true, placeholder: '商品完整名称' }, { key: 'shortName', label: '商品简称', required: true },
    { key: 'enabled', label: '商品状态', type: 'select', options: [['1', '启用'], ['0', '备用'], ['-1', '禁用']] },
    { key: 'itemType', label: '商品属性', type: 'select', options: [['成品', '成品'], ['半成品', '半成品'], ['原材料', '原材料'], ['包材', '包材']] },
    { key: 'stockDisabled', label: '库存同步', type: 'select', options: [['0', '允许同步'], ['1', '禁止同步']] },
    { key: 'remark', label: '备注', type: 'textarea', wide: true },
  ] },
  { title: '规格与分类', description: '分类从聚水潭商品类目拉取；颜色及规格多属性可用分号分隔，例如“红色;100g”。', fields: [
    { key: 'propertiesValue', label: '颜色及规格', required: true, placeholder: '如 红色;100g' }, { key: 'categoryName', label: '分类', required: true, type: 'category' },
    { key: 'virtualCategory', label: '虚拟分类' }, { key: 'brand', label: '品牌', required: true, placeholder: '填写品牌名称' }, { key: 'labels', label: '商品标签', placeholder: '多个标签用逗号分隔' },
    { key: 'skuCode', label: '国标码/条码' }, { key: 'otherCode', label: '辅助码' },
  ] },
  { title: '价格与尺寸', description: '价格和重量字段会按数字上传；基本售价会同时按聚水潭兼容字段提交。', fields: [
    { key: 'marketPrice', label: '市场/吊牌价', type: 'number' }, { key: 'salePrice', label: '基本售价', type: 'number' },
    { key: 'costPrice', label: '成本价', required: true, type: 'number' }, { key: 'purchasePrice', label: '采购价', required: true, type: 'number' },
    { key: 'weight', label: '重量', required: true, type: 'number' }, { key: 'length', label: '长', type: 'number' }, { key: 'width', label: '宽', type: 'number' },
    { key: 'height', label: '高', type: 'number' }, { key: 'volume', label: '体积', type: 'number' }, { key: 'unit', label: '单位', required: true, placeholder: '如 个、斤、袋' },
  ] },
  { title: '供应商与图片', description: '供应商 ID 不建议手填；优先使用供应商名称、供应商商品编码和款式编码。', fields: [
    { key: 'supplierName', label: '供应商名称' }, { key: 'supplierSkuId', label: '供应商商品编码' }, { key: 'supplierStyleId', label: '供应商款式编码' },
    { key: 'pic', label: '图片 URL' }, { key: 'picBig', label: '大图 URL' }, { key: 'productionLicence', label: '生产许可证' },
    { key: 'productionBatchFormat', label: '生产批次格式' }, { key: 'shelfLife', label: '保质期天数', type: 'number' },
  ] },
  { title: '备用字段', description: '聚水潭支持其他价格 1-5、其他属性 1-5，字段名可在聚水潭里自定义。', fields: [
    ...[1, 2, 3, 4, 5].map((n) => ({ key: `otherPrice${n}`, label: `其他价格${n}`, type: 'number' as const })),
    ...[1, 2, 3, 4, 5].map((n) => ({ key: `other${n}`, label: `其他属性${n}` })),
  ] },
];
export const REQUIRED = GROUPS.flatMap((g) => g.fields).filter((f) => f.required);
export const EMPTY: Record<string, string> = { enabled: '1', itemType: '成品', stockDisabled: '0' };

export const COVERAGE = [
  ['商品资料', '商品编码、款式编码、商品名称、简称、颜色及规格、图片、品牌、国标码、辅助码、分类、虚拟分类、标签、备注、状态、库存同步、商品属性、重量、长宽高、体积、单位、供应商名称、供应商商品/款式编码、市场价、基本售价、成本价、采购价、其他价格/属性', '基本可通过普通商品资料上传 API 覆盖'],
  ['商品库存', '安全库存下限/上限、安全库存天数、虚拟库存数', '不属于普通商品资料上传接口；后续应走库存/商品库存类接口'],
  ['仓位库容', '主仓位、库容上下限、溢出数量、标准装箱数量、标准装箱体积', '不属于普通商品资料上传接口；后续应走仓位/库容相关接口'],
  ['全字段导入模板', '订单留言备注、是否启用序列号、保价等扩展项', '部分字段可能有 API 字段，但需要继续逐项验证；第一版先不强推'],
];
