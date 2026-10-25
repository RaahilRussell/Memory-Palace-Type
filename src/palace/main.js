import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import './style.css';
import { loadMemories } from './memories.js';

const $ = (id) => document.getElementById(id);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2('#e7e5dd', 0.022);
const camera = new THREE.PerspectiveCamera(61, innerWidth / innerHeight, 0.05, 120);
camera.position.set(0, 1.65, 0);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.setClearColor('#e9e7df');
$('scene').appendChild(renderer.domElement);
const isReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let drifting = !isReduced, yaw = 0, pitch = 0, targetYaw = 0, targetPitch = 0;
let selected = null, hovered = null, driftTime = 0, lastTime = 0;
const portals = [], interactables = [], controllerRays = [];
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(9, 9);
const tempMatrix = new THREE.Matrix4();
const worldPoint = new THREE.Vector3();
const lookDirection = new THREE.Vector3();


// A single sky shader keeps the atmosphere inexpensive in stereo rendering.
const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 40, 24), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: {},
  vertexShader: 'varying vec3 vPosition; void main(){vPosition=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
  fragmentShader: `varying vec3 vPosition;
    void main(){vec3 d=normalize(vPosition);float h=smoothstep(-.14,.8,d.y);
      vec3 col=mix(vec3(.88,.89,.86),vec3(.73,.83,.83),h);
      float sun=pow(max(0.,dot(d,normalize(vec3(-.6,.35,-.7)))),5.);
      col=mix(col,vec3(1.,.91,.72),sun*.6);
      col=mix(col,vec3(.97,.93,.85),pow(max(0.,1.-abs(d.y)),12.)*.7);
      gl_FragColor=vec4(col,1.);}`
}));
scene.add(sky);
scene.add(new THREE.HemisphereLight('#fffdf5', '#b8c2b4', 1.8));
const sun = new THREE.DirectionalLight('#fff2d6', 1.2);
sun.position.set(-7, 12, -8);scene.add(sun);

const floor = new THREE.Mesh(new THREE.CircleGeometry(70, 96), new THREE.MeshStandardMaterial({ color:'#e4e4d7', roughness: .65, metalness: .12 }));
floor.rotation.x = -Math.PI/2;floor.position.y = -.08;scene.add(floor);
const platform = new THREE.Mesh(new THREE.CylinderGeometry(6.8, 7, .09, 96),new THREE.MeshStandardMaterial({color:'#ece9db',roughness:.55,metalness:.08}));
platform.position.y = -.045;scene.add(platform);
for (const radius of [2.8, 5.9, 6.72]) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius+.014, 120),new THREE.MeshBasicMaterial({color:'#b8bfac',transparent:true,opacity:radius===2.8?.24:.48,side:THREE.DoubleSide}));
  ring.rotation.x=-Math.PI/2;ring.position.y=.003;scene.add(ring);
}

function glowTexture() {
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
  const ctx=canvas.getContext('2d');
  const gradient=ctx.createRadialGradient(64,64,3,64,64,64);
  gradient.addColorStop(0,'rgba(255,247,209,.48)');gradient.addColorStop(.25,'rgba(255,245,210,.3)');gradient.addColorStop(1,'rgba(255,245,210,0)');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,128,128);
  return new THREE.CanvasTexture(canvas);
}
const glowMap=glowTexture();
// Soft light spilling from the whole frame, shared by every window in stereo.
const windowGlowMap=(()=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
  const ctx=canvas.getContext('2d');
  for(const [blur,color] of [[29,'rgba(255,206,131,.65)'],[15,'rgba(255,232,181,.85)'],[6,'rgba(255,253,234,.95)']]){
    ctx.filter=`blur(${blur}px)`;ctx.fillStyle=color;
    ctx.beginPath();ctx.roundRect(64,64,128,128,8);ctx.fill();
  }
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture;
})();
const particleCount=85;
const positions=new Float32Array(particleCount*3);
for(let i=0;i<particleCount;i++){positions[i*3]=(Math.random()-.5)*24;positions[i*3+1]=Math.random()*8;positions[i*3+2]=(Math.random()-.5)*24;}
const particlesGeometry=new THREE.BufferGeometry();particlesGeometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
const particles=new THREE.Points(particlesGeometry,new THREE.PointsMaterial({size:.047,map:glowMap,color:'#fff9d4',transparent:true,opacity:.7,depthWrite:false}));
scene.add(particles);

function labelTexture(text, sub='', width=768, height=160) {
  const c=document.createElement('canvas');c.width=width;c.height=height;
  const ctx=c.getContext('2d');ctx.fillStyle='#f4f0e7';ctx.fillRect(0,0,width,height);
  ctx.textAlign='center';ctx.fillStyle='#56604d';ctx.font=`${sub?38:40}px Georgia`;
  ctx.fillText(text,width/2,sub?65:height/2+13);
  if(sub){ctx.font='17px sans-serif';ctx.fillStyle='#858b78';ctx.fillText(sub,width/2,112);}
  const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;return texture;
}
const sharedPlane = new THREE.PlaneGeometry(1,1);
const floatingPlane = new THREE.PlaneGeometry(1,1,20,12);
// A feathered rounded mask preserves the exported paper border without a hard outer rim.
const softMask = (()=>{
  const c=document.createElement('canvas');c.width=c.height=512;
  const ctx=c.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,512,512);
  ctx.filter='blur(2px)';ctx.fillStyle='#fff';ctx.beginPath();ctx.roundRect(4,4,504,504,22);ctx.fill();
  return new THREE.CanvasTexture(c);
})();
// Apply the same gentle sun-warmed grade in the room and when opening a memory.
function gradePhoto(shader){
  shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
    float luminance=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));
    vec3 graded=mix(vec3(luminance),diffuseColor.rgb,1.18);
    graded=graded*vec3(1.055,1.018,.985)+vec3(.008,.006,.004)*(1.-luminance);
    diffuseColor.rgb=clamp(graded,0.,1.);`);
}
function floatingMaterial(parameters,time,phase){
  const material=new THREE.MeshBasicMaterial({alphaMap:softMask,alphaTest:.025,side:THREE.DoubleSide,transparent:true,...parameters});
  material.onBeforeCompile=shader=>{
    if(parameters.map)gradePhoto(shader);
    shader.uniforms.floatTime=time;shader.uniforms.floatPhase={value:phase};
    shader.vertexShader='uniform float floatTime; uniform float floatPhase;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      float wave=sin(floatTime*.55+floatPhase+uv.y*2.4);
      transformed.z += sin(uv.x*3.14159265)*(.025+wave*.022)
        + sin(uv.x*6.2831853+floatTime*.4+floatPhase)*.009;`);
  };
  material.customProgramCacheKey=()=> parameters.map?'floating-photo-warm-v2':'floating-paper-v1';
  return material;
}
const textureLoader=new THREE.TextureLoader();
async function loadTexture(url) {
  const texture=await textureLoader.loadAsync(url);texture.colorSpace=THREE.SRGBColorSpace;
  texture.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),4);return texture;
}

function makePortal(texture,index,title) {
  const aspect=texture.image.width/texture.image.height;
  const width=Math.min(index%4===1?1.7:1.95,2.15*aspect);
  const height=width/aspect;
  const group=new THREE.Group();
  // Stagger the collection through 360 degrees, from low keepsakes to a high canopy.
  let degrees,distance,baseY;
  if(index<6){
    degrees=[-49,-24,4,30,54,-7][index];
    distance=[5.6,6.5,6.2,6.3,6.7,8.7][index];
    baseY=[2.1,3.65,2.4,3.6,1.95,5.05][index];
  }else if(index<16){
    degrees=85+(index-6)*28;distance=6.1+(index%3)*.45;baseY=2.25+(index%3)*.38;
  }else if(index<24){
    degrees=55+(index-16)*45;distance=8.1+(index%2)*.7;baseY=4.8+(index%3)*.28;
  }else if(index<29){
    degrees=-33+(index-24)*72;distance=7.2;baseY=1.02;
  }else{
    degrees=12+(index-29)*51.4;distance=9.8;baseY=3.1;
  }
  const angle=THREE.MathUtils.degToRad(degrees);
  group.position.set(Math.sin(angle)*distance,baseY,-Math.cos(angle)*distance);
  group.rotation.y=-angle;
  group.rotation.z=THREE.MathUtils.degToRad([3,-5,2,-4,4,-2][index%6]);
  const phase=index*2.39996,time={value:0};
  const glow=new THREE.Mesh(sharedPlane,new THREE.MeshBasicMaterial({map:windowGlowMap,transparent:true,opacity:.8,depthWrite:false,side:THREE.DoubleSide}));
  glow.scale.set(width*2.12,height*2.16,1);glow.position.z=-.04;group.add(glow);
  const border=new THREE.Mesh(floatingPlane,floatingMaterial({color:'#fff9e9',opacity:.38},time,phase));
  border.scale.set(width+.018,height+.018,1);border.position.z=-.014;group.add(border);
  const photo=new THREE.Mesh(floatingPlane,floatingMaterial({map:texture,opacity:1},time,phase));
  photo.scale.set(width,height,1);group.add(photo);
  // A subtle floor pool gives each weightless window a place in the room.
  const pool=new THREE.Mesh(sharedPlane,new THREE.MeshBasicMaterial({map:glowMap,color:'#f9e5b8',transparent:true,opacity:.2,depthWrite:false}));
  pool.rotation.x=-Math.PI/2;pool.scale.set(width*2,2.2,1);pool.position.set(group.position.x,.016,group.position.z);scene.add(pool);
  const portal={group,photo,glow,border,pool,base:group.position.clone(),baseRotation:group.rotation.clone(),baseY,phase,time,width,height,title,texture,index};
  photo.userData={action:'memory',portal};interactables.push(photo);portals.push(portal);scene.add(group);
  $('memory-count').textContent=portals.length;
  return portal;
}

const focusGroup=new THREE.Group();focusGroup.visible=false;scene.add(focusGroup);
const focusGlow=new THREE.Mesh(sharedPlane,new THREE.MeshBasicMaterial({map:windowGlowMap,transparent:true,opacity:.9,depthWrite:false}));focusGlow.position.z=-.025;focusGroup.add(focusGlow);
const focusBorder=new THREE.Mesh(sharedPlane,new THREE.MeshBasicMaterial({color:'#fff9e9',alphaMap:softMask,transparent:true}));focusBorder.position.z=-.01;focusGroup.add(focusBorder);
const focusImage=new THREE.Mesh(sharedPlane,new THREE.MeshBasicMaterial({alphaMap:softMask,transparent:true}));focusGroup.add(focusImage);
focusImage.material.onBeforeCompile=gradePhoto;
focusImage.material.customProgramCacheKey=()=> 'focused-photo-warm-v1';
const closeVR=new THREE.Mesh(sharedPlane,new THREE.MeshBasicMaterial({map:labelTexture('Return to the room  ↙','',640,100)}));
const enterVR=new THREE.Mesh(sharedPlane,new THREE.MeshBasicMaterial({map:labelTexture('Step inside  ↗','',640,100)}));
enterVR.scale.set(.65,.1,1);enterVR.userData.action='enter';enterVR.visible=false;focusGroup.add(enterVR);interactables.push(enterVR);
closeVR.scale.set(.65,.1,1);closeVR.userData.action='close';focusGroup.add(closeVR);interactables.push(closeVR);

const vrControls=new THREE.Group();vrControls.visible=false;vrControls.position.set(0,.5,-1.65);vrControls.rotation.x=-.42;scene.add(vrControls);
const vrMotion=new THREE.Mesh(sharedPlane,new THREE.MeshBasicMaterial({map:labelTexture('Drift on','',512,100)}));vrMotion.scale.set(.54,.105,1);vrMotion.position.set(-.3,-.05,0);vrMotion.userData.action='motion';vrControls.add(vrMotion);interactables.push(vrMotion);
const vrExit=new THREE.Mesh(sharedPlane,new THREE.MeshBasicMaterial({map:labelTexture('Leave the room','',512,100)}));vrExit.scale.set(.54,.105,1);vrExit.position.set(.3,-.05,0);vrExit.userData.action='exit';vrControls.add(vrExit);interactables.push(vrExit);

function showToast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>$('toast').classList.remove('visible'),6500);}
function openMemory(portal){
  if(selected)return;
  selected=portal;hovered=null;$('portal-hint').classList.remove('visible');
  const view=renderer.xr.isPresenting?renderer.xr.getCamera():camera;
  view.getWorldPosition(worldPoint);view.getWorldDirection(lookDirection);lookDirection.y=0;lookDirection.normalize();
  focusGroup.position.copy(worldPoint).addScaledVector(lookDirection,2.35);focusGroup.position.y=worldPoint.y+.16;
  focusGroup.rotation.set(0,Math.atan2(-lookDirection.x,-lookDirection.z),0);
  const aspect=portal.texture.image.width/portal.texture.image.height;
  const screenWidth=renderer.xr.isPresenting?1.95:2*2.35*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))*camera.aspect*.82;
  const w=Math.min(1.95,1.45*aspect,screenWidth), h=w/aspect;
  focusImage.scale.set(w,h,1);focusBorder.scale.set(w+.035,h+.035,1);focusGlow.scale.set(w*2.12,h*2.16,1);
  focusImage.material.map=portal.texture;focusImage.material.needsUpdate=true;
  focusImage.material.opacity=focusBorder.material.opacity=0;
  enterVR.position.y=-h/2-.2;
  enterVR.visible=Boolean(portal.memory?.generated)&&renderer.xr.isPresenting;
  closeVR.position.y=-h/2-(enterVR.visible?.38:.2);
  $('step-inside').hidden=!portal.memory?.generated;
  closeVR.visible=renderer.xr.isPresenting;
  focusGroup.visible=true;$('memory-caption').hidden=renderer.xr.isPresenting;
  document.body.classList.add('inspecting');
}
function closeMemory(){selected=null;focusGroup.visible=false;$('memory-caption').hidden=true;document.body.classList.remove('inspecting');}
function setMotion(){
  drifting=!drifting;$('motion').setAttribute('aria-pressed',String(drifting));$('motion').lastElementChild.textContent=drifting?'Drift on':'Drift off';
  vrMotion.material.map.dispose();vrMotion.material.map=labelTexture(drifting?'Drift on':'Drift off','',512,100);vrMotion.material.needsUpdate=true;
}
if(isReduced){drifting=true;setMotion();}
function activate(object){
  const {action,portal}=object.userData;
  if(action==='enter')void enterSelected();
  else if(action==='close')closeMemory();
  else if(action==='memory')openMemory(portal);
  else if(action==='motion')setMotion();
  else if(action==='exit')renderer.xr.getSession()?.end();
}
function visibleTargets(){return interactables.filter(o=>{
  if(o.userData.action==='memory')return !selected;
  if(o.userData.action==='enter')return selected?.memory?.generated&&renderer.xr.isPresenting;
  if(o.userData.action==='close')return selected&&renderer.xr.isPresenting;
  return renderer.xr.isPresenting&&!selected;
});}
function getIntersection(){return raycaster.intersectObjects(visibleTargets(),false)[0];}

let drag=null;
renderer.domElement.addEventListener('pointerdown',event=>{drag={x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,moved:false};renderer.domElement.setPointerCapture(event.pointerId);});
renderer.domElement.addEventListener('pointermove',event=>{
  pointer.set(event.clientX/innerWidth*2-1,-event.clientY/innerHeight*2+1);
  if(drag&&!selected){
    if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>5)drag.moved=true;
    targetYaw-=(event.clientX-drag.lastX)*.003;targetPitch-= (event.clientY-drag.lastY)*.002;
    targetPitch=THREE.MathUtils.clamp(targetPitch,-.45,.65);drag.lastX=event.clientX;drag.lastY=event.clientY;
  }
});
renderer.domElement.addEventListener('pointerup',event=>{
  if(drag&&!drag.moved){pointer.set(event.clientX/innerWidth*2-1,-event.clientY/innerHeight*2+1);raycaster.setFromCamera(pointer,camera);const hit=getIntersection();if(selected)closeMemory();else if(hit)activate(hit.object);}
  drag=null;
});
renderer.domElement.addEventListener('pointercancel',()=>drag=null);
renderer.domElement.addEventListener('pointerleave',()=>{pointer.set(9,9);});
addEventListener('keydown',event=>{if(event.key==='Escape'){closeMemory();}if(!selected){if(event.key==='ArrowLeft')targetYaw+=.35;if(event.key==='ArrowRight')targetYaw-=.35;}});
$('motion').onclick=setMotion;$('close-memory').onclick=closeMemory;
$('upload').onclick=()=>{location.href='/library/?import=1';};
$('step-inside').onclick=enterSelected;
async function enterSelected(){
  const memory=selected?.memory;
  if(!memory?.generated)return;
  try {
    const session=renderer.xr.getSession();
    if(session)await session.end();
    location.href=`/library/?memory=${encodeURIComponent(memory.id)}&from=room`;
  } catch {showToast('Leave VR, then select Step inside to open this memory.');}
}

let audioContext=null,soundOn=false;
$('sound').onclick=async()=>{
  try{
    if(!audioContext){
      audioContext=new AudioContext();const master=audioContext.createGain();master.gain.value=.018;master.connect(audioContext.destination);
      [130.81,196,261.63,329.63].forEach((frequency,index)=>{const osc=audioContext.createOscillator();osc.type='sine';osc.frequency.value=frequency;osc.detune.value=index*2;const gain=audioContext.createGain();gain.gain.value=index===0?.65:.18;osc.connect(gain).connect(master);osc.start();});
    }
    soundOn=!soundOn;await(soundOn?audioContext.resume():audioContext.suspend());
    $('sound').setAttribute('aria-pressed',String(soundOn));$('sound').lastElementChild.textContent=soundOn?'Sound on':'Sound off';
  }catch{showToast('Audio isn’t available in this browser.');}
};

const modelFactory=new XRControllerModelFactory();
for(let i=0;i<2;i++){
  const controller=renderer.xr.getController(i);scene.add(controller);
  const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(0,0,-1)]),new THREE.LineBasicMaterial({color:'#e6c582',transparent:true,opacity:.65}));line.scale.z=5;controller.add(line);
  const dot=new THREE.Mesh(new THREE.SphereGeometry(.012,8,8),new THREE.MeshBasicMaterial({color:'#fff3c7'}));scene.add(dot);dot.visible=false;
  controllerRays.push({controller,line,dot,connected:false});
  controller.addEventListener('connected',()=>controllerRays[i].connected=true);
  controller.addEventListener('disconnected',()=>{controllerRays[i].connected=false;dot.visible=false;});
  controller.addEventListener('select',()=>{tempMatrix.identity().extractRotation(controller.matrixWorld);raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);raycaster.ray.direction.set(0,0,-1).applyMatrix4(tempMatrix);const hit=getIntersection();if(hit)activate(hit.object);});
  const grip=renderer.xr.getControllerGrip(i);grip.add(modelFactory.createControllerModel(grip));scene.add(grip);
}
$('enter-vr').onclick=async()=>{
  if(!navigator.xr||!window.isSecureContext){showToast('Open this room in the Quest browser over HTTPS to enter VR. You can explore by dragging here.');return;}
  $('enter-vr').disabled=true;
  try{
    if(!await navigator.xr.isSessionSupported('immersive-vr')){showToast('Your browser isn’t connected to a VR headset. Open this room in your Quest browser.');return;}
    const session=await navigator.xr.requestSession('immersive-vr',{optionalFeatures:['local-floor','bounded-floor']});
    closeMemory();await renderer.xr.setSession(session);
  }catch(error){showToast(error.name==='NotAllowedError'?'VR access was cancelled. You can enter whenever you’re ready.':'The headset could not start VR. Check the connection and try again.');}
  finally{$('enter-vr').disabled=false;}
};
renderer.xr.addEventListener('sessionstart',()=>{camera.rotation.set(0,0,0);vrControls.visible=true;});
renderer.xr.addEventListener('sessionend',()=>{closeMemory();vrControls.visible=false;controllerRays.forEach(({dot})=>dot.visible=false);camera.position.set(0,1.65,0);});

addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
renderer.setAnimationLoop((time)=>{
  const dt=Math.min((time-lastTime)/1000,.05);lastTime=time;
  if(drifting&&!selected)driftTime+=dt;
  if(!renderer.xr.isPresenting){
    yaw=THREE.MathUtils.damp(yaw,targetYaw,6,dt);pitch=THREE.MathUtils.damp(pitch,targetPitch,6,dt);
    camera.rotation.set(pitch,yaw,0,'YXZ');
    raycaster.setFromCamera(pointer,camera);const hit=drag?.moved?null:getIntersection();hovered=hit?.object.userData.portal||null;
    renderer.domElement.style.cursor=selected?'zoom-out':drag?.moved?'grabbing':hovered?'pointer':'grab';
    const hint=$('portal-hint');hint.classList.toggle('visible',!!hovered&&!selected);
    if(hovered&&!selected){worldPoint.copy(hovered.group.position);worldPoint.y-=hovered.height/2+.14;worldPoint.project(camera);hint.style.left=`${THREE.MathUtils.clamp((worldPoint.x*.5+.5)*innerWidth,120,innerWidth-120)}px`;hint.style.top=`${THREE.MathUtils.clamp((-worldPoint.y*.5+.5)*innerHeight,100,innerHeight-230)}px`;}
  }else{
    hovered=null;
    for(const {controller,line,dot,connected} of controllerRays){
      if(!connected){dot.visible=false;continue;}
      tempMatrix.identity().extractRotation(controller.matrixWorld);raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);raycaster.ray.direction.set(0,0,-1).applyMatrix4(tempMatrix);
      const hit=getIntersection();line.scale.z=hit?hit.distance:5;dot.visible=!!hit;
      if(hit){dot.position.copy(hit.point);if(hit.object.userData.portal)hovered=hit.object.userData.portal;}
    }
  }
  for(const p of portals){
    // Independent slow currents; a pointed-at photo settles for an easier selection.
    if(drifting&&!selected)p.time.value+=dt*(hovered===p?.12:1);
    const t=p.time.value,phase=p.phase;
    const cycle=((t*.012+.18+(p.index*.137)% .64)%1);
    const rise=(cycle-.5)*.65;
    p.group.position.set(p.base.x+Math.sin(t*.42+phase)*.085,p.baseY+rise+Math.sin(t*.65+phase)*.065,p.base.z+Math.cos(t*.36+phase)*.055);
    p.group.rotation.set(Math.sin(t*.48+phase)*.045,p.baseRotation.y+Math.sin(t*.38+phase)*.055,p.baseRotation.z+Math.sin(t*.52+phase)*.035);
    p.pool.position.x=p.group.position.x;p.pool.position.z=p.group.position.z;
    const edgeFade=THREE.MathUtils.smoothstep(cycle,0,.06)*(1-THREE.MathUtils.smoothstep(cycle,.94,1));
    const opacity=selected?.18:.94*edgeFade;
    p.photo.material.opacity=THREE.MathUtils.damp(p.photo.material.opacity,opacity,5,dt);
    p.border.material.opacity=p.photo.material.opacity*.38;
    p.pool.material.opacity=selected?.04:.16*edgeFade;
    p.glow.material.opacity=THREE.MathUtils.damp(p.glow.material.opacity,selected?.1:(hovered===p?1:.8+Math.sin(t*.6+phase)*.045)*edgeFade,5,dt);
    const scale=hovered===p?1.035:1;p.group.scale.lerp(new THREE.Vector3(scale,scale,scale),Math.min(dt*5,1));
  }
  particles.rotation.y=driftTime*.002;particles.position.y=(driftTime*.012)%2;
  if(selected){focusImage.material.opacity=THREE.MathUtils.damp(focusImage.material.opacity,1,5,dt);focusBorder.material.opacity=focusImage.material.opacity;}
  vrControls.visible=renderer.xr.isPresenting&&!selected;
  renderer.render(scene,camera);
});

loadMemories().then(async ({ memories, status }) => {
  const results=await Promise.allSettled(memories.slice(0,36).map(async(memory,index)=>{
    const portal=makePortal(await loadTexture(memory.url),index,memory.title);
    portal.memory=memory;
    return portal;
  }));
  portals.sort((a,b)=>a.index-b.index);
  $('loading').classList.add('done');
  if(status==='offline')showToast('Library unavailable. Showing the sample room.');
  else if(results.some(r=>r.status==='rejected'))showToast('Some photos could not load. Your originals are in the library.');
  else if(memories.length>36)showToast('Showing 36 moments. Your full collection is in the library.');
});

// Scene diagnostics for a lightweight browser smoke check.
window.memoryRoom={get count(){return portals.length;},get selected(){return selected?.title||null;},get drifting(){return drifting;},get renderer(){return renderer;},get poses(){return portals.map(p=>({index:p.index,position:p.group.position.toArray(),rotation:p.group.rotation.toArray(),time:p.time.value}));}};
