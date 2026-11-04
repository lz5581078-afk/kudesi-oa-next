'use strict';
const {clipboard,ClipboardItem}=require('electron');
/** @param {Buffer} bytes */
async function writePngClipboard(bytes) {
  await clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(bytes)],{type:'image/png'})})]);
}
module.exports={writePngClipboard};
