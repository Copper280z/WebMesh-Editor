const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),z=require('node:zlib');
const H=require('../app/hex-mapping.js'),L=require('../app/cad-local-mesh.js'),C=require('../app/cad-project.js'),O=require('../app/engine-ownership.js');
const {apply,ids}=require('./helpers/project-actions.cjs');
const data=JSON.parse(z.gunzipSync(fs.readFileSync(require.resolve('./fixtures/flexure-hex/complete.json.gz'))));
const a=H.analyze(data.topology),g=H.createGeometry(data.topology,data.preview),targets=[...a.volumes.keys()];
const settings=order=>({version:2,step:'mesh',sizing:{size:1,minCount:1,edges:[],solids:[]},mesh:{method:'mapped',order,scope:'affected',pidPerSolid:false,solidMethods:[]}});
const generate=(s,volumes)=>H.generateMesh(a,L.solve(a,s),g,{order:s.mesh.order,volumes,solidMethods:s.mesh.solidMethods});
function interfaces(mesh){
  const byVolume=new Map();for(const e of mesh.elements){if(!byVolume.has(e.volume))byVolume.set(e.volume,[]);byVolume.get(e.volume).push(e);}
  let n=0;for(const f of data.topology.faces.filter(f=>f.volumes.length===2)){
    const [x,y]=f.volumes.map(v=>L.faceSignatures(byVolume.get(v),mesh.faceNodes[f.id]));
    assert.ok(x.length,'nonempty interface '+f.id);assert.deepEqual(x,y,'shared CAD face '+f.id);n++;
  }assert.equal(n,297);return n;
}
function ownedMesh(d){const volume=new Map(d.volumeElements.flatMap(v=>v.elements.map(e=>[e,v.id])));return {nodes:d.cards.filter(c=>c.family==='nodes').map(c=>({id:c.id,...c.value})),elements:d.cards.filter(c=>c.family==='elems').map(c=>({id:c.id,volume:volume.get(c.id),nodes:c.value.n})),faceNodes:Object.fromEntries(d.faces.map(f=>[f.id,f.nodes]))};}
const definition=x=>x.ownership.project.objects.find(o=>o.id==='mesh').definition;
function input(s,mesh,volumes=targets){return {id:'mesh',name:'Flexure',kind:'solid',snapshot:{filename:'flexure.step',content:btoa('STEP'),prepared:{filename:'prepared.brep',format:'brep',content:btoa('BREP')}},topology:data.topology,settings:s,volumes,mesh};}

test('O-grid selects a complete circular cap stack and rejects unsuitable solids or mismatched methods',()=>{
  assert.deepEqual([...H.circularCores(a).keys()],[125,130,135,140,145,150,155,161]);
  assert.deepEqual(H.coreStack(a,145),[145,150,155,161]);
  assert.throws(()=>H.setSolidMethod(a,[],[146],{method:'ogrid'}),/circular core/);
  assert.throws(()=>H.setSolidMethod(a,[],[145],{method:'ogrid',radialLayers:0}),/radial layers/);
  assert.throws(()=>H.setSolidMethod(a,[],[145],{method:'ogrid',coreRatio:1}),/radius ratio/);
  assert.throws(()=>H.planMethods(a,[{id:145,method:'ogrid'}]),/cap neighbor/);
  assert.throws(()=>H.planMethods(a,[{id:145,method:'made-up'}]),/Unknown/);
  const m=H.setSolidMethod(a,[],[145],{method:'ogrid'});
  assert.throws(()=>L.validateMethods(data.topology,{mesh:{solidMethods:m}},[145]),/same mesh region/);
  const next=H.setSolidMethod(a,m,[150],{method:'mapped'});assert.ok(next.every(r=>r.method==='mapped'));assert.equal(next.filter(r=>r.direct)[0].id,150);
});

for(const order of [1,2])test('HEX'+(order===1?8:20)+' O-grid improves circular cores, preserves every exterior interface, and supports reversible local switching',async()=>{
  const before=settings(order),base=generate(before),after=structuredClone(before);
  after.mesh.solidMethods=H.setSolidMethod(a,[],[145],{method:'ogrid'});
  const scope=[145,150,155,161],full=generate(after);interfaces(full);
  assert.equal(full.quality.inverted,0);
  for(const id of scope){const p=full.quality.perVolume.find(v=>v.volume===id),b=base.quality.perVolume.find(v=>v.volume===id);assert.equal(p.blocks,5);assert.ok(p.minScaledJacobian>.5);assert.ok(p.minScaledJacobian>b.minScaledJacobian);}
  const impact=L.impact(a,before,after,targets);assert.deepEqual(impact.affected,scope);assert.deepEqual(impact.direct,[145]);assert.deepEqual(impact.propagated,[150,155,161]);assert.equal(impact.changedEdges.length,0);
  const original=apply(null,(await C.build(input(before,base),null,ids())).request);
  const patch=generate(after,scope),built=await C.build({...input(after,patch,scope),localRemesh:true},original.ownership,ids(original.ownership));
  const applied=apply(original,built.request),d=definition(applied);interfaces(ownedMesh(d));
  const removed=new Set(definition(original).volumeElements.filter(v=>scope.includes(v.id)).flatMap(v=>v.elements));
  const retained=definition(original).cards.filter(c=>c.family==='elems'&&!removed.has(c.id)),keepNodes=new Set(retained.flatMap(c=>c.value.n));
  const actual=new Map(d.cards.map(c=>[c.family+':'+c.id,c]));
  for(const c of definition(original).cards)if(c.family==='elems'?!removed.has(c.id):keepNodes.has(c.id))assert.deepEqual(actual.get(c.family+':'+c.id),c);
  assert.equal(built.localRemesh.retainedElements,retained.length);
  O.validate(JSON.parse(JSON.stringify(applied.ownership)),structuredClone(applied.semantic));
  const reopened=C.restoreData(applied.ownership,'mesh');assert.deepEqual(reopened.settings.mesh.solidMethods,after.mesh.solidMethods);
  const back=structuredClone(after);back.mesh.solidMethods=H.setSolidMethod(a,back.mesh.solidMethods,[150],{method:'mapped'});
  const restored=apply(applied,(await C.build({...input(back,generate(back,scope),scope),localRemesh:true},applied.ownership,ids(applied.ownership))).request);
  interfaces(ownedMesh(definition(restored)));assert.equal(definition(restored).cards.filter(c=>c.family==='elems').length,base.elements.length);
  const resized=structuredClone(after);resized.mesh.solidMethods=H.setSolidMethod(a,resized.mesh.solidMethods,[145],{method:'ogrid',coreRatio:.6,radialLayers:3});
  assert.deepEqual(L.impact(a,after,resized,targets).affected,scope);interfaces(generate(resized));
  await assert.rejects(C.build({...input(after,generate(after,[145]),[145]),localRemesh:true},original.ownership,ids(original.ownership)),/every dependent solid/);
});
