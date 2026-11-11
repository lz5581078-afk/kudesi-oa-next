// Generate packaged native routes from the shared navigation registry; never maintain a second route definition.
const fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../../packages/shared/src/navigation.ts'),'utf8');
const block=source.match(/export const DESKTOP_AFTER_SALES_ROUTES\s*=\s*\{([\s\S]*?)\}\s*as const;/)?.[1];
if(!block)throw new Error('Shared desktop navigation registry missing');
const routes=Object.fromEntries([...block.matchAll(/(\w+):\s*'([^']+)'/g)].map(([,key,value])=>[key,value]));
if(!routes.workspace||!routes.collector||!routes.shared||Object.values(routes).some(v=>!/^\/[a-z/:_-]+$/.test(v)))throw new Error('Invalid shared desktop navigation');
const launch=source.match(/export const DESKTOP_AFTER_SALES_LINK\s*=\s*'([a-z][a-z-]*:\/\/[a-z-]+)'/)?.[1];
if(!launch)throw new Error('Invalid shared desktop launch link');
const afterSalesSource=fs.readFileSync(path.join(__dirname,'../../../packages/shared/src/desktop-after-sales.ts'),'utf8');
const originals=afterSalesSource.match(/export const JST_AFTER_SALES_ORIGINAL_COLUMNS\s*=\s*\[([\s\S]*?)\]\s*as const/)?.[1];
const originalFields=originals?[...originals.matchAll(/'([^']+)'/g)].map(([,name])=>name):[];
if(!originalFields.length||new Set(originalFields).size!==originalFields.length)throw new Error('Invalid shared original after-sales fields');
fs.writeFileSync(path.join(__dirname,'../build/navigation.json'),JSON.stringify({...routes,launch,originalFields},null,2)+'\n');
