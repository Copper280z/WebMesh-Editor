const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const P=require('../app/part-project.js'),clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 let ownership={project:{objects:[]}},current=null,uuid=0,fail=false;let busy=false;const reviews=[],imports=[],finishes=[],controls=[],opened=[];
 const cad={beginRestore:()=>({client:'workspace',transaction:String(++uuid)}),finishRestore:async(tx,commit)=>finishes.push({tx,commit}),abortRestore:async tx=>finishes.push({tx,commit:false}),captureDraft:()=>current,serializeDraft:async d=>clone(d.data||{filename:d.file.name,content:'CAD',meshes:[]}),restoreDraft:d=>{current=d;},clear:()=>{current=null;},stageRestore:async data=>{imports.push(data);if(fail)throw Error('Import failed');return {file:{name:data.filename},imported:{topology:{}},data:clone(data)};}};
 const h={engine:()=>({getProjectOwnership:()=>ownership}),cad:()=>cad,parts(){},mesh(){},run:async fn=>{busy=true;try{return await fn();}finally{busy=false;}},owner:id=>{if(!busy)opened.push(id);},review:async(request,options)=>reviews.push({request,options})};
 const ctx={window:{WebMeshParts:P,WebMeshCadReplacement:require('../app/cad-replacement.js'),WebMeshCadProject:{geometryFingerprint:async()=> 'fingerprint',restoreData:require('../app/cad-project.js').restoreData}},document:{querySelectorAll:()=>controls},crypto:{randomUUID:()=>String(++uuid)},structuredClone:clone};vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../app/part-workspace.js'),'utf8'),ctx);const workspace=ctx.window.WebMeshPartWorkspace.create(h);
 const staged=name=>({file:{name},imported:{topology:{}},data:{filename:name,content:name,meshes:[]}});
 return {workspace,cad,reviews,imports,finishes,staged,controls,opened,get state(){return ownership;},set state(v){ownership=v;},get current(){return current;},set current(v){current=v;},set fail(v){fail=v;},async apply(){const {request,options}=reviews.at(-1);await options.beforeCommit();const map=new Map(ownership.project.objects.map(o=>[o.id,o]));for(const o of request.objects)map.set(o.id,o);ownership={project:{objects:[...map.values()]}};options.onApplied();}};
}
test('adding and switching parts preserves independent CAD drafts; discard and failed import leave the active part intact',async()=>{
 const f=fixture(),w=f.workspace;await w.addImported(f.staged('chassis.step'));assert.equal(w.active(),null);assert.equal(f.state.project.objects.length,0);await f.apply();const chassis=w.active(),chassisDraft=f.current;chassisDraft.data.settings={sizing:{size:5}};
 await w.addImported(f.staged('discard.step'));assert.equal(w.active(),chassis);assert.equal(f.current,chassisDraft);
 await w.addImported(f.staged('wheel.step'));await f.apply();const wheel=w.active();f.current.data.settings={sizing:{size:2}};await w.edit(chassis);assert.equal(f.current.data.settings.sizing.size,5);await w.edit(wheel);assert.equal(f.current.data.settings.sizing.size,2);
 const saved=await w.serialize();assert.equal(saved.entries.length,2);f.fail=true;await assert.rejects(w.stageRestore(saved,f.state),/Import failed/);assert.equal(w.active(),wheel);assert.equal(f.current.data.settings.sizing.size,2);f.fail=false;const restore=await w.stageRestore(saved,f.state);w.commitRestore(restore);assert.equal(w.active(),wheel);await w.edit(chassis);assert.equal(f.current.data.settings.sizing.size,5);
});
test('saved part drafts validate ownership and old empty envelopes preserve legacy fallback',async()=>{
 const f=fixture(),w=f.workspace;assert.equal(await w.stageRestore({version:1,active:null,entries:[]},f.state),null);await w.addImported(f.staged('first.step'));await f.apply();const saved=clone(await w.serialize());saved.entries[0].data.editingOwner='missing';await assert.rejects(w.stageRestore(saved,f.state),/different part/);delete saved.entries[0].data.editingOwner;saved.entries.push(clone(saved.entries[0]));await assert.rejects(w.stageRestore(saved,f.state),/unique part/);
});
test('adding a second CAD file adopts a legacy owned CAD draft in the same reviewed operation',async()=>{
 const f=fixture(),w=f.workspace;f.state={project:{objects:[{id:'source',name:'Old source',kind:'source',definition:{generator:'cad-source-v1',cards:[]}},{id:'mesh',name:'Old mesh',kind:'mesh',dependsOn:['source'],definition:{generator:'cad-mapped-v1',source:'source',cards:[]}}]}};
 f.current=f.staged('old.step');f.current.data.meshes=[{projectOwner:'mesh'}];const before=clone(f.state);await w.addImported(f.staged('new.step'));assert.deepEqual(f.state,before);assert.equal(f.current.file.name,'old.step');await f.apply();const parts=f.state.project.objects.filter(P.isPart);assert.equal(parts.length,2);const old=parts.find(p=>p.definition.source==='source');assert.equal(f.state.project.objects.find(o=>o.id==='mesh').definition.part,old.id);await w.edit(old.id);assert.equal(f.current.file.name,'old.step');assert.equal((await w.serialize()).entries.length,2);
});

test('every saved part is validated before import, and a second-part failure aborts the shared transaction',async()=>{
 const f=fixture(),w=f.workspace;await w.addImported(f.staged('first.step'));await f.apply();await w.addImported(f.staged('second.step'));await f.apply();
 const saved=clone(await w.serialize()),original=f.current,active=w.active();
 saved.active='missing';await assert.rejects(w.stageRestore(saved,f.state),/active CAD part/);assert.equal(f.imports.length,0);saved.active=active;
 let count=0;const staged=[];f.cad.stageRestore=async(data,tx,scope)=>{staged.push({tx,scope});if(++count===2)throw Error('second part corrupt');return f.staged(data.filename);};
 await assert.rejects(w.stageRestore(saved,f.state),/second part corrupt/);assert.equal(f.finishes.at(-1).commit,false);assert.equal(staged[0].tx,staged[1].tx);assert.deepEqual(staged.map(x=>x.scope),saved.entries.map(x=>x.part));assert.equal(f.current,original);assert.equal(w.active(),active);
});
test('review discard releases an imported candidate; applying adopts it and failed staging preserves the current draft',async()=>{
 const f=fixture(),w=f.workspace,seen=[];f.cad.adoptRestore=async d=>seen.push(['adopt',d]);f.cad.discardRestore=async d=>seen.push(['discard',d]);
 const first=f.staged('first.step');await w.addImported(first);await f.reviews.at(-1).options.onDiscard();assert.deepEqual(seen,[['discard',first]]);assert.equal(w.active(),null);
 const second=f.staged('second.step');await w.addImported(second);await f.apply();assert.deepEqual(seen.at(-1),['adopt',second]);
 const before=w.captureState();w.commitRestore(null);assert.equal(f.current,null);w.restoreState(before);assert.equal(f.current,second);
 f.cad.serializeDraft=async()=>{throw Error('checkpoint failed');};const failed=f.staged('failed.step');await assert.rejects(w.addImported(failed),/checkpoint failed/);assert.deepEqual(seen.at(-1),['discard',failed]);assert.equal(f.current,second);
});


test('replacement source history switches drafts on model undo/redo and persists both prepared histories',async()=>{
 const f=fixture(),w=f.workspace;await w.addImported(f.staged('original.step'));await f.apply();const id=w.active(),originalState=clone(f.state);f.current.data.settings={size:3};f.current.data.prepared={history:['split original','surface original']};
 const next=clone(f.state),source=next.project.objects.find(o=>o.kind==='source');source.definition.replacement={revisionId:'revision-2'};source.definition.snapshot={filename:'replacement.step',content:'next',meshes:[]};f.state=next;
 await w.synchronize(true);assert.equal(f.current.file.name,'replacement.step');f.current.data.settings={size:7};f.current.data.prepared={history:['prepare replacement']};
 f.state=originalState;await w.synchronize(true);assert.equal(f.current.file.name,'original.step');assert.equal(f.current.data.settings.size,3);assert.deepEqual(f.current.data.prepared.history,['split original','surface original']);
 f.state=next;await w.synchronize(true);assert.equal(f.current.data.settings.size,7);const saved=clone(await w.serialize());assert.equal(saved.history.length,1);assert.equal(saved.history[0].version,'initial');assert.deepEqual(saved.history[0].data.prepared.history,['split original','surface original']);
 const staged=await w.stageRestore(saved,f.state);w.commitRestore(staged);f.state=originalState;await w.synchronize(true);assert.equal(f.current.data.settings.size,3);f.state=next;await w.synchronize(true);assert.equal(f.current.data.settings.size,7);
});

test('invalid retained replacement history rejects before opening a session',async()=>{
 const f=fixture(),w=f.workspace;await w.addImported(f.staged('part.step'));await f.apply();const saved=clone(await w.serialize());saved.history=[{part:'missing',version:'initial',data:{}}];await assert.rejects(w.stageRestore(saved,f.state),/history entry/);assert.equal(f.imports.length,0);
});


test('the Parts palette opens an owner before entering a busy operation',async()=>{
 const f=fixture();f.controls.push({dataset:{partAction:'owner',partId:'part'}});f.workspace.bind();await f.controls[0].onclick();assert.deepEqual(f.opened,['part']);
});

test('editing a mesh region reuses prepared CAD and retains plain mesh records and history',async()=>{
 const f=fixture(),w=f.workspace;await w.addImported(f.staged('part.step'));await f.apply();const id=w.active(),source=f.state.project.objects.find(o=>o.kind==='source').id;
 f.state.owners=[];f.state.project.objects.push({id:'mesh',name:'Mesh',kind:'mesh',dependsOn:[id,source],definition:{generator:'cad-mapped-v1',part:id,source,sections:[],targets:[1],settings:{version:2,sizing:{size:3},mesh:{method:'mapped'}}}});
 f.current.imported.revision=9;f.current.data.prepared={history:['slice','sheet','extend']};f.current.data.meshes=[{id:8,kind:'tet',elements:[55],label:'Plain tetrahedra'},{id:11,projectOwner:'mesh',kind:'hex',elements:[8],label:'Mesh'}];
 await w.editMesh('mesh');assert.equal(f.imports.length,0);assert.equal(f.current.imported.revision,9);assert.deepEqual(f.current.data.prepared.history,['slice','sheet','extend']);assert.equal(f.current.data.editingOwner,'mesh');assert.equal(f.current.data.settings.sizing.size,3);assert.equal(f.current.data.meshes.find(m=>m.projectOwner==='mesh').id,11);assert.deepEqual(f.current.data.meshes.find(m=>m.id===8).elements,[55]);
});

test('deleting the active part preserves its CAD draft for undo and omits it from saved live parts',async()=>{
 const f=fixture(),w=f.workspace;await w.addImported(f.staged('delete.step'));await f.apply();const id=w.active(),before=clone(f.state),draft=f.current;draft.data.prepared={history:['split','midsurface','extend']};draft.data.settings={size:7};f.state={project:{objects:[]}};
 await w.synchronize(true);assert.equal(w.active(),null);assert.equal(f.current,null);assert.equal((await w.serialize()).entries.length,0);
 f.state=before;await w.synchronize(true);assert.equal(w.active(),id);assert.equal(f.current,draft);assert.deepEqual(f.current.data.prepared.history,['split','midsurface','extend']);assert.equal(f.imports.length,0);
 f.state={project:{objects:[]}};await w.synchronize(true);assert.equal(f.current,null);assert.equal((await w.serialize()).active,null);
});
test('saving after mesh deletion prunes stale ownership records without mutating the undo draft',async()=>{
 const f=fixture(),w=f.workspace;await w.addImported(f.staged('retained.step'));await f.apply();const id=w.active();f.current.data.editingOwner='gone';f.current.data.meshes=[{id:1,projectOwner:'gone'},{id:2,elements:[50]}];
 const saved=await w.serialize();assert.equal(saved.entries[0].data.editingOwner,null);assert.equal(saved.entries[0].data.meshes.length,1);assert.equal(f.current.data.meshes.length,2);assert.equal(f.current.data.editingOwner,'gone');await w.stageRestore(saved,f.state);
});
