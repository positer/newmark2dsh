import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
if(process.platform!=='darwin'||process.env.GITHUB_ACTIONS!=='true')throw Error('Disposable Mac CI required');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'newmark-space-probe-')),binary=path.join(folder,'probe'),evidence=process.env.NEWMARK_EVIDENCE_DIR;
execFileSync('/usr/bin/xcrun',['swiftc','-parse-as-library',fileURLToPath(new URL('./lib/macos-space-probe.swift',import.meta.url)),'-o',binary,'-framework','AppKit','-framework','ApplicationServices'],{stdio:'inherit'});
execFileSync('/usr/bin/open',['-a','Mission Control']);await new Promise(r=>setTimeout(r,700));let result;
try{result=JSON.parse(execFileSync(binary,[],{encoding:'utf8',timeout:15000}));fs.writeFileSync(path.join(evidence,'mission-control-probe.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({space_probe:true,accessible:result.available,elements:result.elements?.length,controls:result.elements?.filter(e=>e.role==='AXButton'||Object.values(e).some(v=>typeof v==='string'&&/desktop|space/i.test(v)))}));}
finally{execFileSync(binary,['--escape'],{timeout:5000,stdio:'ignore'});}
