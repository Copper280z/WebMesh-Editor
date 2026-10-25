const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const R=require('../app/cad-replacement.js'),O=require('../app/engine-ownership.js'),C=require('../app/cad-project.js'),P=require('../app/part-project.js'),H=require('../app/hex-mapping.js'),Mount=require('../app/attachment-project.js'),Regions=require('../app/mesh-region-project.js'),Selections=require('../app/selection-project.js'),Analysis=require('../app/analysis-project.js'),Core=require('../app/project.js');
const copy=x=>JSON.parse(JSON.stringify(x)),fixture=JSON.parse(fs.readFileSync(require.resolve('./fixtures/mapping/box.json'))),topo=fixture.topology;
const empty=()=>O.snapshot({nodes:new Map(),elems:{hex:[],tri:[],quad:[],bush:[],rbe2:[],rbe3:[]},properties:new Map(),materials:new Map(),coords:new Map(),masses:new Map(),loads:{},spc:[],spc1:[],temperatures:[]});
const snapshot={filename:'box.step',content:btoa('STEP'),prepared:{filename:'box.brep',format:'brep',content:btoa('BREP')}};
const ids=s=>Object.fromEntries(['node','element','property','material','coordinate'].map(ns=>[ns,Math.max(1,...(s?.project.reservations||[]).filter(r=>r.namespace===ns).map(r=>r.end+1))]));
function input(size=3){const a=H.analyze(topo),intervals=H.solveIntervals(a,{size});return {id:'mesh',name:'Block mesh',part:'part',topology:topo,snapshot,volumes:[1],settings:{version:2,mesh:{method:'mapped'},sizing:{size,edges:[]}},mesh:H.generateMesh(a,intervals,H.createGeometry(topo,fixture.preview),{order:1})};}
function apply(a,request){const active=R.active(a?.ownership,request),s=active.state;let r=active.request;r=P.rebuild(s,r,ids(a?.ownership));r=P.scopedRegions(s,r);r=Regions.rebuild(s,Selections.project(s,a?.semantic||empty(),r).semantic,r);r=Mount.rebuild(s,r);r=Analysis.rebuild(s,r);return O.preview(a?.semantic||empty(),a?.ownership,active.merge(r));}
async function model(){const src={id:'source',kind:'source',name:'Box CAD',definition:{generator:'cad-source-v1',geometryKey:await C.geometryFingerprint(topo),topology:topo,snapshot,cards:[]}},part=P.part({id:'part',name:'Box',source:'source'},{project:{objects:[src]}}).objects[0];let a=apply(null,{objects:[src,part]});a=apply(a,(await C.build(input(),a.ownership,ids(a.ownership))).request);a=apply(a,Mount.region({id:'mount',name:'End mounting face',mesh:'mesh',faces:[1]},a.ownership));a=apply(a,Mount.attachment({id:'motor',name:'Motor',region:'mount',mount:[-1,1,1],shaft:[-5,1,1],components:'123',newTemplate:{id:'stiffness',name:'Motor stiffness',stiffness:[1e5,1e5,1e5,1e4,1e4,1e4]}},a.ownership,ids(a.ownership)));a=apply(a,P.instance({id:'instance',name:'Copy',part:'part',transform:{translation:[10,0,0]}},a.ownership,ids(a.ownership)));return a;}
async function replace(a,changes={}){return R.build(a.ownership,{part:'part',topology:topo,before:topo,snapshot,geometryKey:await C.geometryFingerprint(topo),revisionId:'revision-2',selective:false,...changes});}
test('topology correspondence ignores IDs, requires unique geometry and adjacency, and never guesses moved entities',()=>{
 const b=copy(topo);for(const e of b.edges){e.id+=100;e.faces=e.faces.map(n=>n+100);}for(const f of b.faces){f.id+=100;f.edges=f.edges.map(n=>n+100);f.volumes=f.volumes.map(n=>n+100);}for(const v of b.volumes){v.id+=100;v.faces=v.faces.map(n=>n+100);}
 const matched=R.match(topo,b);assert.ok(matched.length>10);assert.ok(matched.every(r=>r.status==='exact'&&r.target===r.id+100));
 b.faces.push({...copy(b.faces[0]),id:999});assert.equal(R.match(topo,b).find(r=>r.family==='faces'&&r.id===topo.faces[0].id).status,'ambiguous');
 b.faces.shift();b.faces.find(f=>f.id===999).center[0]+=30;const moved=R.match(topo,b).find(r=>r.family==='faces'&&r.id===topo.faces[0].id);assert.equal(moved.target,null);assert.equal(moved.status,'missing');assert.ok(moved.candidates.some(c=>c.id===999));
 const unknown=R.match({faces:[{id:1,type:'Plane'}]}, {faces:[{id:2,type:'Plane'}]});assert.equal(unknown[0].target,null);
});
test('replacement suspends mesh, mount and placement cards atomically, preserves definitions and blocks analysis',async()=>{
 const a=await model(),before=JSON.stringify(a),request=await replace(a),b=apply(a,request);
 assert.equal(JSON.stringify(a),before);assert.equal(b.semantic.elems.hex.length,0);assert.equal(b.semantic.elems.rbe2.length,0);assert.equal(b.semantic.elems.bush.length,0);
 for(const id of ['mesh','mount','motor','instance','instance/mesh'])assert.ok(b.ownership.project.objects.find(o=>o.id===id).facts.suspendedReason,id);
 assert.deepEqual(b.ownership.project.objects.find(o=>o.id==='motor').definition,a.ownership.project.objects.find(o=>o.id==='motor').definition);
 assert.equal(Core.restore(b.ownership.project).readiness().allowed,false);assert.equal(b.ownership.project.reservations.length,a.ownership.project.reservations.length);
 assert.throws(()=>R.resume(b.ownership,'motor'),/Repair .* first/);
 const stale=copy(b.ownership.project.objects.find(o=>o.id==='mesh'));stale.facts.suspendedReason=null;stale.definition.geometryKey='old';assert.throws(()=>apply(b,{objects:[stale]}),/remesh on the current/);
 const loaded=copy(a),grid=a.semantic.elems.hex[0].n[0];loaded.semantic.loads.force=[{sid:99,nid:grid,mag:1,cid:0,dir:[1,0,0]}];assert.throws(()=>apply(loaded,request),/Dangling reference/);
});
test('independent remesh and explicit reactivation recover regions, motor and live instance with stable author identities',async()=>{
 const a=await model();let b=apply(a,await replace(a));b=apply(b,(await C.build(input(2),b.ownership,ids(b.ownership))).request);
 assert.ok(b.semantic.elems.hex.length>0);assert.equal(b.semantic.elems.bush.length,0);assert.ok(b.ownership.project.objects.find(o=>o.id==='instance').facts.suspendedReason);
 b=apply(b,R.resume(b.ownership,'mount'));b=apply(b,R.resume(b.ownership,'motor'));b=apply(b,R.resume(b.ownership,'instance'));
 assert.equal(Core.restore(b.ownership.project).readiness().allowed,true);assert.deepEqual(b.semantic.elems.bush,a.semantic.elems.bush);assert.equal(b.semantic.elems.rbe2[0].eid,a.semantic.elems.rbe2[0].eid);assert.notDeepEqual(b.semantic.elems.rbe2[0].deps,a.semantic.elems.rbe2[0].deps);
 assert.equal(b.semantic.elems.hex.length,2*b.ownership.project.objects.find(o=>o.id==='mesh').definition.cards.filter(c=>c.family==='elems').length);
 O.validate(JSON.parse(JSON.stringify(b.ownership)),b.semantic);
});
test('missing selection stays suspended until explicit rebind; duplicates and stale replacement choices reject',async()=>{
 const a=await model(),next=copy(topo);next.faces[0].center[0]+=30;const request=await replace(a,{topology:next,geometryKey:'changed'}),region=request.objects.find(o=>o.id==='mount');assert.match(region.facts.suspendedReason,/explicit repair/);assert.notEqual(region.definition.selector.geometryKey,'changed');
 await assert.rejects(replace(a,{choices:{'faces:1':999}}),/existing replacement/);
 const confirmed=await replace(a,{topology:next,geometryKey:'changed',choices:{'faces:1':1}});assert.equal(confirmed.objects.find(o=>o.id==='mount').definition.selector.geometryKey,'changed');
});
test('suspended support sets and cases survive save validation but produce no runnable case control',async()=>{
 let a=await model();a=apply(a,Mount.region({id:'support-face',name:'Support face',mesh:'mesh',faces:[2]},a.ownership));a=apply(a,Analysis.set({id:'support',name:'Mount support',action:'support',region:'support-face',components:'456'},a.ownership,a.semantic));a=apply(a,Analysis.set({id:'gravity',name:'Gravity',action:'acceleration',vector:[0,0,-9810]},a.ownership,a.semantic));a=apply(a,Analysis.caseObject({id:'case',name:'Gravity case',load:1,support:1,outputs:['DISPLACEMENT']},a.ownership,a.semantic));
 const b=apply(a,await replace(a));assert.equal(b.semantic.spc1.length,0);assert.equal(Analysis.caseControl(b.ownership),'');assert.ok(!Analysis.projectDeck('SOL 101\nCEND\nSUBCASE 1\n  SPC = 1\nBEGIN BULK\nENDDATA\n',b.ownership).includes('SPC ='));O.validate(b.ownership,b.semantic);
});

 test('selective replacement retains exact solid meshes, instances and attachment card identities',async()=>{
 const a=await model(),b=apply(a,await replace(a,{selective:true}));assert.deepEqual([...O.rows(b.semantic)].sort(),[...O.rows(a.semantic)].sort());assert.ok(Core.restore(b.ownership.project).readiness().allowed);assert.ok(!b.ownership.project.objects.some(o=>o.facts.suspendedReason));
 });
