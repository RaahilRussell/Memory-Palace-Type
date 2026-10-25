// Append an evidence appendix in Figma Slides; keep existing slides unchanged.
if(figma.editorType!=='slides')throw new Error('Open the Again submission deck in Figma Slides first.');
if(figma.currentPage.findOne(n=>n.getPluginData('mneme-slides')==='v1'))throw new Error('Mneme appendix already exists; inspect before rebuilding.');
await figma.loadFontAsync({family:'Inter',style:'Regular'});
let serif={family:'Georgia',style:'Regular'};try{await figma.loadFontAsync(serif);}catch{serif={family:'Inter',style:'Regular'};}
const color=s=>({r:parseInt(s.slice(1,3),16)/255,g:parseInt(s.slice(3,5),16)/255,b:parseInt(s.slice(5,7),16)/255});
const fill=s=>[{type:'SOLID',color:color(s)}];
function textIn(p,s,x,y,size=30,w=1700,title=false){const n=figma.createText();p.appendChild(n);n.fontName=title?serif:{family:'Inter',style:'Regular'};n.characters=s;n.fontSize=size;n.fills=fill('#394433');n.textAutoResize='HEIGHT';n.resize(w,n.height);n.x=x;n.y=y;return n;}
const slides=[];
function slide(title,kicker){const s=figma.createSlide();s.name='Mneme / '+title;s.fills=fill('#f3f1e7');s.setPluginData('mneme-slides','v1');const scale=s.width/1920;textIn(s,kicker.toUpperCase(),100*scale,75*scale,21*scale,1700*scale);textIn(s,title,100*scale,160*scale,80*scale,1710*scale,true);s.setSlideTransition({style:'DISSOLVE',duration:.3,curve:'EASE_IN_AND_OUT',timing:{type:'ON_CLICK'}});slides.push(s);return {s,scale};}
let a=slide('The photos became the interface.','01 / Product decision');
textIn(a.s,'Twenty-nine Figma exports become a sunlit spatial collection.\nThe quiet room keeps four persistent actions; the lobby handles finding originals and keeping favorites.',100*a.scale,330*a.scale,38*a.scale,1650*a.scale);
textIn(a.s,'Decision → product\nRemove small persistent copy → more attention on photographs\nSeparate lobby → browse, search and save without crowding the room\nPreserve the original → every photo remains directly accessible',100*a.scale,590*a.scale,30*a.scale,1650*a.scale);
a=slide('One useful loop, before more features.','02 / Live prototype');
textIn(a.s,'Browse → original → save → saved → remove → empty → browse\nDesktop and mobile flows expose success and recovery states.',100*a.scale,330*a.scale,36*a.scale,1650*a.scale);
// The build UI passes the actual audited node ID. Do not fabricate an embed destination.
const homeId=typeof mnemeEvidence!=='undefined'?mnemeEvidence?.screens?.home:null;
if(homeId){const url='https://www.figma.com/proto/L7mSgSraOzY5NM0Mx8nGUH/Again?node-id='+homeId.replace(':','-')+'&starting-point-node-id='+homeId.replace(':','-');try{const embed=await figma.createLinkPreviewAsync(url);a.s.appendChild(embed);embed.x=100*a.scale;embed.y=520*a.scale;if(embed.resize)embed.resize(1680*a.scale,450*a.scale);}catch(e){textIn(a.s,'Prototype: '+url,100*a.scale,550*a.scale,24*a.scale,1650*a.scale);textIn(a.s,'Insert → Design → paste the prototype URL to create the live embed.',100*a.scale,690*a.scale,26*a.scale,1600*a.scale);}}else{textIn(a.s,'Awaiting the native audit: add the actual prototype embed before submission.',100*a.scale,550*a.scale,30*a.scale,1650*a.scale);}
a=slide('A component change travels with the content.','03 / Reuse & handoff');
textIn(a.s,'Shared variables → Action / Save / MomentCard / Navigation / Destination\nNative instances keep image and title overrides while inheriting structure.\nThe same Pane 01–29 names connect source frames to runtime assets.',100*a.scale,335*a.scale,34*a.scale,1650*a.scale);
const probe=typeof mnemeEvidence!=='undefined'?mnemeEvidence?.propagation:null;
textIn(a.s,probe?`Measured component probe\n${probe.instancesUpdated} of ${probe.instancesChecked} instances inherited a temporary corner-radius change.\nThe original value was restored. This measures propagation, not time saved.`:'Evidence pending: run the native audit to measure actual instance propagation.',100*a.scale,635*a.scale,32*a.scale,1650*a.scale);
a=slide('Four quiet beats. A still point of view.','04 / Motion contract');
textIn(a.s,'ARRIVE  →  AIM  →  OPEN  →  RETURN',100*a.scale,350*a.scale,44*a.scale,1680*a.scale);
textIn(a.s,'Target emphasis helps a photo feel selectable. Opening it holds attention.\nStoryboard: 450 ms dissolve. Reduced motion: instant transitions.\nLobby hover: 180 ms. No automatic viewer movement.',100*a.scale,505*a.scale,35*a.scale,1680*a.scale);
textIn(a.s,'The browser prototype communicates sequence. It does not validate stereoscopic comfort.\nThe existing room returns immediately; a return dissolve remains a proposal.',100*a.scale,800*a.scale,26*a.scale,1680*a.scale);
a=slide('What is working, and what is still separate.','05 / Scope & access');
textIn(a.s,'Working Memory Palace prototype\n29 spatial photographs • original viewer • drift and sound controls\nLobby search • local favorites • empty-state recovery • reduced motion',100*a.scale,340*a.scale,36*a.scale,1660*a.scale);
textIn(a.s,'Separate team work / do not imply integration\nMultiplayer and reconstructed scenes in the wider Again project\nPhysical Quest 2 validation, judge-accessible build, final video and Edu confirmation',100*a.scale,650*a.scale,30*a.scale,1680*a.scale);
const logs=typeof mnemeEvidence!=='undefined'?mnemeEvidence?.stageLogs:null;
for(const [i,name] of ['Ideation','Prototyping','Handoff','Code generation'].entries()){a=slide(name,'Stage log '+(i+1)+' / under 200 words');textIn(a.s,logs?.[i]||'Complete with actual team facts:\nTools used and why\nApproximate minutes and rating (1–5)\nSpecific output → next stage → working product\nOne observed limitation or rework decision\n\nNo Figma Make usage or human-test result is claimed without evidence.',100*a.scale,335*a.scale,33*a.scale,1660*a.scale);}
figma.viewport.scrollAndZoomIntoView([slides[0]]);
const report={created:new Date().toISOString(),slides:slides.map(s=>({id:s.id,name:s.name})),prototypeNode:homeId,stageLogsFilled:!!logs};console.log(JSON.stringify(report,null,2));if(typeof mnemeSend==='function')mnemeSend('mneme-slides-report.json',report);
