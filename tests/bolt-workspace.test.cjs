const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const modeling=require('../app/modeling.js');
const source=fs.readFileSync(path.join(__dirname,'../app/bolt-workspace.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

function attachmentMesh(centers=[[0,0,10]]){
  const mesh={nodes:[],elements:[]};
  for(const [x,y,z] of centers)for(const end of [-10,10]){
    const part=modeling.createPrimitive({kind:'plate',origin:[x-4,y-4,z+end],size:[8,8,0],divisions:[2,2,1],startNode:mesh.nodes.length+1,startElement:mesh.elements.length+1});
    mesh.nodes.push(...part.nodes);mesh.elements.push(...part.elements);
  }
  return mesh;
}

// Small DOM adapter supplies only form controls; generation and validation use
// the real modeling core so these tests cross the UI-to-engine API boundary.
function fixture(mesh=attachmentMesh()){
  let fields=new Map(),actions=new Map(),busy=false,workspace;
  const calls={append:[],preview:[],messages:[],errors:[],clears:0,logs:[]},selection=[];
  const report={className:'',textContent:''};
  const panel={querySelectorAll:selector=>selector==='[data-bolt]'?[...fields.values()]:[]};
  function attrs(text){return Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(match=>[match[1],match[2]]));}
  function draw(){
    const view=workspace.render();fields=new Map();actions=new Map();
    const html=view.body+view.foot;
    for(const match of html.matchAll(/<input\b([^>]+)>|<select\b([^>]+)>([\s\S]*?)<\/select>/g)){
      const a=attrs(match[1]||match[2]);if(!a['data-bolt'])continue;
      const options=match[3]?[...match[3].matchAll(/<option\b([^>]+)>([^<]*)<\/option>/g)]:[];
      const option=options.find(o=>/\bselected\b/.test(o[1]))||options[0];
      const listeners={};
      const el={dataset:{bolt:a['data-bolt']},value:option?attrs(option[1]).value:a.value||'',addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn),dispatch(name){for(const fn of listeners[name]||[])fn({target:el});}};
      fields.set(el.dataset.bolt,el);
    }
    for(const match of html.matchAll(/<button\b([^>]*data-bolt-action="[^"]+"[^>]*)>/g)){
      const a=attrs(match[1]),el={dataset:{boltAction:a['data-bolt-action']},onclick:null};actions.set(el.dataset.boltAction,el);
    }
    workspace.bind();return view;
  }
  const engine={
    getMesh:()=>mesh,
    getNextIds:()=>({node:mesh.nodes.reduce((max,n)=>Math.max(max,n.id),0)+1,element:mesh.elements.reduce((max,e)=>Math.max(max,e.id),0)+1,property:3,material:4}),
    getState:()=>({selection:{nodes:selection}}),
    previewMesh:value=>calls.preview.push(value),
    async appendMesh(value,options){calls.append.push({mesh:value,options});mesh.nodes.push(...value.nodes);mesh.elements.push(...value.elements);}
  };
  const hooks={engine:()=>engine,isBusy:()=>busy,render:draw,clearPreview(){calls.clears++;},message:(text,error)=>calls.messages.push({text,error}),log:text=>calls.logs.push(text),async run(fn){if(busy)return;busy=true;try{await fn();}catch(error){calls.errors.push(error.message);}finally{busy=false;}}};
  const context={window:{WebMeshModeling:modeling},document:{getElementById:id=>id==='wb-panel-body'?panel:id==='wb-report'?report:null,querySelectorAll:selector=>selector==='[data-bolt-action]'?[...actions.values()]:[]}};
  vm.runInNewContext(source,context);workspace=context.window.WebMeshBoltWorkspace.create(hooks);draw();
  return {calls,mesh,report,selection,workspace,field:key=>fields.get(key),set(key,value,event='input'){const input=fields.get(key);assert.ok(input,`Rendered field ${key}`);input.value=String(value);input.dispatch(event);},async action(name){assert.ok(actions.has(name),`Rendered action ${name}`);await actions.get(name).onclick();},setBusy(value){busy=value;}};
}
function stiffness(f,values=[1000,2000,3000,0,0,0]){values.forEach((value,i)=>f.set('k'+i,value));}

test('CBUSH is primary and blank stiffness prevents model mutation',async()=>{
  const f=fixture();assert.equal(f.field('connection').value,'CBUSH');
  await f.action('create');assert.equal(f.calls.append.length,0);assert.match(f.calls.errors[0],/finite K1/);
});

test('CBUSH create passes explicit PBUSH stiffness and both RBE2 attachment patches',async()=>{
  const f=fixture();stiffness(f,[1000,2000,3000,4,5,6]);await f.action('create');
  assert.deepEqual(f.calls.errors,[]);assert.equal(f.calls.append.length,1);
  const {mesh,options}=f.calls.append[0];assert.equal(mesh.bolts.length,1);
  assert.deepEqual(mesh.elements.map(e=>e.type),['CBUSH','RBE2','RBE2']);
  assert.deepEqual(plain(mesh.properties),[{id:3,type:'PBUSH',stiffness:[1000,2000,3000,4,5,6]}]);
  assert.deepEqual(plain(options),{});assert.ok(mesh.bolts[0].headNodes.length>=3);assert.ok(mesh.bolts[0].nutNodes.length>=3);
  assert.ok(mesh.elements.slice(1).every(e=>e.cm==='123'));
});

test('preview includes referenced source nodes and editing stiffness clears the preview',async()=>{
  const f=fixture();stiffness(f);await f.action('preview');assert.deepEqual(f.calls.errors,[]);assert.equal(f.calls.append.length,0);
  const preview=f.calls.preview[0],ids=new Set(preview.nodes.map(n=>n.id));assert.ok(preview.elements.every(e=>e.nodes.every(id=>ids.has(id))));
  const before=f.calls.clears;f.set('k0',1234);assert.equal(f.calls.clears,before+1);
});

test('selected node sets the bolt center from global coordinates',async()=>{
  const mesh=attachmentMesh([[10,20,40]]);mesh.nodes.push({id:999,x:10,y:20,z:40});
  const f=fixture(mesh);f.selection.push(999);await f.action('center');
  assert.equal(f.field('center0').value,'10');assert.equal(f.field('center1').value,'20');assert.equal(f.field('center2').value,'40');
  stiffness(f);await f.action('create');assert.deepEqual(f.calls.errors,[]);assert.deepEqual(plain(f.calls.append[0].mesh.bolts[0].center),[10,20,40]);
});

test('circular controls forward start angle, radial direction, count and partial sweep',async()=>{
  const centers=[[-30,0,10],[0,-30,10],[30,0,10]],f=fixture(attachmentMesh(centers));
  f.set('kind','circular','change');f.set('startAngle',90);f.set('angle',180);f.set('count',3);f.set('radialDirection0',0);f.set('radialDirection1',1);stiffness(f);await f.action('create');
  assert.deepEqual(f.calls.errors,[]);const actual=f.calls.append[0].mesh.bolts.map(b=>b.center);assert.equal(actual.length,3);
  actual.forEach((p,i)=>p.forEach((v,j)=>near(v,centers[i][j])));
});

test('selected head and nut lists constrain each attachment pool and tolerate trailing separators',async()=>{
  const f=fixture();f.selection.push(2,4,5);await f.action('head');f.selection.splice(0,f.selection.length,11,13,14);await f.action('nut');
  f.set('headNodes','2, 4, 5, ');stiffness(f);await f.action('create');assert.deepEqual(f.calls.errors,[]);
  assert.deepEqual(plain(f.calls.append[0].mesh.bolts[0].headNodes),[2,4,5]);assert.deepEqual(plain(f.calls.append[0].mesh.bolts[0].nutNodes),[11,13,14]);
});

test('overlapping dependent spiders reject without appending a second assembly',async()=>{
  const f=fixture();stiffness(f);await f.action('create');assert.equal(f.calls.append.length,1);
  await f.action('create');assert.equal(f.calls.append.length,1);assert.match(f.calls.errors[0],/overlapping rigid spiders/);
});

test('missing attachment patches and busy operations never append connectors',async()=>{
  const f=fixture();stiffness(f);f.set('center2',100);await f.action('create');assert.match(f.calls.errors[0],/nearby attachment nodes/);assert.equal(f.calls.append.length,0);
  f.setBusy(true);await f.action('create');assert.equal(f.calls.errors.length,1);assert.equal(f.calls.append.length,0);
});

test('CROD alternative forwards area and explicit material values without PBUSH',async()=>{
  const f=fixture();f.set('connection','CROD','change');f.set('area',37);f.set('E',70000);f.set('nu',0.32);f.set('rho',1e-8);await f.action('create');
  assert.deepEqual(f.calls.errors,[]);const {mesh,options}=f.calls.append[0];assert.equal(mesh.elements[0].type,'CROD');assert.equal(mesh.properties,undefined);
  assert.deepEqual(plain(options),{area:37,material:{id:4,E:70000,nu:0.32,rho:1e-8}});
});
