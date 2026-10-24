const {test}=require('node:test'),assert=require('node:assert/strict');
const O=require('../app/engine-ownership.js'),A=require('../app/assembly-project.js'),M=require('../app/attachment-project.js'),R=require('../app/mesh-region-project.js'),P=require('../app/part-project.js'),F=require('../app/coordinate-project.js'),Mass=require('../app/mass-project.js');
const clone=v=>JSON.parse(JSON.stringify(v)),ids={node:100,element:100,property:10,coordinate:10};
function empty(){return{nodes:[],properties:[],materials:[],coords:[],masses:[],elems:{quad:[],rbe2:[],bush:[],rbe3:[]},loads:{},spc:[],spc1:[],temperatures:[]};}
function apply(s,r){r=P.rebuild(s.ownership,r,ids);r=P.scopedRegions(s.ownership,r);r=R.rebuild(s.ownership,require('../app/selection-project.js').project(s.ownership,s.semantic,r).semantic,r);r=M.rebuild(s.ownership,r);r=A.rebuild(s.ownership,r,ids);r=Mass.rebuild(s.ownership,r);r=F.rebuild(s.ownership,r);return O.preview(s.semantic,s.ownership,r);}
function setup(){
 let s=O.preview(empty(),null,{objects:[{id:'part',name:'Wheel',kind:'part',definition:{generator:P.PART,source:null,cards:[]}},{id:'mat',name:'PLA',kind:'material',definition:{cards:[{family:'materials',id:1,role:'material',value:{type:'MAT1',mid:1,E:3000,nu:.35,rho:1.24e-9}}]}},{id:'section',name:'Shell',kind:'section',dependsOn:['mat'],definition:{cards:[{family:'properties',id:1,role:'section',value:{type:'PSHELL',pid:1,mid1:1,mid2:1,t:2}}]}},{id:'mesh',name:'Web',kind:'mesh',dependsOn:['section','part'],definition:{part:'part',cards:[...[[0,0,0],[1,0,0],[1,1,0],[0,1,0]].map((v,i)=>({family:'nodes',id:i+1,role:'n'+i,value:{x:v[0],y:v[1],z:v[2],cp:0,cd:0,ps:''}})),{family:'elems',bucket:'quad',id:1,role:'web',value:{type:'CQUAD4',eid:1,pid:1,n:[1,2,3,4]}}]}}]});
 s=apply(s,R.build({id:'mount',name:'Mount',entity:'node',ids:[1,2,3,4]},s.ownership,s.semantic));
 s=apply(s,P.instance({id:'wheel',name:'Wheel placement',part:'part',transform:{translation:[20,0,0],rotation:[0,0,90],reflection:'y'}},s.ownership,ids));
 s=apply(s,P.region({id:'driven',name:'Driven',instance:'wheel',region:'mount'},s.ownership));
 s=apply(s,A.template({id:'recipe',name:'Motor recipe',parameters:{mass:'350 g'}},s.ownership,ids));return s;
}
const input={id:'motor',name:'Motor',template:'recipe',region:'mount',drivenRegion:'driven',placement:'wheel'};
const root=s=>s.ownership.project.objects.find(o=>o.id==='motor');
test('recipe composes local points, shared PBUSH, mass and two rigid links; saved cards verify',()=>{
 const s=apply(setup(),A.connection(input,setup().ownership,ids)),o=root(s),points=s.ownership.project.objects.find(o=>o.id==='motor/points');
 assert.deepEqual(o.definition.cards.map(c=>c.value.type),['RBE2','CBUSH','CONM2','RBE2']);assert.equal(s.semantic.properties.length,2);assert.ok(Math.abs(o.definition.resolved.mass-.00035)<1e-15);
 assert.deepEqual(points.definition.cards[0].value,{x:20,y:0,z:0,cp:0,cd:0,ps:''});assert.ok(Math.abs(points.definition.cards[1].value.y-20)<1e-10);
 assert.ok(Math.abs(o.definition.cards.find(c=>c.role==='mass').value.x[1]+20)<1e-10);assert.doesNotThrow(()=>O.validate(JSON.parse(JSON.stringify(s.ownership)),s.semantic));
 const bad=clone(s.ownership);bad.project.objects.find(o=>o.id==='motor').definition.overrides.mass=.004;assert.throws(()=>O.validate(bad,s.semantic),/disagrees/);
});
test('shared recipe edits propagate, explicit overrides keep/revert, IDs remain stable',()=>{
 let s=setup();s=apply(s,A.connection(input,s.ownership,ids));const before=root(s).definition.cards.map(c=>c.id);
 s=apply(s,A.connection({...input,overrides:{mass:'500 g',stiffness:[1,2,3,4,5,6]}},s.ownership,ids));assert.equal(root(s).definition.resolved.mass,.0005);assert.equal(s.semantic.properties.length,3);
 s=apply(s,A.template({id:'recipe',name:'Updated recipe',parameters:{mass:'600 g',stiffness:[10,20,30,40,50,60]}},s.ownership,ids));assert.equal(root(s).definition.resolved.mass,.0005);assert.equal(root(s).definition.resolved.stiffness[0],1);
 s=apply(s,A.connection({...input,overrides:{}},s.ownership,ids));assert.equal(root(s).definition.resolved.mass,.0006);assert.equal(s.semantic.properties.length,2);assert.deepEqual(root(s).definition.cards.map(c=>c.id),before);
});
test('placement edits move points and rotate mass offsets with stable connector identities',()=>{
 let s=setup();s=apply(s,A.connection(input,s.ownership,ids));const before=root(s).definition.cards.map(c=>c.id);
 s=apply(s,P.instance({id:'wheel',name:'Moved wheel',part:'part',transform:{translation:[50,7,3],rotation:[0,0,180]}},s.ownership,ids));
 assert.deepEqual(root(s).definition.cards.map(c=>c.id),before);const p=s.ownership.project.objects.find(o=>o.id==='motor/points');assert.deepEqual([p.definition.cards[0].value.x,p.definition.cards[0].value.y,p.definition.cards[0].value.z],[50,7,3]);assert.ok(Math.abs(root(s).definition.cards.find(c=>c.role==='mass').value.x[0]-20)<1e-10);
});
test('duplicate rigid DOFs and missing bindings fail without mutating the source',()=>{
 let s=setup();s=apply(s,A.connection(input,s.ownership,ids));const before=JSON.stringify(s);
 assert.throws(()=>apply(s,A.connection({...input,id:'duplicate'},s.ownership,ids)),/already constrained|dependent/);assert.equal(JSON.stringify(s),before);
 assert.throws(()=>apply(s,{removeObjects:['driven']}),/missing/);assert.equal(JSON.stringify(s),before);
});
test('independent recipe severs shared parameters and removal removes all owned children',()=>{
 let s=setup();s=apply(s,A.connection(input,s.ownership,ids));s=apply(s,A.detach(s.ownership,'motor',ids));assert.equal(root(s).definition.template,'motor/recipe');
 s=apply(s,A.template({id:'recipe',name:'Original changed',parameters:{mass:'1 kg'}},s.ownership,ids));assert.ok(Math.abs(root(s).definition.resolved.mass-.00035)<1e-15);
 s=apply(s,A.remove(s.ownership,'motor'));assert.ok(!s.ownership.project.objects.some(o=>o.id==='motor'||o.definition.assemblyMember==='motor'));assert.equal(s.semantic.masses.length,0);
});
test('direct RBE2 action is independently authorable and repairable',()=>{
 let s=setup();s=apply(s,Mass.direct({id:'point',name:'Reference',action:'point',position:[0,0,3]},s.ownership,s.semantic,ids));const node=s.ownership.project.objects.find(o=>o.id==='point').definition.action.id;
 s=apply(s,Mass.direct({id:'rigid',name:'Direct rigid',action:'rbe2',node,nodes:[1,2,3,4],components:'123'},s.ownership,s.semantic,ids));assert.equal(s.semantic.elems.rbe2.length,1);assert.equal(s.semantic.elems.rbe2[0].gn,node);
});
test('two repeats share a PBUSH and shared edits update both while an override remains local',()=>{
 let s=setup();s=apply(s,A.connection({...input,drivenRegion:null,placement:null},s.ownership,ids));
 s=apply(s,A.connection({id:'second',name:'Second motor',template:'recipe',region:'driven',placement:'wheel',overrides:{mass:'500 g'}},s.ownership,ids));
 const before=s.semantic.elems.bush.map(e=>e.eid);assert.equal(new Set(s.semantic.elems.bush.map(e=>e.pid)).size,1);
 s=apply(s,A.template({id:'recipe',name:'Changed',parameters:{mass:'600 g',stiffness:[10,20,30,40,50,60]}},s.ownership,ids));assert.equal(root(s).definition.resolved.mass,.0006);assert.equal(s.ownership.project.objects.find(o=>o.id==='second').definition.resolved.mass,.0005);assert.deepEqual(s.semantic.elems.bush.map(e=>e.eid),before);assert.equal(s.semantic.properties.find(([id,p])=>p.type==='PBUSH')[1].K3,30);
});
test('reusable frames move points and rotate stiffness without allocating new cards',()=>{
 let s=setup();s=apply(s,F.build({id:'local',name:'Motor frame',origin:[5,6,7],zAxisPt:[5,6,8],xzPlanePt:[5,7,7]},s.ownership,ids));
 s=apply(s,A.connection({...input,placement:null,frame:'local'},s.ownership,ids));const p=()=>s.ownership.project.objects.find(o=>o.id==='motor/points').definition.cards;const before=p().map(c=>c.id);assert.equal(p()[1].value.y,26);
 s=apply(s,F.build({id:'local',name:'Moved frame',origin:[8,6,7],zAxisPt:[8,6,8],xzPlanePt:[9,6,7]},s.ownership,ids));assert.equal(p()[1].value.x,28);assert.deepEqual(p().map(c=>c.id),before);
 const bound=F.assign({nodes:[p()[1].id],frame:'local'},s.ownership);s=apply(s,bound);assert.equal(p()[1].value.cd,s.semantic.coords[0][0]);
});
test('batch snapshot restoration matches sequential replacement and preserves plain cards',()=>{
 const source=setup().semantic,a=clone(source),b=clone(source),cards=[{family:'nodes',id:1,value:{x:100,y:0,z:0}},{family:'nodes',id:1,value:{x:200,y:0,z:0}},{family:'elems',bucket:'rbe2',id:1,value:{type:'RBE2',eid:1,gn:2,cm:'123',deps:[3,4]}},{family:'loadSets',id:5,value:{type:'LOADSET',sid:5,entries:[{bucket:'gravity',value:{type:'GRAV',sid:5,cid:0,scale:1,vector:[0,0,-1],mb:0}}]}}];
 cards.forEach(c=>O.put(a,c));O.putAll(b,cards);assert.deepEqual(b,a);assert.ok(b.nodes.some(([id])=>id===3));assert.equal(b.elems.quad.some(e=>e.eid===1),false);
 const changed=clone(cards);O.putAll(b,changed);changed[1].value.x=500;assert.equal(b.nodes.find(([id])=>id===1)[1].x,200);
});
