/** 多条搜索按行取完整短语；忽略大小写去重，不拆开短语内部空格。 */
export function querySearchTerms(value: string) {
  const terms = new Map<string, string>();
  for (const line of value.split(/[\r\n]+/)) {
    const term = line.trim();
    if (term && !terms.has(term.toLocaleLowerCase())) terms.set(term.toLocaleLowerCase(), term);
  }
  return [...terms.values()];
}
