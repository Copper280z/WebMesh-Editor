const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),z=require('node:zlib');
const H=require('../app/hex-mapping.js'),L=require('../app/cad-local-mesh.js'),C=require('../app/cad-project.js'),O=require('../app/engine-ownership.js');
const {apply,ids}=require('./helpers/project-actions.cjs');
const data=JSON.parse(fs.readFileSync(require.resolve('./fixtures/mapping/split-box.json'))),analysis=H.analyze(data.topology),geometry=H.createGeometry(data.topology,data.preview),clone=structuredClone;
const settings=order=>({version:2,step:'mesh',sizing:{size:2,minCount:1,edges:[],solids:[]},mesh:{method:'mapped',order,scope:'all',pidPerSolid:false}});
function input(s,volumes=[1,2]){return {id:'mesh',name:'Two blocks',kind:'solid',snapshot:{filename:'two.step',content:btoa('STEP'),prepared:{filename:'two.brep',format:'brep',content:btoa('BREP')}},topology:data.topology,settings:s,volumes,mesh:H.generateMesh(analysis,L.solve(analysis,s),geometry,{order:s.mesh.order,volumes})};}
function edgeAlong(volume,axis){return L.edgesOf(analysis,volume).find(id=>{const e=analysis.index.edges.get(id),[a,b]=e.vertices.map(v=>analysis.index.vertices.get(v));return Math.abs(b[axis]-a[axis])>1&&a.every((x,i)=>i===axis||Math.abs(x-b[i])<1e-8);});}
const root=a=>a.ownership.project.objects.find(o=>o.id==='mesh');
for(const order of [1,2])test('local HEX'+(order===1?8:20)+' remesh retains the other block and its exact shared quadrilateral interface',async()=>{
  const before=settings(order),original=input(before),a=apply(null,(await C.build(original,null,ids())).request),old=clone(a),after=clone(before);after.sizing.edges=[{id:edgeAlong(1,0),count:4}];
  const impact=L.impact(analysis,before,after,[1,2]);assert.deepEqual(impact.affected,[1]);
  const patch={...input(after,impact.affected),localRemesh:true},built=await C.build(patch,a.ownership,ids(a.ownership)),b=apply(a,built.request);
  assert.deepEqual(a,old,'candidate does not mutate the committed state');
  const keep=root(a).definition.volumeElements.find(v=>v.id===2).elements,oldCards=root(a).definition.cards,newCards=new Map(root(b).definition.cards.map(c=>[c.family+':'+c.id,c]));
  const nodeKeep=new Set(oldCards.filter(c=>c.family==='elems'&&keep.includes(c.id)).flatMap(c=>c.value.n));
  for(const c of oldCards)if(c.family==='elems'?keep.includes(c.id):nodeKeep.has(c.id))assert.deepEqual(newCards.get(c.family+':'+c.id),c);
  assert.equal(built.localRemesh.retainedElements,keep.length);assert.equal(built.localRemesh.retainedNodes,nodeKeep.size);
  const face=root(b).definition.faces.find(f=>f.id===2),elems=volume=>root(b).definition.volumeElements.find(v=>v.id===volume).elements.map(id=>{const c=newCards.get('elems:'+id);return {nodes:c.value.n};});
  assert.deepEqual(L.faceSignatures(elems(1),face.nodes),L.faceSignatures(elems(2),face.nodes));
  assert.ok(L.faceSignatures(elems(1),face.nodes).length>0);
  O.validate(JSON.parse(JSON.stringify(b.ownership)),clone(b.semantic));
  const again=await C.build({...input(after,[1]),localRemesh:true},b.ownership,ids(b.ownership));assert.equal(again.localRemesh.retainedElements,keep.length,'saved provenance supports subsequent local remeshing');
  const legacy=clone(a.ownership);delete legacy.project.objects.find(o=>o.id==='mesh').definition.volumeElements;
  await assert.rejects(C.build(patch,legacy,ids(legacy)),/verified baseline/);
  const migrated=await C.build({...patch,baselineMesh:original.mesh},legacy,ids(legacy));assert.deepEqual(migrated.mesh,built.mesh);
  const bad=clone(original.mesh);bad.nodes[0].x+=1;await assert.rejects(C.build({...patch,baselineMesh:bad},legacy,ids(legacy)),/cannot be reproduced/);
});
test('count propagation includes dependent solids and rejects an incomplete remesh scope',async()=>{
  const before=settings(1),after=clone(before);after.sizing.edges=[{id:edgeAlong(1,1),count:5}];
  const p=L.impact(analysis,before,after,[1,2]);assert.deepEqual(p.affected,[1,2]);
  const a=apply(null,(await C.build(input(before),null,ids())).request);
  await assert.rejects(C.build({...input(after,[1]),localRemesh:true},a.ownership,ids(a.ownership)),/every dependent solid/);
  const b=apply(a,(await C.build({...input(after,[1,2]),localRemesh:true},a.ownership,ids(a.ownership))).request);O.validate(b.ownership,b.semantic);
});
test('solid sizes survive serialization, override global targets and yield to explicit edge sizes',()=>{
  const s=settings(1),edge=edgeAlong(1,0);s.sizing.solids=[{id:1,size:1}];
  let solved=L.solve(analysis,JSON.parse(JSON.stringify(s)));assert.equal(solved.counts.get(edge),4);
  s.sizing.edges=[{id:edge,size:2}];solved=L.solve(analysis,s);assert.equal(solved.counts.get(edge),2);
  s.sizing.edges=[{id:edge,count:7}];assert.equal(L.solve(analysis,s).counts.get(edge),7);
  assert.deepEqual(L.impact(analysis,s,clone(s),[1,2]).affected,[]);
});
test('local remesh rejects incompatible element order, changed geometry and falsified boundary connectivity',async()=>{
  const s=settings(2),a=apply(null,(await C.build(input(s),null,ids())).request),next=clone(s);next.sizing.edges=[{id:edgeAlong(1,0),count:4}];
  const good={...input(next,[1]),localRemesh:true},order=clone(good);order.settings.mesh.order=1;
  await assert.rejects(C.build(order,a.ownership,ids(a.ownership)),/complete region/);
  const moved=clone(good);moved.topology.vertices[0].point[0]+=1;await assert.rejects(C.build(moved,a.ownership,ids(a.ownership)),/unchanged CAD/);
  const cracked=clone(good),faceNodes=new Set(cracked.mesh.faceNodes[2]),element=cracked.mesh.elements.find(e=>e.nodes.filter(n=>faceNodes.has(n)).length>=8),index=element.nodes.findIndex((n,i)=>i>=8&&faceNodes.has(n)),old=element.nodes[index],node=clone(cracked.mesh.nodes.find(n=>n.id===old));node.id=100000;cracked.mesh.nodes.push(node);element.nodes[index]=node.id;
  await assert.rejects(C.build(cracked,a.ownership,ids(a.ownership)),/quadrilateral interface|quadratic boundary membership/);
});
test('flexure blade thickness refinement explains direct and propagated blocks without flagging the entire part',()=>{
  const f=JSON.parse(z.gunzipSync(fs.readFileSync(require.resolve('./fixtures/flexure-hex/prepared.json.gz')))),a=H.analyze(f.topology),s=settings(1);s.sizing.size=1;
  // Locate the horizontal right-hand 0.5 mm blade by its actual geometry.
  const blade=f.topology.volumes.find(v=>Math.abs(v.bounds[0]-5.5)<1e-4&&Math.abs(v.bounds[2]+9)<1e-4),edge=L.edgesOf(a,blade.id).find(e=>Math.abs(a.index.edges.get(e).length-.5)<1e-4);
  const next=clone(s);next.sizing.edges=[{id:edge,count:3}];const targets=[...a.volumes.values()].filter(v=>v.mappable).map(v=>v.id),p=L.impact(a,s,next,targets);
  assert.ok(p.direct.includes(blade.id));assert.ok(p.propagated.length>=1);assert.ok(p.unchanged.length>targets.length/2);assert.equal(L.solve(a,next).counts.get(edge),3);
});
