/** 24号档案同步沿用档案原编号；48位以上继续新版既有独立基础编码生成兼容。 */
export function archiveBaseCodeIdentity(value: unknown): { code: string; styleCode: string } | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (code.length > 48 || !/^[A-Z0-9+*]+(?:-[A-Z0-9+*]+)*$/.test(code)) return null;
  return { code, styleCode: code };
}
