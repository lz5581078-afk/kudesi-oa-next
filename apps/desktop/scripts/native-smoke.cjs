// CI runner only: validates the real Electron clipboard API with a generated image.
const {app,clipboard,nativeImage}=require('electron');
const {writePngClipboard,writeTextClipboard}=require('../src/native.cjs');
app.whenReady().then(async()=>{
 await writeTextClipboard('851148665');
 if(await clipboard.readText()!=='851148665')throw new Error('Clipboard text mismatch');
 console.log('Native clipboard text round-trip passed');
 const image=nativeImage.createFromPath(require('node:path').join(__dirname,'../build/icon.png'));
 await writePngClipboard(image.toPNG());
 const items=await clipboard.read();const item=items.find(i=>i.types.includes('image/png'));
 if(!item)throw new Error('Clipboard PNG missing');
 const blob=await item.getType('image/png');const result=nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
 if(result.isEmpty()||result.getSize().width!==512)throw new Error('Clipboard image mismatch');
 console.log('Native clipboard image round-trip passed');app.exit(0);
}).catch(e=>{console.error(e.message);app.exit(1);});
