import { legacySql } from './legacy-store';

describe('旧平台查询的编码与中文名适配', () => {
  it('列表排序和平台搜索同时识别中文名，保留原始投影与绑定参数数量', () => {
    const source = "SELECT s.id,s.platform FROM stores s WHERE s.company_id=? AND s.platform LIKE ? ORDER BY CASE LOWER(TRIM(s.platform)) WHEN '拼多多' THEN 1 ELSE 99 END";
    const result = legacySql(source);
    expect(result).toContain('SELECT s.id,s.platform FROM sm_legacy_stores s');
    expect(result).toContain("WHEN 'pdd' THEN '拼多多'");
    expect(result).toContain("WHEN 'douyin' THEN '抖音'");
    expect(result).toContain("CONCAT_WS(' ', s.platform,");
    expect(result.match(/\?/g)).toHaveLength(2);
  });
  it('不重写字符串和注释中的表达式，也不改变设备平台查询', () => {
    const source = "SELECT 's.platform LIKE ?',\"LOWER(TRIM(s.platform))\",s.platform FROM stores s /* s.platform LIKE ? */ WHERE s.platform LIKE ?";
    const result = legacySql(source);
    expect(result).toContain("'s.platform LIKE ?'");
    expect(result).toContain('\"LOWER(TRIM(s.platform))\"');
    expect(result).toContain('/* s.platform LIKE ? */');
    expect(legacySql('SELECT s.platform FROM session_devices s WHERE s.platform LIKE ? ORDER BY LOWER(TRIM(s.platform))'))
      .toBe('SELECT s.platform FROM sm_legacy_session_devices s WHERE s.platform LIKE ? ORDER BY LOWER(TRIM(s.platform))');
    expect(legacySql("SELECT 'FROM stores s',s.platform FROM session_devices s WHERE s.platform LIKE ?"))
      .toBe("SELECT 'FROM stores s',s.platform FROM sm_legacy_session_devices s WHERE s.platform LIKE ?");
  });
});
