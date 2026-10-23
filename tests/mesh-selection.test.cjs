const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const S=require('../app/mesh-selection.js');
const context=vm.createContext({window:{},console,performance});vm.runInContext(fs.readFileSync(require.resolve('../vendor/three-runtime.js'),'utf8'),context);const T=context.window.WebMeshThree;
function mesh(){return {nodes:[0,1].flatMap((z,j)=>[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y],i)=>({id:j*4+i+1,x,y,z,cp:0}))),elements:[{id:11,type:'CQUAD4',nodes:[1,2,3,4]},{id:12,type:'CQUAD4',nodes:[5,6,7,8]}]};}
function camera(){const c=new T.OrthographicCamera(-2,2,2,-2,.01,100);c.position.set(0,0,10);c.lookAt(0,0,0);c.updateMatrixWorld(true);return c;}
const rect={left:100,top:50,width:400,height:400};
test('detached picking selects only the visible proposed face, nodes and whole elements',()=>{
 const m=mesh(),before=JSON.stringify(m),p=S.createPicker(T,m),c=camera();
 assert.deepEqual(p.pick(c,rect,200,350,'node'),[5]);
 assert.deepEqual(new Set(p.pick(c,rect,300,250,'face')),new Set([5,6,7,8]));
 assert.deepEqual(p.pick(c,rect,300,250,'element'),[12]);assert.deepEqual(p.pick(c,rect,490,440,'node'),[]);
 assert.deepEqual(new Set(p.box(c,rect,[190,140,410,360],'node',true)),new Set([5,6,7,8]));
 assert.equal(p.box(c,rect,[190,140,410,360],'node',false).length,8);
 assert.deepEqual(p.box(c,rect,[190,140,410,360],'element',true),[12]);
 assert.deepEqual(p.box(c,rect,[190,140,410,360],'element',false),[11,12]);
 assert.equal(JSON.stringify(m),before);p.dispose();
});
test('shared solid facets are removed while boundary and quadratic midside nodes remain pickable',()=>{
 const m={nodes:Array.from({length:12},(_,i)=>({id:i+1,x:i%2,y:Math.floor(i/2)%2,z:Math.floor(i/4)})),elements:[{id:1,type:'CHEXA',nodes:[1,2,4,3,5,6,8,7]},{id:2,type:'CHEXA',nodes:[5,6,8,7,9,10,12,11]}]};
 assert.equal(S.surfaces(m).length,10);
 const q={nodes:Array.from({length:20},(_,i)=>({id:i+1,x:i,y:0,z:0})),elements:[{id:1,type:'CHEXA',nodes:Array.from({length:20},(_,i)=>i+1)}]};
 const faces=S.surfaces(q);assert.equal(faces.length,6);assert.ok(faces.every(f=>f.nodes.length===8));assert.deepEqual(faces[1].nodes,[5,17,6,18,7,19,8,20]);
});
test('picker clipping and scoped meshes do not select behind the camera or outside the proposal',()=>{
 const m=mesh(),p=S.createPicker(T,{nodes:m.nodes.slice(0,4),elements:m.elements.slice(0,1)}),c=camera();
 assert.deepEqual(p.pick(c,rect,300,250,'element'),[11]);
 c.position.set(0,0,-10);c.lookAt(0,0,-20);c.updateMatrixWorld(true);
 assert.deepEqual(p.box(c,rect,[0,0,900,900],'node',false),[]);p.dispose();
});
test('selection sessions restore visibility, remove listeners and never mutate live selection on disposal',()=>{
 const previous=global.document,dom={style:{},remove(){this.removed=true;}},events=new Map();global.document={createElement:()=>dom,body:{appendChild(){}}};
 const canvas={clientWidth:400,clientHeight:400,getBoundingClientRect:()=>rect,addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name,fn)=>{assert.equal(events.get(name),fn);events.delete(name);}},scene=new T.Scene(),visible=new T.Group(),hidden=new T.Group();hidden.visible=false;scene.add(visible,hidden);
 const initial=JSON.stringify(mesh()),changed=[];
 try{const p=S.create({THREE:T,scene,canvas,getCamera:camera,getControls:()=>({target:new T.Vector3(),update(){}}),mesh:mesh(),onChange:s=>changed.push(s),selected:[5]});
 assert.equal(visible.visible,false);p.set([6,7]);assert.deepEqual(p.get(),[6,7]);p.configure({mode:'element'});assert.deepEqual(p.get(),[]);p.dispose();p.dispose();
 assert.equal(visible.visible,true);assert.equal(hidden.visible,false);assert.equal(scene.children.length,2);assert.equal(events.size,0);assert.equal(dom.removed,true);assert.equal(JSON.stringify(mesh()),initial);
 }finally{global.document=previous;}
});
