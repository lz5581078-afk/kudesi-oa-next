/* Browser-only renderer, intentionally no Node. */
const canvas=document.getElementById('canvas'),ctx=canvas.getContext('2d'),tools=document.getElementById('tools');
const picture=new Image();let selection=null,start=null,mode='rect',history=[],items=[],autoAttach=false,sending=false;
const pos=e=>({x:e.clientX*canvas.width/innerWidth,y:e.clientY*canvas.height/innerHeight});
const box=(a,b)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y)});
function drawItem(c,item){
 const {a,b,color,mode}=item;c.strokeStyle=color;c.fillStyle=color;c.lineWidth=Math.max(3,canvas.width/650);
 if(mode==='text'){c.font=`${Math.max(22,canvas.width/65)}px sans-serif`;c.fillText(item.text,a.x,a.y);return;}
 const r=box(a,b);
 if(mode==='rect')c.strokeRect(r.x,r.y,r.w,r.h);
 if(mode==='arrow'){const t=Math.atan2(b.y-a.y,b.x-a.x),len=22;c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.moveTo(b.x-len*Math.cos(t-.5),b.y-len*Math.sin(t-.5));c.lineTo(b.x,b.y);c.lineTo(b.x-len*Math.cos(t+.5),b.y-len*Math.sin(t+.5));c.stroke();}
 if(mode==='mosaic'){
  // Opaque pixel blocks, never reversible transparency over personal information.
  for(let y=r.y;y<r.y+r.h;y+=16)for(let x=r.x;x<r.x+r.w;x+=16){c.fillStyle=((Math.floor(x/16)+Math.floor(y/16))%2)?'#68747b':'#87939b';c.fillRect(x,y,Math.min(16,r.x+r.w-x),Math.min(16,r.y+r.h-y));}
 }
}
function paint(preview){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(picture,0,0);for(const item of items)drawItem(ctx,item);if(preview)drawItem(ctx,preview);
 const r=selection;ctx.fillStyle='#0008';if(r){ctx.fillRect(0,0,canvas.width,r.y);ctx.fillRect(0,r.y,r.x,r.h);ctx.fillRect(r.x+r.w,r.y,canvas.width-r.x-r.w,r.h);ctx.fillRect(0,r.y+r.h,canvas.width,canvas.height-r.y-r.h);ctx.strokeStyle='#30d2c0';ctx.lineWidth=2;ctx.strokeRect(r.x,r.y,r.w,r.h);}else ctx.fillRect(0,0,canvas.width,canvas.height);}
window.captureEditor.onImage(({image,canAttach,autoAttach:automatic})=>{
 autoAttach=automatic===true;
 if(autoAttach)document.getElementById('hint').textContent='拖动选取区域 · 松开后自动保存到售后 · Esc 取消';
 picture.onload=()=>{canvas.width=picture.width;canvas.height=picture.height;paint();};picture.src=image;document.getElementById('attach').hidden=!canAttach;});
canvas.onpointerdown=e=>{if(e.button!==0)return;start=pos(e);canvas.setPointerCapture(e.pointerId);if(selection&&mode==='text'){const text=document.getElementById('text').value;if(text){history.push([...items]);items.push({mode,a:start,color:document.getElementById('color').value,text});paint();}start=null;}};
canvas.onpointermove=e=>{if(!start)return;const b=pos(e);if(!selection){paint();ctx.strokeStyle='#30d2c0';const r=box(start,b);ctx.strokeRect(r.x,r.y,r.w,r.h);}else paint({a:start,b,mode,color:document.getElementById('color').value});};
canvas.onpointerup=e=>{
 if(!start)return;
 const b=pos(e);
 if(!selection){
  const r=box(start,b);
  if(r.w>5&&r.h>5){
   selection=r;
   if(autoAttach){start=null;void finish('attach');return;}
   tools.hidden=false;
   document.getElementById('hint').textContent='区域已选定，可标注、复制或保存';
  }
 }else{history.push([...items]);items.push({a:start,b,mode,color:document.getElementById('color').value});}
 start=null;
 paint();
};
for(const button of document.querySelectorAll('[data-mode]'))button.onclick=()=>{mode=button.dataset.mode;for(const b of document.querySelectorAll('[data-mode]'))b.classList.toggle('active',b===button);};
document.getElementById('undo').onclick=()=>{if(history.length){items=history.pop();paint();}};
document.getElementById('crop').onclick=()=>{selection=null;items=[];history=[];tools.hidden=true;paint();};
async function finish(action){
 if(sending||(!selection&&action!=='cancel'))return;
 sending=true;
 try{
  let image;
  if(action!=='cancel'){
   const r=selection;
   selection=null;
   paint();
   const out=document.createElement('canvas');
   out.width=Math.round(r.w);
   out.height=Math.round(r.h);
   out.getContext('2d').drawImage(canvas,r.x,r.y,r.w,r.h,0,0,out.width,out.height);
   image=out.toDataURL('image/png');
   selection=r;
   paint();
  }
  await window.captureEditor.finish(action,image);
 }catch(e){
  tools.hidden=false;
  document.getElementById('error').textContent=e.message;
 }finally{sending=false;}
}
for(const button of document.querySelectorAll('[data-action]'))button.onclick=()=>void finish(button.dataset.action);
document.onkeydown=e=>{if(e.key==='Escape')window.captureEditor.finish('cancel');if((e.ctrlKey||e.metaKey)&&e.key==='z')document.getElementById('undo').click();};
