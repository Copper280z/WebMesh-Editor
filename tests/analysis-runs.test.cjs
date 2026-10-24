const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const R=require('../app/analysis-runs.js'),Session=require('../app/analysis-session.js');
const clone=v=>JSON.parse(JSON.stringify(v));
const deck='SOL 101\nCEND\nSUBCASE 1\n LOAD = 1\n SPC = 1\nBEGIN BULK\nGRID,1,,0.,0.,0.\nPSOLID,1,1\nMAT1,1,210000.,,0.3,7.85e-9\n+\nENDDATA\n';
function fixture(){
 let model={deck,ownership:{project:{revision:2,objects:[{name:'Gravity',definition:{generator:'static-case-v1',subcase:1}}]}}},shown=null,clears=0,parsed={resultSets:[{subcaseId:1}]};
 const engine={saveProjectModel:async()=>clone(model),exportDeck:async()=>model.deck,getAuthoringModel:async()=>({nodes:[[1,{x:0,y:0,z:0,cp:0,cd:0}]]}),getProjectSummary:()=>({checks:[]}),parseResults:async()=>clone(parsed),showResults:(r)=>{shown=r;},clearResults:()=>{shown=null;clears++;},loadProjectModel:async s=>{model=clone(s);session.changed();}};
 let received,status='completed',result='OUTPUT FOR SUBCASE 1\nEPSILON ERROR ESTIMATE = 1.0E-14\n';
 const request=async(path,data)=>{if(path==='/api/solve'){received=data;return {id:'job',status:'queued',deckDigest:await R.digest(data.deck),solver:{id:data.solver,path:'/configured/mystran',sha256:'a'.repeat(64)}};}return{status,deckDigest:await R.digest(received.deck),f06:result,log:'0 FATAL ERRORS',exitCode:0};};
 const session=Session.create({engine:()=>engine,request});
 return{session,engine,edit:()=>{model.deck=model.deck.replace('210000.','200000.');session.changed();},parsed:v=>{parsed=v;},status:v=>{status=v;},result:v=>{result=v;},shown:()=>shown,clears:()=>clears};
}
test('solver profile is a detached explicit compatibility projection',()=>{
 const p=R.profile(deck,'mystran',{autospc:true});assert.match(p.deck,/PSOLID,1,1,,2/);assert.match(p.deck,/PARAM,AUTOSPC,YES/);assert.doesNotMatch(p.deck,/^\+$/m);assert.match(deck,/^\+$/m);
 assert.throws(()=>R.profile(deck+'INCLUDE xyz','mystran'),/self-contained/);assert.throws(()=>R.profile(deck,'unknown'),/MYSTRAN/);
 const repeated=R.profile(p.deck,'mystran',{autospc:false});assert.equal(repeated.deck.match(/AUTOSPC/g).length,1);assert.match(repeated.deck,/AUTOSPC,NO/);
});
test('run lifecycle preserves exact input, blocks stale display, restores snapshot and survives save/reopen',async()=>{
 const f=fixture(),s=f.session,c=await s.capture('mystran',{name:'Loaded beam',autospc:true}),original=clone(c);
 let run=await s.launch(c);assert.deepEqual(c,original);assert.equal(run.status,'queued');run=await s.poll(run.id);assert.equal(run.status,'completed');await R.validate(run);
 await s.show(run.id);assert.equal(f.shown().resultSets[0].label,'Gravity · Subcase 1');assert.equal(s.active(),run.id);
 s.unbound();assert.equal(s.active(),null);assert.equal(s.manual(),true);await s.show(run.id);
 f.edit();assert.equal(f.shown(),null);await assert.rejects(s.show(run.id),/stale/);await assert.rejects(s.launch(c),/changed/);
 await s.restoreSnapshot(run.id);assert.equal(s.active(),run.id);assert.deepEqual(s.get(run.id).snapshot,original.snapshot);
 const saved=s.list();await s.restore(saved);assert.equal(s.active(),null);await s.show(run.id);assert.equal(f.shown().resultSets.length,1);
 for(const mutate of [r=>r.deck+='x',r=>r.snapshot.deck+='x',r=>r.result.f06+='x',r=>r.name='tampered']){const bad=clone(run);mutate(bad);await assert.rejects(s.restore([bad]),/digest|integrity/);assert.equal(s.list().length,1);}
 await assert.rejects(s.validate([run,run]),/Duplicate/);await assert.rejects(s.validate({}),/list/);
});
test('failed, cancelled, fatal and mismatched subcase results cannot acquire run provenance',async()=>{
 for(const state of ['failed','cancelled']){const f=fixture(),c=await f.session.capture('mystran'),r=await f.session.launch(c);f.status(state);await f.session.poll(r.id);await assert.rejects(f.session.show(r.id),/no completed/);assert.equal(f.shown(),null);}
 const f=fixture(),r=await f.session.launch(await f.session.capture('mystran'));f.result('FATAL ERROR: matrix failure');await f.session.poll(r.id);await assert.rejects(f.session.show(r.id),/Fatal/);
 const g=fixture(),good=await g.session.launch(await g.session.capture('mystran'));await g.session.poll(good.id);g.parsed({resultSets:[{subcaseId:99}]});await assert.rejects(g.session.show(good.id),/does not belong/);g.parsed({resultSets:[]});await assert.rejects(g.session.show(good.id),/missing/);
});
test('capture invalidated by a concurrent model edit cannot be launched',async()=>{
 const f=fixture();f.engine.getAuthoringModel=async()=>{f.edit();return {nodes:[]};};await assert.rejects(f.session.capture('mystran'),/changed/);
});
test('numerical indicators and independent applied/reaction resultant balance are distinct',()=>{
 const text='OUTPUT FOR SUBCASE 1\nAPPLIED FORCES\n 2 0 0.0 0.0 -10.0 0.0 0.0 0.0\nSPC FORCES\n 1 0 0.0 0.0 10.0 0.0 -20.0 0.0\nEPSILON ERROR ESTIMATE = 1.0E-14\n';
 const coords=[[1,[0,0,0]],[2,[2,0,0]]],d=R.diagnostics(text,'0 FATAL ERRORS',coords);assert.equal(d.numericalStatus,'indicator-passed');assert.equal(d.equilibrium.status,'passed');
 assert.equal(R.diagnostics(text.replace('-20.0','-10.0'),'',coords).equilibrium.status,'failed');assert.equal(R.diagnostics(text,'',null).equilibrium.status,'not-checked');assert.equal(R.diagnostics(text,'relative residual = 0.01',coords).numericalStatus,'check-failed');
});
test('MYSTRAN projection fits small signed decimals and expands mixed SPC1 ranges without changing memberships',()=>{
 const input=deck.replace('GRID,1,,0.,0.,0.','GRID,1,,-0.00001234567890123,1.234567890123e-25,0.\nSPC1,3,123,1,THRU,3,8,10\n+,THRU,12,20\nCBUSH,9,1,1,2,0.,1.,0.,4');const p=R.profile(input,'mystran',{autospc:true});
 assert.deepEqual(p.deck.split('\n').filter(l=>l.startsWith('SPC1,')).map(l=>Number(l.split(',')[3])),[1,2,3,8,10,11,12,20]);const grid=p.deck.split('\n').find(l=>l.startsWith('GRID,')).split(',');assert.ok(grid.every(v=>v.length<=16));assert.ok(Math.abs(Number(grid[3])/(-0.00001234567890123)-1)<1e-10);assert.match(p.deck,/CBUSH,9,1,1,2,,,,4/);
 assert.throws(()=>R.profile(input.replace('THRU,3','THRU,0'),'mystran'),/range/);
});
test('equilibrium scales cancelling components by contributing loads and retains a separate print bound',()=>{
 const text='OUTPUT FOR SUBCASE 1\nAPPLIED FORCES\n1 0 0.0 0.0 -1.000000E+00 0.0 0.0 0.0\n2 0 0.0 0.0 -1.000000E+00 0.0 0.0 0.0\nSPC FORCES\n1 0 0.0 0.0 1.000001E+00 0.0 0.0 0.0\n2 0 0.0 0.0 9.999990E-01 0.0 0.0 0.0\n';
 const coords=[[1,[-100,0,0]],[2,[100,0,0]]],r=R.equilibrium(text,coords);assert.equal(r.status,'passed');assert.equal(r.cases[0].strictResultantPassed,false);assert.equal(r.cases[0].scale[4],200);assert.ok(r.cases[0].printBound[4]>0);assert.ok(Math.abs(r.cases[0].normalizedResidual[4])<1e-5);
 assert.equal(R.equilibrium(text.replace('9.999990E-01','9.900000E-01'),coords).status,'failed');
});
