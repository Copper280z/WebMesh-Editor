// Run the actual workbench orchestration with failure-injectable storage/engine boundaries.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../app/workbench.js'),'utf8');
const code=source.slice(source.indexOf('  async function restoreProject('),source.indexOf("  $('wb-project-file').onchange"));
function fixture(failure){
 const calls=[],old={model:'old',parts:'draft with redo',runs:'matching run'},state={...old};
 const step=name=>{calls.push(name);if(failure===name)throw Error(name+' failed');};
 const parts={retain:async()=>step('retain'),active:()=>true,captureState:()=>state.parts,stageRestore:async()=>{step('stage');return {transaction:'tx'};},commitRestore:()=>{state.parts='new';step('parts');},restoreState:x=>{state.parts=x;step('rollback-parts');},finishRestore:async(x,commit)=>step(commit?'adopt':'abort')};
 const engine={beginProjectRestore:async()=>({commit:()=>step('commit'),rollback:()=>{state.model=old.model;step('rollback-model');}}),loadProjectModel:async()=>{state.model='new';step('load');},bindMeshOwner:async()=>step('bind')};
 const analysis={validate:async()=>step('validate'),checkpoint:()=>()=>{state.runs=old.runs;step('rollback-runs');},restore:async()=>{state.runs='new';step('runs');}};
 const c=vm.createContext({partWorkspace:parts,cadWorkspace:{savedOwners:()=>[]},analysisSession:analysis,engine:()=>engine,restoringAnalysisProject:false});vm.runInContext(code,c);
 return {calls,state,old,c,restore:()=>c.restoreProject({version:2},'test.webmesh')};
}
test('failed model, draft, run or server adoption restores prior workspace and always aborts candidates',async()=>{
 for(const failure of ['load','parts','runs','adopt']){const f=fixture(failure);await assert.rejects(f.restore(),new RegExp(failure+' failed'));assert.deepEqual(f.state,f.old);assert.ok(f.calls.includes('abort'));assert.ok(!f.calls.includes('commit'));assert.equal(f.c.restoringAnalysisProject,false);}
});
test('successful project adoption happens only after model, part and run restoration',async()=>{
 const f=fixture();await f.restore();assert.deepEqual(f.state,{model:'new',parts:'new',runs:'new'});assert.deepEqual(f.calls,['validate','retain','stage','load','parts','runs','adopt','commit']);assert.equal(f.c.restoringAnalysisProject,false);
});
test('CAD cleanup still runs when a UI rollback throws',async()=>{
 const f=fixture('load');f.c.partWorkspace.restoreState=()=>{throw Error('renderer recovery');};await assert.rejects(f.restore(),/load failed.*renderer recovery/);assert.ok(f.calls.includes('abort'));assert.ok(f.calls.includes('rollback-runs'));
});
test('invalid run metadata is rejected before retaining or staging CAD',async()=>{
 const f=fixture('validate');await assert.rejects(f.restore(),/validate failed/);assert.deepEqual(f.calls,['validate']);assert.deepEqual(f.state,f.old);
});
