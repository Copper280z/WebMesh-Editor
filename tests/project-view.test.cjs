const {test}=require('node:test'),assert=require('node:assert/strict');
const V=require('../app/project-view.js'),R=require('../app/analysis-runs.js');
const object=(id,kind,definition={},name=id)=>({id,name,kind,dependsOn:[],definition});
const node=id=>({family:'nodes',id,value:{x:id,y:0,z:0}}),elem=(id,ns)=>({family:'elems',id,value:{eid:id,type:'CTRIA3',n:ns}});
function fixture(){
 const state={project:{objects:[object('part','part',{source:'cad'}),object('cad','source'),object('mesh','mesh',{part:'part',source:'cad',cards:[node(1),node(2),node(3),elem(10,[1,2,3])]}),object('copy','instance',{part:'part'}),object('copy/mesh','mesh',{part:'part',instance:'copy',cards:[node(4),node(5),elem(20,[2,4,5])]}),object('recipe','template'),object('joint','connection',{template:'recipe',cards:[{family:'elems',id:30,value:{eid:30,type:'RBE2',gn:6,deps:[2,4]}}]}),object('joint/points','point',{assemblyMember:'joint',cards:[node(6)]}),object('region','region',{resolved:{nodes:[2,4,5],elements:[20]}}),object('force','load',{cards:[{family:'loadSets',id:7,value:{sid:7}}]}),object('support','support',{cards:[{family:'constraintSets',id:8,value:{sid:8}}]})]}};
 const semantic={nodes:[1,2,3,4,5,6].map(n=>[n,{x:n,y:0,z:0}]),elems:{tri:[{eid:10,n:[1,2,3]},{eid:20,n:[2,4,5]}],rbe2:[{eid:30,type:'RBE2',gn:6,deps:[2,4]}]},masses:[]};return {state,semantic,index:V.build(state)};
}
test('hierarchy contains every object once, nests instances and connection members, and aggregates shared membership',()=>{
 const {index,state}=fixture();assert.equal(index.entries.size,state.project.objects.length+8);
 assert.equal(index.entries.get('cad').parent,'part');assert.equal(index.entries.get('copy/mesh').parent,'copy');assert.equal(index.entries.get('joint/points').parent,'joint');assert.equal(index.entries.get('joint').parent,'recipe');
 assert.deepEqual([...index.entries.get('part').members.elems].sort(),[10,20]);assert.equal(index.entries.get('part').members.nodes.size,5);assert.ok(index.entries.get('recipe').members.nodes.has(6));
});
test('hiding a source mesh retains a shared node used by visible structural/rigid elements',()=>{
 const {index,semantic}=fixture();const p=V.setVisibility(index,null,'mesh',false),mask=V.mask(index,p,semantic);
 assert.deepEqual([...mask.elems],[10]);assert.deepEqual([...mask.nodes].sort(),[1,3]);assert.ok(!mask.elems.has(20));assert.equal(V.rows(index,p,mask).find(r=>r.id==='part').visibility,'mixed');
});
test('part visibility propagates to placements and later children; local show can restore one placement',()=>{
 const {index,semantic,state}=fixture();let p=V.setVisibility(index,null,'part',false);p=V.setVisibility(index,p,'copy',true);let mask=V.mask(index,p,semantic);assert.ok(mask.elems.has(10)&&!mask.elems.has(20));
 state.project.objects.push(object('new-copy','instance',{part:'part'}),object('new-copy/mesh','mesh',{instance:'new-copy',cards:[elem(40,[7,8,9])]}));const next=V.build(state);assert.equal(V.inherited(next,p,'new-copy/mesh'),false);
});
test('isolate temporarily shows its target, hides unrelated entities and restores prior preferences unchanged',()=>{
 const {index,semantic}=fixture();const p=V.setVisibility(index,null,'copy',false),before=JSON.stringify(p),isolated=V.mask(index,{...p,isolate:'copy'},semantic);
 assert.ok(!isolated.elems.has(20));assert.ok(isolated.elems.has(10)&&isolated.elems.has(30));assert.ok(isolated.loads.has(7)&&isolated.spc.has(8));assert.equal(JSON.stringify(p),before);
 const restored=V.mask(index,p,semantic);assert.ok(restored.elems.has(20)&&!restored.elems.has(10));
});
test('display preferences follow owner identity through remeshing without retaining retired entity IDs',()=>{
 const {index,semantic,state}=fixture(),p=V.setVisibility(index,null,'mesh',false);state.project.objects.find(o=>o.id==='mesh').definition.cards=[node(101),node(102),node(103),elem(110,[101,102,103])];semantic.elems.tri[0]={eid:110,n:[101,102,103]};
 const mask=V.mask(V.build(state),p,semantic);assert.ok(mask.elems.has(110));assert.ok(!mask.elems.has(10));assert.deepEqual(Object.keys(p.objects),['mesh']);
});
test('explicit source display overrides the results default, without changing participation or model/run digests',async()=>{
 const {index,semantic,state}=fixture(),before=await R.digest(JSON.stringify(state)),excluded={elems:[10],nodes:[1,3]};
 assert.ok(V.mask(index,null,semantic,excluded).elems.has(10));const p=V.setVisibility(index,null,'mesh',true);assert.ok(!V.mask(index,p,semantic,excluded).elems.has(10));
 assert.equal(await R.digest(JSON.stringify(state)),before);const saved=JSON.parse(JSON.stringify({visibility:p}));assert.deepEqual(V.preferences(saved.visibility),p);
});
test('CAD references default hidden once meshed; explicit CAD display and group hide remain independent',()=>{
 const {index,semantic}=fixture();assert.ok(V.mask(index,null,semantic).sources.has('cad'));let p=V.setVisibility(index,null,'cad',true);assert.ok(!V.mask(index,p,semantic).sources.has('cad'));assert.ok(!V.mask(index,p,semantic).elems.size);
 p=V.setVisibility(index,p,'part',false);assert.ok(V.mask(index,p,semantic).sources.has('cad'));
});
test('unknown saved IDs are harmless, absent objects can return through undo, and preference input is sanitized',()=>{
 const {index,semantic}=fixture(),p=V.preferences({objects:{mesh:false,ghost:false,invalid:'no'},isolate:'deleted'});assert.equal(p.objects.invalid,undefined);assert.ok(V.mask(index,p,semantic).elems.has(10));assert.equal(p.objects.ghost,false);assert.throws(()=>V.setVisibility(index,p,'missing',true),/no longer/);
});


test('suspended definitions keep tree identity without advertising retained cards as active geometry',()=>{
 const {state}=fixture();for(const o of state.project.objects)if(['mesh','copy/mesh','region','joint'].includes(o.id))o.facts={suspendedReason:'CAD replaced'};
 const index=V.build(state);for(const id of ['mesh','copy/mesh','region','joint']){assert.equal(index.entries.get(id).own.elems.size,0);assert.equal(index.entries.get(id).own.nodes.size,0);}
 assert.equal(index.entries.get('part').members.elems.size,0);assert.equal(index.entries.get('cad').sourceDefault,true);
});
