// Generate packaged native routes from the shared navigation registry; never maintain a second route definition.
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../../packages/shared/src/navigation.ts'),'utf8');
const block=source.match(/export const DESKTOP_AFTER_SALES_ROUTES\s*=\s*\{([\s\S]*?)\}\s*as const;/)?.[1];
if(!block)throw new Error('Shared desktop navigation registry missing');
const routes=Object.fromEntries([...block.matchAll(/(\w+):\s*'([^']+)'/g)].map(([,key,value])=>[key,value]));
if(!routes.collector||!routes.shared||Object.values(routes).some(v=>!/^\/[a-z/:_-]+$/.test(v)))throw new Error('Invalid shared desktop navigation');
fs.writeFileSync(path.join(__dirname,'../build/navigation.json'),JSON.stringify(routes,null,2)+'\n');
