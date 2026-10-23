const {test}=require('node:test');
const assert=require('node:assert/strict');
const A=require('../app/mesh-actions.js'),P=require('../app/mesh-action-project.js'),O=require('../app/engine-ownership.js');
const copy=x=>JSON.parse(JSON.stringify(x));
function plate(tri=false){return{nodes:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]].map(([x,y,z],i)=>({id:i+1,x,y,z})),elements:tri?[{id:1,type:'CTRIA3',pid:1,nodes:[1,2,3]},{id:2,type:'CTRIA3',pid:1,nodes:[1,3,4]}]:[{id:1,type:'CQUAD4',pid:1,nodes:[1,2,3,4]}]};}
function semantic(mesh=plate()){return{nodes:mesh.nodes.map(({id,...n})=>[id,{...n,cp:0,cd:0,ps:''}]),elems:{quad:mesh.elements.map(e=>({type:e.type,eid:e.id,pid:e.pid,n:e.nodes}))},properties:[[1,{type:'PSHELL',pid:1,mid1:1,mid2:1,t:.1}],[2,{type:'PSOLID',pid:2,mid:1}]],materials:[[1,{type:'MAT1',mid:1,E:100,nu:.3,rho:1}]],coords:[],masses:[],loads:{},spc:[],spc1:[],temperatures:[]};}
const extrude=(tri=false,vector=[0,0,2])=>A.execute(plate(tri),[{action:'extrude-shells',elements:tri?[1,2]:[1],pid:2,vector,layers:2}],{node:10,element:10});
test('shell extrusion shares columns and base nodes; handles negative vector, hex and wedge Jacobians',()=>{
  for(const tri of [false,true])for(const vector of [[0,0,2],[0,0,-2],[1,0,2]]){
    const r=extrude(tri,vector);assert.equal(r.nodes.length,8);assert.equal(r.elements.length,tri?4:2);assert.equal(new Set(r.elements.flatMap(e=>e.nodes)).size,12);
    assert.equal(r.elements[0].type,tri?'CPENTA':'CHEXA');assert.deepEqual(r.mesh.elements.slice(0,tri?2:1),plate(tri).elements);
    for(const e of r.elements)A.validateElement(e,new Map(r.mesh.nodes.map(n=>[n.id,n])));
  }
});
test('manual ordered node extrusion can use only existing solid nodes',()=>{
  const solid=extrude().mesh;solid.elements=solid.elements.filter(e=>e.type==='CHEXA');
  const r=A.execute(solid,[{action:'extrude-edges',nodes:[1,2],pid:1,vector:[0,0,2],layers:2,reuse:true,tolerance:1e-7}]);
  assert.equal(r.nodes.length,0);assert.equal(r.elements.length,2);assert.equal(r.elements[0].type,'CQUAD4');
  const ambiguous=copy(solid);ambiguous.nodes.push({...solid.nodes.find(n=>n.z===1),id:999});assert.throws(()=>A.execute(ambiguous,[{action:'extrude-edges',nodes:[1,2],pid:1,vector:[0,0,2],layers:2,reuse:true,tolerance:1e-7}]),/Ambiguous/);
});
test('internal solid face extraction deduplicates shared facets and keeps exact node topology',()=>{
  const solid=extrude().mesh;solid.elements=solid.elements.filter(e=>e.type==='CHEXA');
  const f=A.facets(solid).filter(f=>f.uses===2);assert.equal(f.length,2);
  const r=A.execute(solid,[{action:'shells-on-faces',facets:f.map(({element,face})=>({element,face})),pid:1}]);
  assert.equal(r.nodes.length,0);assert.equal(r.elements.length,1);assert.deepEqual([...r.elements[0].nodes].sort(),[...f[0].nodes].sort());
});
test('invalid connectivity, degenerate extrusion, duplicates, offsets, limits and unknown actions fail without mutation',()=>{
  const m=plate(),before=JSON.stringify(m);
  for(const step of [
    {action:'create-elements',type:'CQUAD4',pid:1,connectivity:[[1,3,2,4]]},
    {action:'create-elements',type:'CQUAD4',pid:1,connectivity:[[1,2,3,4]]},
    {action:'create-elements',type:'CTRIA3',pid:1,connectivity:[[1,2,99]]},
    {action:'extrude-shells',elements:[1],pid:2,vector:[1,0,0],layers:1},
    {action:'extrude-shells',elements:[1],pid:2,vector:[0,0,1],layers:0},
    {action:'nope'}])assert.throws(()=>A.execute(m,[step]));
  assert.equal(JSON.stringify(m),before);m.elements[0].zoffs=.1;assert.throws(()=>A.execute(m,[{action:'extrude-shells',elements:[1],pid:2,vector:[0,0,1],layers:1}]),/zero offset/);
});
test('authored solids and reference shells persist separately; active element loads block exclusion',()=>{
  const s=semantic(),b=P.build({id:'solid',name:'Extrusion',steps:[{action:'extrude-shells',elements:[1],pid:2,vector:[0,0,2],layers:2}],excludeElements:[1]},null,s,{node:10,element:10}),a=O.preview(s,null,b.request);
  assert.equal(a.semantic.elems.quad.length,1);assert.equal(a.semantic.elems.hex.length,2);assert.deepEqual(O.analysisExclusions(a.ownership,a.semantic),[1]);
  const loaded=copy(s);loaded.loads.pload4=[{sid:1,eid:1,p:[1,1,1,1]}];assert.throws(()=>O.preview(loaded,null,b.request),/Repair loads/);
  const edit=copy(a.semantic);edit.elems.quad[0].n=[1,4,3,2];assert.throws(()=>O.guard(a.ownership,a.semantic,edit),/explicit mesh input/);
  const restore=copy(a.ownership.project.objects.find(o=>o.id==='solid'));restore.definition.analysisExcluded=[];const included=O.preview(a.semantic,a.ownership,{objects:[restore]});assert.deepEqual(O.analysisExclusions(included.ownership,included.semantic),[]);
  const remove=O.preview(a.semantic,a.ownership,P.removal(a.ownership,'solid'));assert.deepEqual(remove.semantic.elems.quad,s.elems.quad);assert.equal(remove.semantic.elems.hex.length,0);
});
test('plain deck node/element selections remain usable but are protected from identity drift',()=>{
  const s=semantic();const b=P.build({id:'manual',name:'Triangular overlay',steps:[{action:'create-elements',type:'CTRIA3',connectivity:[[1,2,3]],pid:1}]},null,s,{element:10});
  const a=O.preview(s,null,b.request),edit=copy(a.semantic);edit.nodes[0][1].x=1;
  assert.throws(()=>O.guard(a.ownership,a.semantic,edit),/explicit mesh input/);assert.equal(a.ownership.owners.length,1);
});

test('extruded wedges work in the common connectivity checker, pattern and BDF helper',()=>{
  const M=require('../app/modeling.js'),mesh=extrude(true).mesh;mesh.elements=mesh.elements.filter(e=>e.type==='CPENTA');
  const check=M.validateMesh(mesh);assert.equal(check.valid,true,check.errors.join('; '));assert.ok(M.toBdf(mesh).includes('CPENTA,'));
  const pattern=M.linearPattern(mesh,{counts:[2,1,1],vectors:[[10,0,0],[0,0,0],[0,0,0]],startNode:100,startElement:100});assert.equal(pattern.elements.length,mesh.elements.length*2);assert.equal(M.validateMesh(pattern).valid,true);
});
