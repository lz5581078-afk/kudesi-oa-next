/** 打印当前开单页（管家婆 Ctrl+F9）：把单据内容排成一张干净的纸，在新窗口里打印；不入库，保存后的单据请在详情里打印。 */
export interface PrintData {
  title: string;
  head: Array<[string, string]>;
  columns: string[];
  rows: string[][];
  totals: Array<[string, string]>;
  memo?: string;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function buildPrintHtml(d: PrintData): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>
body{font:13px/1.6 "PingFang SC","Microsoft YaHei",sans-serif;color:#111;margin:24px}h1{font-size:20px;text-align:center;margin:0 0 12px}
.head{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 16px;margin-bottom:10px}.head span{color:#555}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #888;padding:4px 8px;text-align:left}td.n{text-align:right}
.tot{display:flex;justify-content:flex-end;gap:24px;margin-top:10px}.memo{margin-top:8px;color:#333}.sign{display:flex;justify-content:space-between;margin-top:32px;color:#555}
</style></head><body><h1>${esc(d.title)}</h1><div class="head">${d.head.map(([k, v]) => `<div><span>${esc(k)}：</span>${esc(v || '—')}</div>`).join('')}</div>
<table><thead><tr>${d.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${d.rows.map((r) => `<tr>${r.map((c, i) => `<td${i > 0 && /^[¥\d.,-]+$/.test(c) ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
<div class="tot">${d.totals.map(([k, v]) => `<div>${esc(k)}：<b>${esc(v)}</b></div>`).join('')}</div>${d.memo ? `<div class="memo">备注：${esc(d.memo)}</div>` : ''}
<div class="sign"><span>制单：</span><span>审核：</span><span>经办：</span></div></body></html>`;
}

export function printSlip(d: PrintData): boolean {
  const w = window.open('', '_blank', 'noopener=no,width=900,height=700');
  if (!w) return false;
  w.document.write(buildPrintHtml(d));
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* 用户可手动打印 */ } }, 200);
  return true;
}
