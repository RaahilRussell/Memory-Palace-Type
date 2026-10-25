// Idempotent presentation-tested placement of desktop viewer actions.
const p=figma.root.children.find(p=>p.id==='4:66');let changed=0;
for(const s of p.children.filter(n=>n.getPluginData('mneme-build')==='native-v1-screen')){
 const b=s.findOne(n=>n.name==='Action / Close'); if(!b)continue;
 s.findAll(n=>n.name==='Hit target / Close').forEach(n=>n.remove());
 const other=s.children.find(n=>n.name==='Action / Save moment'||n.name==='Action / Remove from saved'||n.name==='Action / Back to moments');
 if(other&&s.width>1000){b.x=other.x+other.width+24;b.y=other.y;changed++;}
}
print('Moved '+changed+' Close actions beside the primary action.');
