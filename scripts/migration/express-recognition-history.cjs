const type = 'finance-express-recognitions';
const labels = {
  价格表识别: 'price_table',
  加收通知识别: 'surcharge_notice',
  手工创建价格表: 'manual_price',
  手工新增加收: 'manual_surcharge',
};

function recognitionHistory(catalogs) {
  const records = [], exclusions = [], seen = new Set();
  for (const catalog of catalogs) {
    const carriers = typeof catalog.carriers_json === 'string' ? JSON.parse(catalog.carriers_json) : catalog.carriers_json;
    for (const carrier of carriers ?? []) for (const branch of carrier.branches ?? []) for (const version of branch.versions ?? []) {
      for (const row of version.recognitions ?? []) {
        const id = `${version.id ?? '无版本'}:${row.id ?? '无编号'}`;
        const recognitionType = Object.hasOwn(labels, row.recognition_type) ? labels[row.recognition_type] : row.recognition_type;
        const date = typeof row.created_at === 'string' && row.created_at;
        const iso = date && (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date) ? date.replace(' ', 'T') + '+08:00' : date);
        const resultCount = row.result_count == null || row.result_count === '' ? undefined : Number(row.result_count);
        if (!version.id || !row.id || typeof recognitionType !== 'string' || !recognitionType.trim() || !iso || !/(Z|[+-]\d{2}:\d{2})$/.test(iso) || !Number.isFinite(Date.parse(iso))
          || (resultCount !== undefined && (!Number.isSafeInteger(resultCount) || resultCount < 0)) || seen.has(id)) {
          exclusions.push({ type, id, reason: '旧识别记录缺少有效来源编号、版本、类型、时间或结果数，或来源编号重复' });
          continue;
        }
        seen.add(id);
        records.push({ type, id, status: 'recorded', data: {
          label: row.recognition_type,
          versionId: { legacyRef: { type: 'finance-express-versions', id: String(version.id) } },
          recognitionType, createdAtKey: new Date(iso).toISOString(),
          fileName: row.file_name || undefined, modelName: row.model_name || undefined,
          resultStatus: row.status || undefined, resultCount,
        } });
      }
    }
  }
  return { records, exclusions };
}

module.exports = { recognitionHistory };
