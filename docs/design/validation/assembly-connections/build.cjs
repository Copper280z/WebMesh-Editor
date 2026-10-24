// Reproduce analysis authoring through public project actions from the browser-meshed checkpoint.
// node build.cjs /path/to/rover-owned-meshes.webmesh /tmp/rover-analysis.webmesh
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),O=require(root+'/app/engine-ownership.js'),Parts=require(root+'/app/part-project.js'),Mount=require(root+'/app/attachment-project.js'),Regions=require(root+'/app/mesh-region-project.js'),Selection=require(root+'/app/selection-project.js'),Assembly=require(root+'/app/assembly-project.js'),Mass=require(root+'/app/mass-project.js'),Analysis=require(root+'/app/analysis-project.js'),Frames=require(root+'/app/coordinate-project.js'),Runs=require(root+'/app/analysis-runs.js');
const input=fs.readFileSync(process.argv[2]);const p=JSON.parse(process.argv[2].endsWith('.gz')?require('node:zlib').gunzipSync(input):input),ownership=p.ownership;
let s={ownership,semantic:{nodes:[],properties:[],materials:[],coords:[],masses:[],elems:Object.fromEntries('tri tri6 quad quad8 tet hex penta pyram rod bar beam bush rbe2 rbe3'.split(' ').map(k=>[k,[]])),loads:{},spc:[],spc1:[],temperatures:[]}};
for(const o of ownership.project.objects)for(const c of o.definition.cards||[])if(c.family==='elems')s.semantic.elems[c.bucket].push(c.value);else if(s.semantic[c.family])s.semantic[c.family].push([c.id,c.value]);else O.put(s.semantic,c);
const objects=()=>s.ownership.project.objects,find=id=>objects().find(o=>o.id===id),next=()=>{const ids={node:1,element:1,property:1,material:1,coordinate:1};for(const r of s.ownership.project.reservations)if(r.namespace in ids)ids[r.namespace]=Math.max(ids[r.namespace],r.end+1);return ids;};
function apply(r){r=Parts.rebuild(s.ownership,r,next());r=Parts.scopedRegions(s.ownership,r);r=Regions.rebuild(s.ownership,Selection.project(s.ownership,s.semantic,r).semantic,r);r=Mount.rebuild(s.ownership,r);r=Assembly.rebuild(s.ownership,r,next());r=Mass.rebuild(s.ownership,r);r=Analysis.rebuild(s.ownership,r);r=Frames.rebuild(s.ownership,r);s=O.preview(s.semantic,s.ownership,r);console.log(r.label||'Applied change');}
const chassis=objects().find(o=>o.name==='Chassis shells'),wheel=objects().find(o=>o.name==='Wheel shell');assert.equal(chassis.definition.cards.filter(c=>c.family==='elems').length,5759);
function edgeRegion(id,name,mesh,edges,count,center){const r=Mount.region({id,name,mesh:mesh.id,kind:'edge',faces:edges},s.ownership);const resolved=r.objects[0].definition.resolved;assert.equal(resolved.nodes.length,count);if(center)resolved.centroid.forEach((v,i)=>assert.ok(Math.abs(v-center[i])<1e-7));apply(r);}
edgeRegion('wheel-bolts','Wheel bolt holes',wheel,[123,124,125,126],64,[0,-2,0]);
edgeRegion('battery-slots','Battery slots',chassis,[611,612,613,614,615,616,617,618],40,[-57,0,27]);
edgeRegion('payload-holes','Payload mounts',chassis,[601,608,621,627],48,[0,0,27]);
const patterns=[['right rear',[521,522,524,525],1,-1],['right front',[530,531,533,534],1,1],['left front',[575,576,578,579],-1,1],['left rear',[594,595,597,598],-1,-1]];
for(const [name,edges,x,y]of patterns)edgeRegion('mount-'+name.replaceAll(' ','-'),'Motor '+name+' holes',chassis,edges,48,[x*93,y*68,52]);
apply(Assembly.template({id:'nema17-recipe',name:'NEMA17 locked motor',parameters:{mount:[0,20,0],shaft:[0,0,0],mass:'350 g',massOffset:[0,20,0],components:'123',stiffness:[1e5,1e5,1e5,1e6,1e6,1e6]}},s.ownership,next()));
for(const [name]of patterns){const instance=objects().find(o=>o.name==='Wheel '+name),key=name.replaceAll(' ','-'),driven='wheel-bolts-'+key;
 apply(Parts.region({id:driven,name:'Wheel '+name+' bolt holes',instance:instance.id,region:'wheel-bolts'},s.ownership));
 apply(Assembly.connection({id:'motor-'+key,name:'Motor '+name,template:'nema17-recipe',region:'mount-'+key,drivenRegion:driven,placement:instance.id},s.ownership,next()));
}
apply(Mass.payload({id:'battery',name:'Battery 500 g',mass:'500 g',reference:[-57,0,27],offset:[0,0,15],supports:[{region:'battery-slots',weight:1}]},s.ownership,next()));
apply(Mass.payload({id:'payload',name:'Payload 1 kg at 200 mm',mass:'1 kg',reference:[0,0,27],offset:[0,0,200],supports:[{region:'payload-holes',weight:1}]},s.ownership,next()));
// Explicit, reviewable contact selections; a remesh requires repair of this region.
const rimElements=new Set(wheel.definition.cards.filter(c=>c.family==='elems'&&c.value.pid===2).flatMap(c=>c.value.n));
const contact=[];for(const instance of objects().filter(Parts.isInstance)){const mesh=find(instance.id+'/mesh'),map=new Map(mesh.definition.mapping.nodes),nodes=new Map(mesh.definition.cards.filter(c=>c.family==='nodes').map(c=>[c.id,c.value]));const selected=[...rimElements].map(n=>map.get(n)).filter(n=>nodes.get(n).z<24.0);assert.ok(selected.length>=12);contact.push(...selected);}
apply(Regions.build({id:'contacts',name:'Four fixed wheel contact patches',entity:'node',ids:contact},s.ownership,s.semantic));
apply(Analysis.set({id:'contact-support',name:'Fixed contact translations',action:'support',region:'contacts',components:'123',frame:null},s.ownership,s.semantic));
apply(Analysis.set({id:'gravity',name:'Gravity -Z',action:'acceleration',vector:[0,0,-9806.65],frame:null},s.ownership,s.semantic));
apply(Analysis.set({id:'payload-force',name:'Payload lateral 0.5 g',action:'force',node:find('payload').definition.identities.node,vector:[0,4.903325,0],frame:null},s.ownership,s.semantic));
const gravity=find('gravity').definition.action.sid,force=find('payload-force').definition.action.sid,support=find('contact-support').definition.action.sid;
// LOAD is an existing directly authorable card. Keep its explicit combination
// as plain cards; the named static case references it through the export gate.
s.semantic.loads.combination=[{sid:Math.max(gravity,force)+1,scale:1,entries:[{scale:1,lid:gravity},{scale:1,lid:force}]}];
for(const [id,name,load]of [['case-gravity','Rover gravity',gravity],['case-lateral','Gravity and payload lateral 0.5g',Math.max(gravity,force)+1]])apply(Analysis.caseObject({id,name,load,support,outputs:['DISPLACEMENT','SPCFORCES','STRESS','OLOAD','FORCE']},s.ownership,s.semantic));
async function write(){
 const sync=require(root+'/tests/helpers/editor-sync-context.cjs')(0,0).context;for(const [k,v]of Object.entries(s.semantic))sync.model[k]=['nodes','properties','materials','coords','masses'].includes(k)?new Map(v):v;sync.ensureSemanticRelationshipIndexes=sync.refreshSemanticRelationshipIndexes=()=>({elementRefsByEid:new Map(Object.values(s.semantic.elems).flat().map(e=>[e.eid,e]))});sync.syncWorkerFromEditorModel();
 const messages=[],worker=vm.createContext({Map,Set,self:{postMessage:m=>messages.push(m)},console,TextEncoder,TextDecoder,performance,setTimeout,clearTimeout});vm.runInContext(require(root+'/tests/helpers/worker-source.cjs'),worker);worker.handleWriteRequest({model:sync.workerModel,options:{writeFormat:'free',projectSave:true}});const deck=Analysis.projectDeck(messages.find(m=>m.type==='WRITE_COMPLETE').text,s.ownership);
 p.ownership=s.ownership;p.deck=deck;p.snapshotDigest=await Runs.digest(deck+'\0'+O.canonical(s.ownership));p.analysisRuns=[];p.name='Rover reusable motor assembly';p.history.unshift({text:'Public-action assembly recipe authoring; browser-meshed chassis and live wheels'});fs.writeFileSync(process.argv[3],JSON.stringify(p));fs.writeFileSync('/tmp/rover-assembly-semantic.json',JSON.stringify(s.semantic));console.log('Saved',process.argv[3],{nodes:s.semantic.nodes.length,quads:s.semantic.elems.quad.length,contacts:contact.length,mass:s.semantic.masses.reduce((n,[id,m])=>n+m.m,0)});
}
write().catch(e=>{console.error(e);process.exitCode=1;});
