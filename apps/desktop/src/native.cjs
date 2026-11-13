'use strict';
const {clipboard,ClipboardItem}=require('electron');
/** @param {Buffer} bytes */
async function writePngClipboard(bytes) {
  await clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(bytes)],{type:'image/png'})})]);
}
async function writeTextClipboard(text) {
  if(typeof text!=='string'||text.length>8000)throw new Error('复制文本无效');
  await clipboard.writeText(text);
  return true;
}
module.exports={writePngClipboard,writeTextClipboard};
