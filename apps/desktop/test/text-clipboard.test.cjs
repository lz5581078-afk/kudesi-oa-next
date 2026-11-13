const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('native text copy validates input and awaits the OS clipboard result',async()=>{
 const copied=[];
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/native.cjs'),'utf8'),{
  module,require:()=>({clipboard:{writeText:async text=>{if(text==='fail')throw new Error('clipboard busy');copied.push(text);}}}),
 });
 const copy=module.exports.writeTextClipboard;
 assert.equal(await copy('851148665'),true);
 assert.deepEqual(copied,['851148665']);
 await assert.rejects(copy({text:'unexpected'}),/复制文本无效/);
 await assert.rejects(copy('a'.repeat(8001)),/复制文本无效/);
 await assert.rejects(copy('fail'),/clipboard busy/);
});
