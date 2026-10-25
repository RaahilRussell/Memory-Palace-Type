// Read-only audit, except a reversible component-propagation probe restored in finally.
for(const p of figma.root.children) if(p.loadAsync) await p.loadAsync();
const page=figma.root.children.find(p=>p.id==='4:66');
const band=page.findOne(n=>n.getPluginData('mneme-build')==='native-v1');
if(!band?.getPluginData('mneme-audit')) throw new Error('A completed native build was not found.');
const build=JSON.parse(band.getPluginData('mneme-audit'));
const roots=figma.root.children.flatMap(p=>p.children.filter(n=>n.getPluginData('mneme-build').startsWith('native-v1')));
const nodes=roots.flatMap(n=>[n,...('findAll' in n?n.findAll():[])]);
const issues=[];let reactions=0,bindings=0;
for(const n of nodes){
  if(n.boundVariables&&Object.keys(n.boundVariables).length)bindings++;
  if(n.type==='TEXT'&&n.hasMissingFont)issues.push('Missing font: '+n.id);
  if(n.reactions)for(const r of n.reactions){reactions++;for(const a of r.actions||[]){if(a.type==='NODE'&&a.destinationId&&!await figma.getNodeByIdAsync(a.destinationId))issues.push('Broken destination: '+n.id);}}
}
const library=await figma.getNodeByIdAsync(build.sections.components);
const cardSet=library.findOne(n=>n.type==='COMPONENT_SET'&&n.name==='MomentCard');
const original=cardSet.children[0];const before=original.cornerRadius;
const instances=nodes.filter(n=>n.type==='INSTANCE'&&n.mainComponent?.id===original.id);
let changed=0;
try{original.cornerRadius=before+1;changed=instances.filter(n=>n.cornerRadius===before+1).length;}finally{original.cornerRadius=before;}
const collections=await figma.variables.getLocalVariableCollectionsAsync();
const collection=collections.find(c=>c.name==='Mneme / lobby');
const variables=await Promise.all(collection.variableIds.map(id=>figma.variables.getVariableByIdAsync(id)));
const tokens={schema:'mneme.figma.tokens.v1',exportedAt:new Date().toISOString(),sourceFile:'L7mSgSraOzY5NM0Mx8nGUH',collectionId:collection.id,modeId:collection.defaultModeId,values:Object.fromEntries(variables.map(v=>[v.name,{id:v.id,type:v.resolvedType,value:v.valuesByMode[collection.defaultModeId]}]))};
const report={...build,auditedAt:new Date().toISOString(),actual:{screens:Object.keys(build.screens).length,componentSets:library.findAll(n=>n.type==='COMPONENT_SET').length,variants:library.findAll(n=>n.type==='COMPONENT').length,reactions,boundNodes:bindings,variables:variables.length},propagation:{property:'MomentCard Default.cornerRadius',temporaryChange:before+' → '+(before+1),instancesChecked:instances.length,instancesUpdated:changed,restored:original.cornerRadius===before,note:'Actual structural probe; no elapsed-time savings or human-usability improvement inferred.'},issues,tokens};
band.setPluginData('mneme-audit-latest',JSON.stringify(report));
print(JSON.stringify(report,null,2));
if(typeof mnemeSend==='function')mnemeSend('mneme-figma-audit.json',report);
figma.notify(issues.length?`Audit found ${issues.length} issue(s)`:'Native audit passed; report ready.');

await figma.loadFontAsync({family:'Inter',style:'Regular'});
let output=page.findOne(n=>n.name==='Mneme / Audit JSON');
if(!output){output=figma.createText();page.appendChild(output);output.name='Mneme / Audit JSON';}
output.fontName={family:'Inter',style:'Regular'};output.fontSize=12;output.characters=JSON.stringify(report);output.resize(1200,output.height);output.x=band.x;output.y=band.y-500;
figma.currentPage=page;page.selection=[output];figma.viewport.scrollAndZoomIntoView([output]);
