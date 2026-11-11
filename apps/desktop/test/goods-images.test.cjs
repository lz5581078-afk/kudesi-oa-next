const {test}=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {readGoodsImages,readPublicGoodsImage}=require('../src/goods-images.cjs');

test('thumbnail inspection stays in visible product cells and excludes signed or nonpublic URLs',()=>{
 const image=src=>`<img src="${src}">`;
 const dom=new JSDOM(`<table><thead><tr><th>售后单号</th><th>商品信息 展示设置</th><th>备注</th></tr></thead><tbody>
 <tr><td>售后单号：85110001</td><td>${image('https://img.pddpic.com/product.jpg')}${image('https://img.pddpic.com/second.jpg')}</td><td>${image('https://img.pddpic.com/not-a-product.jpg')}</td></tr>
 <tr><td>85110002</td><td>${image('https://img.pddpic.com.evil.test/a.jpg')}${image('https://img.pddpic.com/a.jpg?token=secret')}</td><td></td></tr>
 <tr hidden><td>85110003</td><td>${image('https://img.pddpic.com/hidden.jpg')}</td><td></td></tr>
 <tr><td>85110004</td><td>${image('http://img.pddpic.com/a.jpg')}${image('https://u:p@img.pddpic.com/a.jpg')}</td><td></td></tr>
 </tbody></table>`,{runScripts:'outside-only'});
 Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
 dom.window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
 const result=dom.window.eval(`(${readGoodsImages.toString()})(${readPublicGoodsImage.toString()})`);
 assert.deepEqual(JSON.parse(JSON.stringify(result)),[{afterSaleId:'85110001',images:['https://img.pddpic.com/product.jpg','https://img.pddpic.com/second.jpg']}]);
 dom.window.close();
});
