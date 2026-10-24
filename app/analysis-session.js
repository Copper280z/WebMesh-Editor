/* Run inputs are sealed snapshots; completion appends output without altering them. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./analysis-runs.js'),require('./coordinate-project.js'));else root.WebMeshAnalysisSession=factory(root.WebMeshAnalysisRuns,root.WebMeshCoordinates);}(typeof globalThis!=='undefined'?globalThis:this,function(R,F){
  'use strict';
  const copy=v=>JSON.parse(JSON.stringify(v));
  function create(hooks){
    let runs=[],active=null,manual=false,epoch=0;
    const find=id=>{const r=runs.find(r=>r.id===id);if(!r)throw Error('Unknown run.');return r;};
    const fingerprint=s=>R.digest(s.deck+'\0'+R.canonical(s.ownership||null));
    async function current(){return fingerprint(await hooks.engine().saveProjectModel());}
    async function capture(solver,options={}){
      const e=hooks.engine(),before=epoch,snapshot=await e.saveProjectModel(),deck=await e.exportDeck(),project=snapshot.ownership?.project;
      if(before!==epoch)throw Error('Model changed while capturing the run. Review it again.');
      const checks=e.getProjectSummary().checks.filter(c=>c.status==='invalid');if(checks.length)throw Error('Resolve project checks before solving: '+checks.map(c=>c.name).join(', '));
      const semantic=await e.getAuthoringModel(),coordinates=F.resultCoordinates(semantic);
      const projected=R.profile(deck,solver,options),cases=(project?.objects||[]).filter(o=>o.definition.generator==='static-case-v1').map(o=>({id:o.definition.subcase,name:o.name}));
      const captured=await R.seal({format:'webmesh-analysis-run',version:1,id:crypto.randomUUID(),name:options.name||'Static run '+(runs.length+1),created:new Date().toISOString(),revision:project?.revision||0,units:project?.units||{length:'mm',force:'N',mass:'t',time:'s'},modelDigest:await fingerprint(snapshot),snapshot,deck:projected.deck,deckDigest:await R.digest(projected.deck),profile:projected.profile,cases,coordinates,status:'prepared',result:null});
      if(before!==epoch)throw Error('Model changed while capturing the run. Review it again.');return captured;
    }
    async function launch(candidate){
      await R.validate(candidate);if(candidate.modelDigest!==await current())throw Error('Model changed after run review. Capture a new snapshot.');
      if(runs.some(r=>r.id===candidate.id))throw Error('This run has already been submitted.');
      const response=await hooks.request('/api/solve',{solver:candidate.profile.solver,deck:candidate.deck});
      if(response.deckDigest!==candidate.deckDigest)throw Error('The solver received a different deck.');
      const run=await R.seal({...candidate,job:response.id,solver:response.solver,status:response.status});runs.push(run);hooks.changed?.();return copy(run);
    }
    async function poll(id){
      const run=find(id);if(!['queued','running'].includes(run.status))return copy(run);
      const status=await hooks.request('/api/solve/status',{id:run.job});
      if(status.deckDigest!==run.deckDigest)throw Error('Solver job identity does not match this run.');
      if(['queued','running'].includes(status.status))return{...copy(run),status:status.status,logTail:status.logTail||''};
      const data=await hooks.request('/api/solve/result',{id:run.job});if(data.deckDigest!==run.deckDigest)throw Error('Solver result identity does not match this run.');
      const result={f06:data.f06,log:data.log,digest:await R.digest(data.f06),diagnostics:R.diagnostics(data.f06,data.log,run.coordinates)};
      const next=await R.seal({...run,status:data.status,exitCode:data.exitCode,error:data.error||null,finished:new Date().toISOString(),result});runs[runs.findIndex(r=>r.id===id)]=next;hooks.changed?.();return copy(next);
    }
    async function show(id){
      const run=find(id);if(run.status!=='completed'||!run.result?.f06)throw Error('This run has no completed results.');
      if(run.result.diagnostics.numericalStatus==='failed')throw Error('Fatal solver diagnostics prevent displaying this run.');
      const before=epoch;if(run.modelDigest!==await current())throw Error('These results are stale for the editable model. Open the run snapshot to inspect them.');
      const parsed=await hooks.engine().parseResults(run.result.f06);if(before!==epoch)throw Error('Model changed while reading results.');
      const seen=new Set();for(const set of parsed.resultSets||[]){const c=run.cases.find(c=>c.id===Number(set.subcaseId));if(!c)throw Error('Result subcase does not belong to this run.');set.label=c.name+' · Subcase '+c.id;seen.add(c.id);}
      if(seen.size!==run.cases.length)throw Error('Results are missing one or more requested subcases.');
      hooks.engine().showResults(parsed,run.name);active=id;manual=false;hooks.changed?.();return copy(run);
    }
    function changed(){epoch++;active=null;manual=false;hooks.engine().clearResults();hooks.changed?.();}
    async function restoreSnapshot(id){const run=find(id),kept=runs;await hooks.engine().loadProjectModel(run.snapshot,run.name);runs=kept;active=null;epoch++;hooks.restored?.();return show(id);}
    async function validate(items){if(items!=null&&!Array.isArray(items))throw Error('Invalid saved run list.');const ids=new Set();for(const r of items||[]){await R.validate(r);if(ids.has(r.id))throw Error('Duplicate run identity.');ids.add(r.id);}}
    function checkpoint(){const before={runs,active,manual,epoch};return ()=>{({runs,active,manual,epoch}=before);};}
    async function restore(items){await validate(items);runs=copy(items||[]);active=null;manual=false;epoch++;hooks.changed?.();}
    return{capture,launch,poll,show,restoreSnapshot,restore,validate,checkpoint,changed,current,summaries:()=>runs.map(r=>({id:r.id,name:r.name,status:r.status,solver:r.profile.solver,revision:r.revision})),list:()=>copy(runs),get:id=>copy(find(id)),active:()=>active,manual:()=>manual,unbound:()=>{active=null;manual=true;hooks.changed?.();},clear:()=>{runs=[];changed();},cancel:id=>hooks.request('/api/solve/cancel',{id:find(id).job})};
  }
  return Object.freeze({create});
}));
