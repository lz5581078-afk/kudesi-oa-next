const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
for(const dir of ['src','scripts','test'])for(const name of fs.readdirSync(path.join(__dirname,'..',dir))){if(!name.endsWith('.cjs'))continue;const r=spawnSync(process.execPath,['--check',path.join(__dirname,'..',dir,name)],{stdio:'inherit'});if(r.status)process.exit(r.status);}
