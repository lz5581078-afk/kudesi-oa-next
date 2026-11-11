'use strict';

// Public product images only. No profile, cookies or signed URLs.
function readPublicGoodsImage(image) {
  for(const value of [image.currentSrc,image.src,image.getAttribute('data-full-img')]){
    if(!value)continue;
    try{
      const url=new URL(value);
      if(url.protocol==='https:'&&url.hostname==='img.pddpic.com'&&!url.username&&!url.password&&!url.port&&
        url.href.length<=2048&&!/token|sign|auth|password|cookie/i.test(url.search))return url.href;
    }catch{/* Try the thumbnail when the original is unavailable. */}
  }
  return '';
}
function readGoodsImages(readImage) {
  const text=e=>String(e?.innerText||'').trim();
  const visible=e=>!!e?.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[hidden],[aria-hidden="true"]');
  const headings=table=>[...(table.tHead?.querySelectorAll('th,td')||[])].map(e=>text(e).split('\n')[0].replace(/^商品信息.*$/,'商品信息'));
  const tables=[...document.querySelectorAll('table')].filter(t=>visible(t)&&!t.closest('.ant-modal,.ant-popover,[role="dialog"]'));
  const result=[];
  for(const table of tables){
    const group=table.closest('.ant-table,.ant-table-container')||table.parentElement?.parentElement;
    const headers=headings(table).includes('售后单号')?headings(table):[...(group?.querySelectorAll('table')||[])].map(headings).find(h=>h.includes('售后单号')&&h.includes('商品信息'));
    if(!headers)continue;
    const idIndex=headers.indexOf('售后单号'),goodsIndex=headers.indexOf('商品信息');
    if(idIndex<0||goodsIndex<0)continue;
    for(const row of [...table.tBodies].flatMap(body=>[...body.rows])){
      if(!visible(row)||row.cells.length!==headers.length)continue;
      const afterSaleId=text(row.cells[idIndex]).match(/^(?:售后单号\s*[:：]?\s*)?(\d{4,40})$/)?.[1];
      if(!afterSaleId)continue;
      const images=[...row.cells[goodsIndex].querySelectorAll('img')].filter(visible).slice(0,2).map(readImage);
      if(images.some(Boolean))result.push({afterSaleId,images});
    }
  }
  return result;
}

module.exports={readGoodsImages,readPublicGoodsImage};
