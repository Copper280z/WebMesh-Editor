const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),z=require('node:zlib');
const Assembly=require('../app/assembly-project.js');
const Patterns=require('../app/cad-patterns.js'),R=require('../app/cad-replacement.js'),C=require('../app/cad-project.js'),Selective=require('../app/cad-selective-mesh.js'),Mount=require('../app/attachment-project.js'),O=require('../app/engine-ownership.js'),Core=require('../app/project.js'),{apply,ids,empty}=require('./helpers/project-actions.cjs');
const base='../docs/design/validation/selective-replacement/',read=name=>JSON.parse(z.gunzipSync(fs.readFileSync(require.resolve(base+name)))),before=read('before-topology.json.gz'),after=read('moved-topology.json.gz'),copy=x=>JSON.parse(JSON.stringify(x));
const regionIds=['mount-left-front','mount-left-rear','mount-right-front','mount-right-rear'];
function rover(){const p=JSON.parse(z.gunzipSync(fs.readFileSync(require.resolve('../docs/design/validation/project-workspace/rover-remesh.webmesh.gz'))));let a={ownership:p.ownership,semantic:empty()};O.putAll(a.semantic,a.ownership.owners.map(e=>e.card));a.semantic.loads.load=[{type:'LOAD',sid:3,scale:1,entries:[{lid:1,scale:1},{lid:2,scale:1}]}];const part=a.ownership.project.objects.find(o=>o.name==='rover_chassis');a.ownership.project.objects.find(o=>o.id===part.definition.source).definition.topology=copy(before);
 for(const id of regionIds){const o=find(a,id);a=apply(a,Mount.region({id,name:o.name,mesh:o.definition.selector.mesh,kind:'edge',faces:o.definition.selector.faces,pattern:true},a.ownership));}const motor=a.ownership.project.objects.find(o=>o.id==='motor-right-rear');a=apply(a,Assembly.connection({...motor.definition,id:motor.id,name:motor.name,overrides:{stiffness:[110000,100000,100000,1e6,1e6,1e6]}},a.ownership,ids(a.ownership)));return a;}
const find=(a,id)=>a.ownership.project.objects.find(o=>o.id===id),chassis=a=>a.ownership.project.objects.find(o=>o.name==='Chassis shells');
async function replacement(a,extra={}){const mesh=chassis(a),content=z.gunzipSync(fs.readFileSync(require.resolve(base+'moved-rr.brep.gz'))).toString('base64');return R.build(a.ownership,{part:mesh.definition.part,before,topology:after,geometryKey:await C.geometryFingerprint(after),snapshot:{filename:'moved-rr.brep',content,prepared:{filename:'moved-rr.brep',format:'brep',content}},choices:{'faces:177':177,'faces:179':179},revisionId:'rr-30',...extra});}
test('named pattern matches the full unchanged group and offers translation without accepting it',()=>{
 const pattern=Patterns.define(before,[521,522,524,525]),r=Patterns.match(pattern,after);assert.equal(r.status,'missing');assert.equal(r.target,null);assert.equal(r.candidates[0].distance,30);assert.deepEqual(r.candidates[0].translation,[0,30,0]);assert.equal(r.candidates[0].ids.length,4);
 const f=Patterns.define(before,[530,531,533,534]);assert.equal(Patterns.match(f,after).status,'exact');
 const duplicate=copy(after);duplicate.edges.push({...copy(duplicate.edges.find(e=>e.id===Patterns.match(f,after).target[0])),id:9000});assert.equal(Patterns.match(f,duplicate).status,'ambiguous');
 assert.throws(()=>Patterns.define(before,[500,518]),/circular/);assert.throws(()=>Patterns.define(before,[521,521]),/distinct/);
});
test('changed interior boundaries cannot masquerade as an unchanged face with equal area and centroid',()=>{
 const b=copy(before),a=copy(before),edge=a.edges.find(e=>e.id===521);edge.bounds=edge.bounds.map((v,i)=>v+(i%3===1?2:0));
 const d={generator:'cad-shell-v1',source:'s',targets:[177],faces:[{id:177,nodes:[1,2,3,4]}],edges:[],sections:[],layout:{key:'same'},cards:[...[1,2,3,4].map(id=>({family:'nodes',id,value:{x:id,y:0,z:0}})),{family:'elems',id:1,value:{n:[1,2,3,4]}}]};
 assert.equal(Selective.retain({id:'mesh',definition:d},b,a,R.match(b,a),'new'),null);
});
test('real rover selective replacement, patch remesh and RR repair preserve untouched identities and save validation',async()=>{
 const a=rover(),original=JSON.stringify(a),request=await replacement(a),b=apply(a,request);assert.equal(JSON.stringify(a),original);
 const mesh=chassis(b),old=chassis(a);assert.equal(mesh.definition.targets.length,11);assert.equal(mesh.definition.pendingReplacement.faces.length,2);assert.ok(mesh.definition.pendingReplacement.boundaryEdges.length>5);
 for(const id of regionIds.slice(0,3)){assert.ok(!find(b,id).facts.suspendedReason);assert.deepEqual(find(b,id).definition.resolved.nodes,find(a,id).definition.resolved.nodes);const motor=id.replace('mount-','motor-');assert.deepEqual(find(b,motor).definition.cards,find(a,motor).definition.cards);}
 assert.ok(find(b,'mount-right-rear').facts.suspendedReason);assert.equal(Core.restore(b.ownership.project).readiness().allowed,false);
 const retained=new Map(mesh.definition.cards.map(c=>[c.family+':'+c.id,c]));for(const c of old.definition.cards)if(retained.has(c.family+':'+c.id))assert.deepEqual(retained.get(c.family+':'+c.id),c);
 const input={id:mesh.id,name:mesh.name,kind:'shell',faces:[177,179],mesh:read('patch-mesh.json.gz').mesh,topology:after,snapshot:find(b,mesh.definition.source).definition.snapshot};
 const incomplete=copy(input);incomplete.mesh.elements=incomplete.mesh.elements.filter(e=>e.face!==177);await assert.rejects(C.build(incomplete,b.ownership,ids(b.ownership)),/Every changed face/);
 const bad=copy(input);bad.mesh.edgeNodes[mesh.definition.pendingReplacement.boundaryEdges[0].id].pop();await assert.rejects(C.build(bad,b.ownership,ids(b.ownership)),/boundary nodes/);
 const duplicate=copy(input);duplicate.mesh.nodes.push(copy(duplicate.mesh.nodes[0]));await assert.rejects(C.build(duplicate,b.ownership,ids(b.ownership)),/unique positive IDs/);
 const changed=copy(input);changed.topology.faces[0].area+=1;await assert.rejects(C.build(changed,b.ownership,ids(b.ownership)),/current committed CAD/);
 const c=apply(b,(await C.build(input,b.ownership,ids(b.ownership))).request);assert.equal(find(c,mesh.id+'/replacement-patch'),undefined);assert.equal(chassis(c).definition.targets.length,13);assert.ok(find(c,'mount-right-rear').facts.suspendedReason);
 const region=find(c,'mount-right-rear'),chosen=Patterns.match(region.definition.pattern,after).candidates[0].ids;const repair=Mount.region({id:region.id,name:region.name,mesh:mesh.id,kind:'edge',faces:chosen,pattern:true},c.ownership),d=apply(c,R.reactivate(c.ownership,repair));
 assert.equal(Core.restore(d.ownership.project).readiness().allowed,true);assert.deepEqual([...new Set(d.changes.map(c=>c.owner))],['motor-right-rear']);assert.deepEqual(find(d,'motor-right-rear').definition.overrides,find(a,'motor-right-rear').definition.overrides);
 for(const id of regionIds.slice(0,3))assert.deepEqual(find(d,id.replace('mount-','motor-')).definition.cards,find(a,id.replace('mount-','motor-')).definition.cards);
 assert.deepEqual(d.semantic.loads,a.semantic.loads);O.validate(copy(d.ownership),copy(d.semantic));
 const hand=copy(a);const removed=b.changes.find(c=>c.action==='remove'&&c.key.startsWith('node:'));hand.semantic.loads.force.push({sid:99,nid:Number(removed.key.split(':')[1]),mag:1,cid:0,dir:[1,0,0]});assert.throws(()=>apply(hand,request),/Dangling reference/);
});
