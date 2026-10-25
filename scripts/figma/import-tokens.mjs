// Import an actual Figma audit, never a hand-authored approximation.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const input=process.argv[2];
if(!input)throw new Error('Usage: node scripts/figma/import-tokens.mjs <mneme-figma-audit.json>');
const report=JSON.parse(await readFile(resolve(input),'utf8'));
const t=report.tokens;
if(t?.schema!=='mneme.figma.tokens.v1'||t.sourceFile!=='L7mSgSraOzY5NM0Mx8nGUH'||!report.auditedAt)throw new Error('Expected the actual Mneme Figma audit export.');
if(report.issues?.length)throw new Error('Resolve native audit issues before importing.');
const mapping={'color/Canvas':'canvas','color/Paper':'cream','color/Ink':'ink','color/Sage':'sage','color/Muted':'muted','color/Peach':'peach','color/Sun':'sun'};
const rules=[];
for(const [name,css] of Object.entries(mapping)){
 const v=t.values[name];if(!v?.id||v.type!=='COLOR')throw new Error('Missing color '+name);
 const rgb=['r','g','b'].map(k=>{const x=v.value[k];if(typeof x!=='number'||!Number.isFinite(x)||x<0||x>1)throw new Error('Invalid color '+name);return Math.round(x*255).toString(16).padStart(2,'0');});
 rules.push(`  --${css}: #${rgb.join('')};`);
}
for(const [name,css] of Object.entries({target44:'target-size',motionHover:'hover-duration'})){
 const v=t.values[name];if(!v?.id||v.type!=='FLOAT'||!Number.isFinite(v.value)||v.value<=0)throw new Error('Invalid number '+name);
 if(name==='target44'&&v.value<44)throw new Error('Target sizes must remain at least 44px.');
 rules.push(`  --${css}: ${v.value}${name==='motionHover'?'ms':'px'};`);
}
await mkdir('src/palace/generated',{recursive:true});await mkdir('docs/figma/evidence',{recursive:true});
await writeFile('src/palace/generated/figma-lobby-tokens.css',`/* Exported from Figma ${t.sourceFile}, audited ${report.auditedAt}. Lobby only. */\n:root {\n${rules.join('\n')}\n}\n`);
await writeFile('docs/figma/evidence/native-audit.json',JSON.stringify(report,null,2)+'\n');
console.log(`Imported ${rules.length} audited Figma variables. Room files were not touched.`);
