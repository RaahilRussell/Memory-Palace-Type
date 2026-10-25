await figma.loadFontAsync({family:'Inter',style:'Regular'});
const ss=figma.currentPage.findAll(n=>n.type==='SLIDE'&&n.getPluginData('mneme-slides')==='v1');
for(const [i,original,copy] of [[2,'A component change','One change reaches every memory.'],[4,'What is working','Working today. Ready to connect.']]){
  const n=ss[i].children.find(n=>n.type==='TEXT'&&(n.characters.startsWith(original)||n.characters===copy));
  if(n){await figma.loadFontAsync(n.fontName);n.characters=copy;n.fontSize=72;}
}
function label(s,name,copy,x,y,w,size,url){let n=s.children.find(n=>n.name===name);if(!n){n=figma.createText();s.appendChild(n);n.name=name;}n.fontName={family:'Inter',style:'Regular'};n.fontSize=size;n.characters=copy;n.resize(w,n.height);n.textAutoResize='HEIGHT';n.x=x;n.y=y;n.fills=[{type:'SOLID',color:{r:.224,g:.267,b:.2}}];if(url)n.hyperlink={type:'URL',value:url};return n;}
label(ss[2],'Mneme / Token handoff','Figma → running lobby\n9 exported variables drive colors, 44 px targets and 180 ms hover timing.',100,840,1650,30);
label(ss[4],'Mneme / Component link','Open component library ↗',100,920,750,28,'https://www.figma.com/design/L7mSgSraOzY5NM0Mx8nGUH/Again?node-id=25-680');
label(ss[4],'Mneme / Team repo link','Team repository (separate integration) ↗',920,920,850,28,'https://github.com/PrranitArora/VR_Multiplayer_Memoir');
figma.currentPage.selection=[ss[2]];figma.viewport.scrollAndZoomIntoView([ss[2]]);console.log('Updated token handoff and two source links.');
