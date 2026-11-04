/** 单位使用逐字符身份，避免数据库宽松排序规则合并不同自由单位。
 * 新分录直接取快照；旧分录只采用同公司、同单据、同商品且全部一致的历史明细单位。 */
export const INVENTORY_UNIT_SQL = `CAST(COALESCE(NULLIF(TRIM(e.unit), ''), (
  SELECT CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(NULLIF(TRIM(fl.unit), ''))
    AND COUNT(DISTINCT CAST(NULLIF(TRIM(fl.unit), '') AS BINARY)) = 1 THEN MIN(TRIM(fl.unit)) ELSE NULL END
  FROM finance_document_lines fl
  WHERE fl.company_id=e.company_id AND fl.document_id=e.document_id AND fl.product_id=e.account_id
), '') AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_bin`;
