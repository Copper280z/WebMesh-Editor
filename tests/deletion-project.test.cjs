const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const D=require('../app/deletion-project.js'),O=require('../app/engine-ownership.js'),C=require('../app/cad-project.js'),P=require('../app/part-project.js'),H=require('../app/hex-mapping.js'),Mount=require('../app/attachment-project.js'),Regions=require('../app/mesh-region-project.js'),Selections=require('../app/selection-project.js'),Analysis=require('../app/analysis-project.js'),Core=require('../app/project.js'),Replacement=require('../app/cad-replacement.js'),Assembly=require('../app/assembly-project.js'),Mass=require('../app/mass-project.js'),Coordinates=require('../app/coordinate-project.js');
const copy=x=>JSON.parse(JSON.stringify(x)),fixture=JSON.parse(fs.readFileSync(require.resolve('./fixtures/mapping/box.json'))),topo=fixture.topology;
const empty=()=>O.snapshot({nodes:new Map(),elems:{hex:[],tri:[],quad:[],bush:[],rbe2:[],rbe3:[]},properties:new Map(),materials:new Map(),coords:new Map(),masses:new Map(),loads:{},spc:[],spc1:[],temperatures:[]});
const ids=s=>Object.fromEntries(['node','element','property','material','coordinate'].map(ns=>[ns,Math.max(1,...(s?.project.reservations||[]).filter(r=>r.namespace===ns).map(r=>r.end+1))]));
function apply(a,request){const active=Replacement.active(a?.ownership,request),s=active.state;let r=active.request;r=P.rebuild(s,r,ids(a?.ownership));r=P.scopedRegions(s,r);r=Regions.rebuild(s,Selections.project(s,a?.semantic||empty(),r).semantic,r);r=Mount.rebuild(s,r);r=Assembly.rebuild(s,r,ids(a?.ownership));r=Mass.rebuild(s,r);r=Analysis.rebuild(s,r);r=Coordinates.rebuild(s,r);return O.preview(a?.semantic||empty(),a?.ownership,active.merge(r));}
async function model(){
 const snapshot={filename:'box.step',content:btoa('STEP'),prepared:{filename:'box.brep',format:'brep',content:btoa('BREP')}};
 const src={id:'source',kind:'source',name:'Box CAD',definition:{generator:'cad-source-v1',geometryKey:await C.geometryFingerprint(topo),topology:topo,snapshot,cards:[]}},part=P.part({id:'part',name:'Box',source:'source'},{project:{objects:[src]}}).objects[0];let a=apply(null,{objects:[src,part]});
 const analysis=H.analyze(topo),intervals=H.solveIntervals(analysis,{size:3}),mesh=H.generateMesh(analysis,intervals,H.createGeometry(topo,fixture.preview),{order:1});
 a=apply(a,(await C.build({id:'mesh',name:'Block mesh',part:'part',topology:topo,snapshot,volumes:[1],settings:{version:2,mesh:{method:'mapped'},sizing:{size:3,edges:[]}},mesh},a.ownership,ids(a.ownership))).request);
 a=apply(a,Mount.region({id:'mount',name:'End mounting face',mesh:'mesh',faces:[1]},a.ownership));
 a=apply(a,P.instance({id:'instance',name:'Copy',part:'part',transform:{translation:[10,0,0]}},a.ownership,ids(a.ownership)));
 a=apply(a,P.region({id:'copy-mount',name:'Copy mount',instance:'instance',region:'mount'},a.ownership));return a;
}
const object=(a,id)=>a.ownership.project.objects.find(o=>o.id===id);
const deletion=(a,options)=>D.build(a.ownership,options,a.semantic);
test('delete source part and keep dependents promotes meshes, instances and regions without changing cards',async()=>{
 const a=await model(),before=JSON.stringify(a),built=deletion(a,{id:'part'}),b=apply(a,built.request);assert.equal(JSON.stringify(a),before);
 assert.equal(object(b,'part'),undefined);assert.equal(object(b,'source'),undefined);assert.equal(object(b,'instance/unique').kind,'part');assert.equal(object(b,'instance/mesh').definition.generator,P.COPY);assert.equal(object(b,'mesh').definition.generator,P.COPY);
 assert.equal(object(b,'mount').definition.generator,Regions.GENERATOR);assert.equal(object(b,'copy-mount').definition.scope,undefined);assert.deepEqual([...O.rows(b.semantic)].sort(),[...O.rows(a.semantic)].sort());assert.ok(Core.restore(b.ownership.project).readiness().allowed);O.validate(copy(b.ownership),copy(b.semantic));
 const c=apply(b,P.instance({id:'new-copy',name:'Copy independent part',part:'instance/unique',transform:{translation:[0,10,0]}},b.ownership,ids(b.ownership)));assert.equal(c.semantic.elems.hex.length,b.semantic.elems.hex.length*1.5);
});
test('mixed choices remove source mesh, preserve placement, and suspend only missing source selections',async()=>{
 const a=await model(),built=deletion(a,{id:'part',choices:{mesh:'delete'}}),b=apply(a,built.request);
 assert.equal(object(b,'mesh'),undefined);assert.ok(object(b,'mount').facts.suspendedReason);assert.ok(!object(b,'copy-mount').facts.suspendedReason);assert.ok(!object(b,'instance/unique').facts.suspendedReason);assert.equal(b.semantic.elems.hex.length,a.semantic.elems.hex.length/2);assert.equal(Core.restore(b.ownership.project).readiness().allowed,false);
});
test('delete all includes scoped regions and reclaims only unused owned materials and sections',async()=>{
 const a=await model(),b=apply(a,deletion(a,{id:'part',mode:'delete'}).request);assert.equal(b.semantic.nodes.length,0);assert.equal(b.semantic.elems.hex.length,0);assert.equal(b.semantic.properties.length,0);assert.equal(b.semantic.materials.length,0);assert.equal(b.ownership.project.objects.length,0);
 const kept=apply(a,deletion(a,{id:'part',mode:'delete',choices:{instance:'keep','copy-mount':'keep'}}).request);assert.ok(kept.semantic.properties.length);assert.ok(kept.semantic.materials.length);assert.ok(!object(kept,'copy-mount').facts.suspendedReason);
});
test('hand card references block deletion and are never silently removed',async()=>{
 const a=await model();a.semantic.loads.force=[{sid:99,nid:a.semantic.elems.hex[0].n[0],mag:1,cid:0,dir:[1,0,0]}];assert.throws(()=>apply(a,deletion(a,{id:'part',mode:'delete'}).request),/Dangling reference/);
});
test('kept attachment is named independent and repairable after missing mounting nodes are replaced explicitly',async()=>{
 let a=await model();a=apply(a,Mount.attachment({id:'motor',name:'Motor',region:'mount',mount:[-1,1,1],shaft:[-5,1,1],components:'123',newTemplate:{id:'stiffness',name:'Motor stiffness',stiffness:[1e5,1e5,1e5,1e4,1e4,1e4]}},a.ownership,ids(a.ownership)));
 const b=apply(a,deletion(a,{id:'part',choices:{mesh:'delete',mount:'delete'}}).request);assert.equal(object(b,'motor').definition.generator,D.GENERATOR);assert.ok(object(b,'motor').facts.suspendedReason);assert.equal(b.semantic.elems.bush.length,0);
 const cards=copy(object(b,'motor').definition.cards),mapping=new Map(object(a,'instance/mesh').definition.mapping.nodes);cards.find(c=>c.value.type==='RBE2').value.deps=cards.find(c=>c.value.type==='RBE2').value.deps.map(id=>mapping.get(id));
 const repaired=apply(b,D.edit(b.ownership,'motor',{name:'Motor',cards},b.semantic));assert.equal(repaired.semantic.elems.bush.length,1);assert.ok(!object(repaired,'motor').facts.suspendedReason);assert.equal(object(repaired,'motor').definition.cards[0].id,object(a,'motor').definition.cards[0].id);
});
test('delete assembly recipe keeps parameterized connections with private recipes and stable element IDs',async()=>{
 let a=await model();a=apply(a,Assembly.template({id:'recipe',name:'NEMA17',parameters:{mount:[-1,1,1],shaft:[-5,1,1]}},a.ownership,ids(a.ownership)));a=apply(a,Assembly.connection({id:'motor',name:'Motor',template:'recipe',region:'mount'},a.ownership,ids(a.ownership)));
 const b=apply(a,deletion(a,{id:'recipe'}).request);assert.equal(object(b,'recipe'),undefined);assert.equal(object(b,'motor').definition.generator,Assembly.CONNECTION);assert.equal(object(b,'motor').definition.template,'motor/recipe');assert.ok(object(b,'motor/recipe'));assert.deepEqual(b.semantic.elems.rbe2,a.semantic.elems.rbe2);assert.equal(b.semantic.elems.bush[0].eid,a.semantic.elems.bush[0].eid);
});
test('previously suspended replacement drafts can be deleted with kept definitions still suspended',async()=>{
 const a=await model(),src=object(a,'source'),request=Replacement.build(a.ownership,{part:'part',topology:topo,before:topo,snapshot:src.definition.snapshot,geometryKey:src.definition.geometryKey,revisionId:'replacement',selective:false}),s=apply(a,request);
 const b=apply(s,deletion(s,{id:'part'}).request);assert.equal(object(b,'source'),undefined);assert.equal(b.semantic.elems.hex.length,0);assert.ok(object(b,'mount').facts.suspendedReason);O.validate(copy(b.ownership),b.semantic);
});
test('kept analysis case remains named, suspended and excluded from case control until repaired',async()=>{
 let a=await model();a=apply(a,Analysis.set({id:'support',name:'Support',action:'support',region:'mount',components:'123'},a.ownership,a.semantic));a=apply(a,Analysis.set({id:'gravity',name:'Gravity',action:'acceleration',vector:[0,0,-9810]},a.ownership,a.semantic));a=apply(a,Analysis.caseObject({id:'case',name:'Gravity case',load:1,support:1,outputs:['DISPLACEMENT']},a.ownership,a.semantic));
 const b=apply(a,deletion(a,{id:'part',choices:{mesh:'delete'}}).request);assert.equal(b.semantic.spc1.length,0);assert.ok(object(b,'support').facts.suspendedReason);assert.ok(object(b,'case').facts.suspendedReason);assert.equal(Analysis.caseControl(b.ownership),'');
});
test('public independent editing retains IDs and rejects absent inputs or invalid card identity',async()=>{
 const a=await model(),b=apply(a,deletion(a,{id:'part'}).request),o=object(b,'mesh'),cards=copy(o.definition.cards);cards[0].value.x+=2;
 assert.throws(()=>apply(b,D.edit(b.ownership,'mesh',{name:'Mesh',cards},b.semantic)),/Repair its selection/);cards[0].value.x-=2;const n=cards.find(c=>c.family==='nodes'&&!object(b,'mount').definition.resolved.nodes.includes(c.id));n.value.x+=1;
 const c=apply(b,D.edit(b.ownership,'mesh',{name:'Edited independent mesh',cards},b.semantic));assert.equal(object(c,'mesh').name,'Edited independent mesh');assert.equal(c.semantic.nodes.find(([id])=>id===n.id)[1].x,n.value.x);
 cards.find(c=>c.family==='elems').value.pid=999;assert.throws(()=>D.edit(b.ownership,'mesh',{name:'Mesh',cards},b.semantic),/Missing inputs/);
});
test('kept source mesh preserves reference-only analysis participation independently of its deleted part',async()=>{
 let a=await model();a=apply(a,P.sourceReference(a.ownership,'part',true));const excluded=O.analysisExclusions(a.ownership,a.semantic);
 const b=apply(a,deletion(a,{id:'part'}).request);assert.deepEqual([...O.analysisExclusions(b.ownership,b.semantic)].sort(),[...excluded].sort());assert.equal(object(b,'part/source-participation'),undefined);
});
test('real rover: deleting wheel source keeps four independent wheels, motor connections, support sets and cases valid',()=>{
 const zlib=require('node:zlib'),file=JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('../docs/design/validation/project-workspace/rover-remesh.webmesh.gz')))),a={ownership:file.ownership,semantic:empty()};O.putAll(a.semantic,a.ownership.owners.map(e=>e.card));
 // The fixture's hand-authored LOAD combination must survive unchanged.
 assert.match(file.deck,/LOAD,3,1\.,1\.,1,1\.,2/);a.semantic.loads.load=[{type:'LOAD',sid:3,scale:1,entries:[{lid:1,scale:1},{lid:2,scale:1}]}];O.validate(a.ownership,a.semantic);
 const source=a.ownership.project.objects.find(o=>P.isPart(o)&&o.name==='wheel'),placements=a.ownership.project.objects.filter(o=>P.isInstance(o)&&o.definition.part===source.id);
 const b=apply(a,deletion(a,{id:source.id}).request);assert.equal(placements.length,4);for(const p of placements){assert.ok(object(b,p.id+'/unique'));assert.deepEqual(object(b,p.id+'/mesh').definition.cards,object(a,p.id+'/mesh').definition.cards);}assert.equal(b.semantic.elems.bush.length,4);assert.equal(b.semantic.masses.length,a.semantic.masses.length);assert.equal(Analysis.caseControl(b.ownership),Analysis.caseControl(a.ownership));assert.ok(Core.restore(b.ownership.project).readiness().allowed);assert.deepEqual([...O.analysisExclusions(b.ownership,b.semantic)].sort(),[...O.analysisExclusions(a.ownership,a.semantic)].sort());
});
