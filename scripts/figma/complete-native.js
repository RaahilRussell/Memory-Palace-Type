// Recovery/finalization for existing native-v1 nodes. Does not recreate source content.
const page=figma.root.children.find(p=>p.id==='4:66');
const band=page.findOne(n=>n.getPluginData('mneme-build')==='native-v1');
await figma.loadFontAsync({family:'Inter',style:'Regular'});
const names={home:'L01',moments:'L02',saved:'L03',savedOriginal:'L04',empty:'L05',search:'L06',mobile:'M01 / Mobile',mobileMoments:'M02 / Mobile',mobileOriginal:'M03 / Mobile',mobileSaved:'M04 / Mobile',mobileEmpty:'M05 / Mobile',arrive:'S01',aim:'S02',open:'S03',return:'S04',reduced:'S05',handoff:'H01'};
const roots=page.children.filter(n=>n.getPluginData('mneme-build')==='native-v1-screen');
const screens=Object.fromEntries(Object.entries(names).map(([k,name])=>[k,roots.find(n=>n.name.startsWith(name))]));
for(let i=0;i<29;i++)screens['detail'+i]=roots.find(n=>n.name.startsWith('O'+String(i+1).padStart(2,'0')+' /'));
if(Object.values(screens).some(n=>!n))throw Error('Missing existing screen');
for(const [key,src,name] of [['reducedOpen','open','S06 / Reduced open'],['reducedReturn','return','S07 / Reduced return']]){let n=page.findOne(n=>n.name===name&&n.getPluginData('mneme-build')==='native-v1-screen');if(!n){n=screens[src].clone();page.appendChild(n);n.name=name;n.x=screens.reduced.x+(key==='reducedOpen'?1550:3100);n.y=screens.reduced.y;}screens[key]=n;n.findAll(c=>c.type==='TEXT'&&c.characters.includes('Sound off')).forEach(c=>c.characters='Reduced motion / instant transitions');}
let count=0;
const dissolve={type:'DISSOLVE',easing:{type:'EASE_IN_AND_OUT'},duration:.45};
function link(n,key,motion=false){if(!n||!screens[key])throw Error('Missing link '+key);let top=n;while(top.parent&&top.parent.type!=='PAGE')top=top.parent;if(top.id===screens[key].id){n.reactions=[];return;}n.reactions=[{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:screens[key].id,navigation:'NAVIGATE',transition:motion?dissolve:null,resetScrollPosition:true}]}];count++;}
function act(s,name,key,motion=false){link(s.findOne(n=>n.name==='Action / '+name),key,motion);}
function photo(n){return n.findOne(c=>c.type==='RECTANGLE');}
function heart(n){return n.findOne(c=>c.type==='INSTANCE'&&c.mainComponent?.parent?.name==='Save');}
for(const [key,s] of Object.entries(screens)){
 const isMobile=key.startsWith('mobile');
 for(const n of s.findAll(n=>n.type==='INSTANCE'&&n.mainComponent?.parent?.name==='Navigation'))link(n,n.findOne(c=>c.type==='TEXT').characters.startsWith('Moments')?'moments':'home');
 for(const n of s.findAll(n=>n.name==='Action / Design in Figma'))link(n,'handoff');
 for(const n of s.findAll(n=>n.name==='Action / Room'))link(n,isMobile?'mobile':'home');
}
act(screens.home,'Enter the room','arrive');
for(const n of screens.home.children.filter(n=>/^Moment \d/.test(n.name)))link(photo(n),'detail'+(Number(n.name.slice(-2))-1));
const dests=screens.home.children.filter(n=>n.type==='INSTANCE'&&n.mainComponent?.parent?.name==='Destination');
for(const [i,n] of dests.entries())link(n,['moments','empty','arrive'][i]);
act(screens.moments,'All moments','moments');act(screens.moments,'Saved','empty');act(screens.moments,'Search moments…','search');
for(const n of screens.moments.children.filter(n=>/^Moment \d/.test(n.name))){const i=Number(n.name.slice(-2))-1;link(photo(n),'detail'+i);if(i===0)link(heart(n),'saved');}
for(let i=0;i<29;i++){act(screens['detail'+i],'Close','moments');act(screens['detail'+i],i===0?'Save moment':'Back to moments',i===0?'savedOriginal':'moments');}
const sc=screens.saved.findOne(n=>n.name==='Moment 01');link(photo(sc),'savedOriginal');link(heart(sc),'empty');act(screens.saved,'Browse all','moments');
act(screens.savedOriginal,'Close','saved');act(screens.savedOriginal,'Remove from saved','empty');act(screens.empty,'Browse moments','moments');act(screens.search,'Clear search','moments');
act(screens.mobile,'Enter the room','arrive');act(screens.mobile,'Browse moments','mobileMoments');
const mc=screens.mobileMoments.findOne(n=>n.name==='Moment 01');mc.reactions=[];link(photo(mc),'mobileOriginal');link(heart(mc),'mobileSaved');act(screens.mobileMoments,'Saved moments','mobileSaved');
act(screens.mobileOriginal,'Save moment','mobileSaved');act(screens.mobileOriginal,'Close','mobileMoments');
const ms=screens.mobileSaved.findOne(n=>n.name==='Moment 01');link(photo(ms),'mobileOriginal');link(heart(ms),'mobileEmpty');act(screens.mobileEmpty,'Browse moments','mobileMoments');
for(const key of ['arrive','aim','open','return','reduced','reducedOpen','reducedReturn']){const s=screens[key];act(s,'Lobby','home');const reduced=key.startsWith('reduced');const opened=key==='open'||key==='reducedOpen';const dest=opened?(reduced?'reducedReturn':'return'):(reduced?'reducedOpen':key==='arrive'?'aim':'open');act(s,opened?'Return':'Open moment',dest,!reduced);if(!opened)link(s.findOne(n=>n.name==='Window / 2'),dest,!reduced);}
act(screens.handoff,'Try the lobby','home');
// A fixed presentation viewport gives the collection genuine vertical scrolling.
screens.moments.resize(1440,1000);screens.moments.overflowDirection='VERTICAL';
const starts=[['home','desktop lobby'],['mobile','mobile'],['arrive','motion storyboard'],['reduced','reduced motion']];
page.flowStartingPoints=[...page.flowStartingPoints.filter(f=>!f.name.startsWith('Mneme /')&&!Object.values(screens).some(n=>n.id===f.nodeId)), ...starts.map(([k,n])=>({nodeId:screens[k].id,name:'Mneme / '+n}))];
const components=figma.root.children.find(p=>p.id==='4:65').findOne(n=>n.getPluginData('mneme-build')==='native-v1');
const foundations=figma.root.children.find(p=>p.id==='0:1').findOne(n=>n.getPluginData('mneme-build')==='native-v1');
const audit={created:new Date().toISOString(),variables:16,componentSets:5,variants:14,sourcePanes:Array.from({length:29},(_,i)=>page.findOne(n=>n.name==='Pane '+String(i+1).padStart(2,'0'))).map(n=>({id:n.id,name:n.name})),screens:Object.fromEntries(Object.entries(screens).map(([k,n])=>[k,n.id])),reactionCount:count,sections:{foundations:foundations.id,components:components.id,product:band.id},scope:'29 original viewers; representative Moment 01 save flow; mobile; motion; full instant reduced-motion loop; recovery'};
band.setPluginData('mneme-audit',JSON.stringify(audit));
figma.currentPage=page;page.selection=[screens.home];figma.viewport.scrollAndZoomIntoView([screens.home]);
print(JSON.stringify({screens:Object.keys(screens).length,links:count,home:screens.home.id}));
