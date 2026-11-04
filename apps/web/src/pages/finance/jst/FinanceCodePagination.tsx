export function FinanceCodePagination({page,total,pageSize,onPage}:{page:number;total:number;pageSize:number;onPage:(page:number)=>void}) {
 const pages=Math.max(1,Math.ceil(total/pageSize));
 return <><span>共 {total} 条</span><span>第 {page}/{pages} 页</span><button type="button" className="secondary-button" disabled={page<=1} onClick={()=>onPage(page-1)}>上一页</button><button type="button" className="secondary-button" disabled={page>=pages} onClick={()=>onPage(page+1)}>下一页</button></>;
}
