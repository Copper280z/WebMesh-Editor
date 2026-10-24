const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const P=require('../app/part-project.js'),clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 let ownership={project:{objects:[]}},current=null,uuid=0,fail=false;const reviews=[],imports=[];
 const cad={captureDraft:()=>current,serializeDraft:async d=>clone(d.data||{filename:d.file.name,content:'CAD',meshes:[]}),restoreDraft:d=>{current=d;},clear:()=>{current=null;},stageRestore:async data=>{imports.push(data);if(fail)throw Error('Import failed');return {file:{name:data.filename},imported:{topology:{}},data:clone(data)};}};
 const h={engine:()=>({getProjectOwnership:()=>ownership}),cad:()=>cad,parts(){},mesh(){},review:async(request,options)=>reviews.push({request,options})};
 const ctx={window:{WebMeshParts:P,WebMeshCadProject:{geometryFingerprint:async()=> 'fingerprint'}},crypto:{randomUUID:()=>String(++uuid)},structuredClone:clone};vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../app/part-workspace.js'),'utf8'),ctx);const workspace=ctx.window.WebMeshPartWorkspace.create(h);
 const staged=name=>({file:{name},imported:{topology:{}},data:{filename:name,content:name,meshes:[]}});
 return {workspace,cad,reviews,imports,staged,get state(){return ownership;},set state(v){ownership=v;},get current(){return current;},set current(v){current=v;},set fail(v){fail=v;},apply(){const {request,options}=reviews.at(-1);options.beforeCommit();const map=new Map(ownership.project.objects.map(o=>[o.id,o]));for(const o of request.objects)map.set(o.id,o);ownership={project:{objects:[...map.values()]}};options.onApplied();}};
}
test('adding and switching parts preserves independent CAD drafts; discard and failed import leave the active part intact',async()=>{
 const f=fixture(),w=f.workspace;await w.addImported(f.staged('chassis.step'));assert.equal(w.active(),null);assert.equal(f.state.project.objects.length,0);f.apply();const chassis=w.active(),chassisDraft=f.current;chassisDraft.data.settings={sizing:{size:5}};
 await w.addImported(f.staged('discard.step'));assert.equal(w.active(),chassis);assert.equal(f.current,chassisDraft);
 await w.addImported(f.staged('wheel.step'));f.apply();const wheel=w.active();f.current.data.settings={sizing:{size:2}};await w.edit(chassis);assert.equal(f.current.data.settings.sizing.size,5);await w.edit(wheel);assert.equal(f.current.data.settings.sizing.size,2);
 const saved=await w.serialize();assert.equal(saved.entries.length,2);f.fail=true;await assert.rejects(w.stageRestore(saved,f.state),/Import failed/);assert.equal(w.active(),wheel);assert.equal(f.current.data.settings.sizing.size,2);f.fail=false;const restore=await w.stageRestore(saved,f.state);w.commitRestore(restore);assert.equal(w.active(),wheel);await w.edit(chassis);assert.equal(f.current.data.settings.sizing.size,5);
});
test('saved part drafts validate ownership and old empty envelopes preserve legacy fallback',async()=>{
 const f=fixture(),w=f.workspace;assert.equal(await w.stageRestore({version:1,active:null,entries:[]},f.state),null);await w.addImported(f.staged('first.step'));f.apply();const saved=clone(await w.serialize());saved.entries[0].data.editingOwner='missing';await assert.rejects(w.stageRestore(saved,f.state),/different part/);delete saved.entries[0].data.editingOwner;saved.entries.push(clone(saved.entries[0]));await assert.rejects(w.stageRestore(saved,f.state),/unique part/);
});
test('adding a second CAD file adopts a legacy owned CAD draft in the same reviewed operation',async()=>{
 const f=fixture(),w=f.workspace;f.state={project:{objects:[{id:'source',name:'Old source',kind:'source',definition:{generator:'cad-source-v1',cards:[]}},{id:'mesh',name:'Old mesh',kind:'mesh',dependsOn:['source'],definition:{generator:'cad-mapped-v1',source:'source',cards:[]}}]}};
 f.current=f.staged('old.step');f.current.data.meshes=[{projectOwner:'mesh'}];const before=clone(f.state);await w.addImported(f.staged('new.step'));assert.deepEqual(f.state,before);assert.equal(f.current.file.name,'old.step');f.apply();const parts=f.state.project.objects.filter(P.isPart);assert.equal(parts.length,2);const old=parts.find(p=>p.definition.source==='source');assert.equal(f.state.project.objects.find(o=>o.id==='mesh').definition.part,old.id);await w.edit(old.id);assert.equal(f.current.file.name,'old.step');assert.equal((await w.serialize()).entries.length,2);
});
