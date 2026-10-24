// node docs/design/validation/project-workspace/verify.cjs [--unpack]
// Uses the application ownership validator, F06 parser and run-integrity checks.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),O=require(root+'/app/engine-ownership.js'),P=require(root+'/app/part-project.js'),A=require(root+'/app/assembly-project.js'),R=require(root+'/app/analysis-runs.js'),F=require(root+'/app/coordinate-project.js');
const read=name=>fs.readFileSync(path.join(__dirname,name)),unzip=name=>zlib.gunzipSync(read(name)).toString();
const raw=unzip('rover-remesh.webmesh.gz'),p=JSON.parse(raw),state=p.ownership,objects=state.project.objects,map=new Map(objects.map(o=>[o.id,o]));
if(process.argv.includes('--unpack'))fs.writeFileSync(path.join(__dirname,'rover-remesh.webmesh'),raw);
const s={nodes:[],properties:[],materials:[],coords:[],masses:[],elems:Object.fromEntries('tri tri6 quad quad8 tet hex penta pyram rod bar beam bush rbe2 rbe3'.split(' ').map(k=>[k,[]])),loads:{},spc:[],spc1:[],temperatures:[]};
O.putAll(s,objects.flatMap(o=>o.definition.cards||[]));
// The second case uses a directly authored, ordinary LOAD card.
s.loads.combination=[{sid:3,scale:1,entries:[{scale:1,lid:1},{scale:1,lid:2}]}];
O.validate(state,s);
const excluded=new Set(O.analysisExclusions(state,s)),excludedNodes=new Set(O.analysisNodeExclusions(state,s));
const activeNodes=new Map(s.nodes.filter(([id])=>!excludedNodes.has(id))),activeQuads=s.elems.quad.filter(e=>!excluded.has(e.eid));
assert.equal(objects.filter(P.isPart).length,2);assert.equal(objects.filter(P.isInstance).length,4);
assert.equal(objects.filter(A.isTemplate).length,1);assert.equal(p.cadParts.entries.length,2);
assert.equal(excluded.size,680);assert.equal(excludedNodes.size,770);
assert.equal(activeNodes.size,9413);assert.equal(activeQuads.length,8479);
assert.equal(s.elems.rbe2.length,8);assert.equal(s.elems.bush.length,4);assert.equal(s.elems.rbe3.length,2);assert.equal(s.masses.length,6);
assert.equal(new Set(s.elems.bush.map(e=>e.pid)).size,1);
for(const o of objects.filter(o=>o.definition.generator===A.CONNECTION)){
 assert.equal(o.definition.template,'nema17-recipe');assert.deepEqual(o.definition.overrides,{});
 assert.equal(map.get(o.definition.region).definition.resolved.nodes.length,48);
 assert.equal(map.get(o.definition.drivenRegion).definition.resolved.nodes.length,48);
 assert.ok(P.isInstance(map.get(o.definition.placement)));
}
assert.equal(map.get('battery-slots').definition.resolved.nodes.length,40);assert.equal(map.get('payload-holes').definition.resolved.nodes.length,48);
const payload=s.masses.find(([,m])=>m.m===.001)[1],payloadPoint=activeNodes.get(payload.g);assert.equal(payloadPoint.z,227);
assert.equal(map.get('contacts').definition.resolved.nodes.length,80);
assert.ok(s.spc1.every(c=>c.components==='123'));

// Check the remesh transaction independently of the UI: only the wheel mesh,
// its placements and dependent selections/attachments changed.
const before=JSON.parse(unzip('before-remesh.webmesh.gz')),oldMap=new Map(before.ownership.project.objects.map(o=>[o.id,o]));
assert.equal(before.snapshotDigest,p.analysisRuns[0].modelDigest);
const chassisObjects=objects.filter(o=>/Chassis shell/.test(o.name));assert.ok(chassisObjects.length>=2);for(const o of chassisObjects)assert.deepEqual(o,oldMap.get(o.id));
for(const id of ['battery-slots','payload-holes'])assert.deepEqual(map.get(id),oldMap.get(id));
const source=objects.find(o=>o.name==='Wheel shell');assert.ok(source);const oldSource=oldMap.get(source.id);
assert.equal(oldSource.definition.settings.shell.size,2.5);assert.equal(source.definition.settings.shell.size,3);
assert.equal(p.workspace.visibility.objects[source.id],false);
assert.deepEqual(p.workspace.visibility,before.workspace.visibility);
const retired=new Set(objects.filter(o=>o.id===source.id||o.definition.generator===P.MESH).flatMap(o=>(oldMap.get(o.id)?.definition.cards||[]).filter(c=>c.family==='nodes').map(c=>c.id)));
assert.ok(retired.size>0);assert.ok(s.nodes.every(([id])=>!retired.has(id)),'Retired wheel node survived');
const contacts=map.get('contacts').definition.resolved.nodes;
for(const instance of objects.filter(P.isInstance)){
 const mesh=objects.find(o=>o.definition.instance===instance.id&&o.definition.generator===P.MESH);assert.ok(mesh);
 const ids=new Set(mesh.definition.cards.filter(c=>c.family==='nodes').map(c=>c.id));
 assert.equal(contacts.filter(n=>ids.has(n)).length,20,'Contact patch must cover each wheel');
}
assert.ok(contacts.every(n=>activeNodes.has(n)));

// Independent union-find over structural elements and all connection actions.
const parents=new Map([...activeNodes.keys()].map(n=>[n,n]));
function find(n){assert.ok(parents.has(n),'Missing active GRID '+n);let p=parents.get(n);if(p!==n){p=find(p);parents.set(n,p);}return p;}
function connect(nodes){const root=find(nodes[0]);for(const n of nodes.slice(1))parents.set(find(n),root);}
for(const e of activeQuads)connect(e.n);
for(const e of s.elems.bush)connect(e.n);
for(const e of s.elems.rbe2)connect([e.gn,...e.deps]);
for(const e of s.elems.rbe3)connect([e.gn,...e.groups.flatMap(g=>g.gids)]);
assert.equal(new Set([...parents.keys()].map(find)).size,1,'Disconnected analysis model');

// Integrate shell mass independently using two triangles per quadrilateral.
const properties=new Map(s.properties),materials=new Map(s.materials),xyz=id=>{const n=activeNodes.get(id);return[n.x,n.y,n.z];};
const sub=(a,b)=>a.map((v,i)=>v-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
let structuralMass=0;for(const e of activeQuads){const q=e.n.map(xyz),area=Math.hypot(...cross(sub(q[1],q[0]),sub(q[2],q[0])))/2+Math.hypot(...cross(sub(q[2],q[0]),sub(q[3],q[0])))/2,prop=properties.get(e.pid);structuralMass+=area*prop.t*materials.get(prop.mid1).rho;}
const addedMass=s.masses.reduce((n,[,m])=>n+m.m,0),totalMass=structuralMass+addedMass;assert.ok(Math.abs(addedMass-.0029)<1e-12);

async function verify(){
 assert.equal(p.analysisRuns.length,2);for(const saved of p.analysisRuns)await R.validate(saved);const run=p.analysisRuns.at(-1);assert.notEqual(p.analysisRuns[0].modelDigest,p.snapshotDigest);await R.validate(run);assert.equal(run.status,'completed');assert.equal(run.exitCode,0);
 assert.equal(await R.digest(p.deck+'\0'+R.canonical(state)),run.modelDigest);assert.equal(p.snapshotDigest,run.modelDigest);
 assert.equal(read('rover-remesh.bdf').toString(),run.deck);assert.equal(unzip('rover-remesh.F06.gz'),run.result.f06);assert.equal(unzip('solver.log.gz'),run.result.log);
 const counts=Object.fromEntries(['GRID','CQUAD4','RBE2','RBE3','CBUSH','CONM2','PBUSH','CORD2R','SPC1'].map(k=>[k,(run.deck.match(new RegExp('^'+k+',','gm'))||[]).length]));
 assert.deepEqual(counts,{GRID:9413,CQUAD4:8479,RBE2:8,RBE3:2,CBUSH:4,CONM2:6,PBUSH:1,CORD2R:4,SPC1:80});assert.match(run.deck,/^LOAD,3,1\.,1\.,1,1\.,2$/m);
 const d=R.diagnostics(run.result.f06,run.result.log,run.coordinates);assert.deepEqual(d,run.result.diagnostics);assert.equal(d.numericalStatus,'indicator-passed');assert.equal(d.equilibrium.status,'passed');assert.equal(d.equilibrium.cases.length,2);
 const autospc=[...run.result.f06.matchAll(/Number of DOF's identified for AUTOSPC in component\s+(\d)\s+=\s+(\d+)/g)].map(m=>[+m[1],+m[2]]);assert.deepEqual(autospc.slice(0,3),[[1,0],[2,0],[3,0]]);
 for(const line of run.result.f06.split('\n').filter(l=>l.includes('ABS AUTOSPC FORCES'))){assert.ok(line.split(':')[1].trim().split(/\s+/).every(v=>Number(v)===0));}
 const weight=-d.equilibrium.cases[0].applied[2];assert.ok(Math.abs(totalMass*9806.65/weight-1)<.001,'Integrated mass disagrees with OLOAD');
 const c=vm.createContext({self:{postMessage(){}},TextEncoder,TextDecoder,performance,setTimeout,clearTimeout});vm.runInContext(require(root+'/tests/helpers/worker-source.cjs'),c);const result=c.parseF06Results(run.result.f06);F.normalizeResults(result,s);assert.equal(result.resultSets.length,2);
 const cases=[];for(const set of result.resultSets){
  assert.equal(Object.keys(set.displacements).length,activeNodes.size);assert.ok([...activeNodes.keys()].every(n=>set.displacements[n]));
  const shells=Object.entries(set.stresses).filter(([,v])=>v.type==='QUAD4');assert.equal(shells.length,activeQuads.length);
  for(const [,v]of shells)assert.ok(Number.isFinite(v.vonMises)&&v.vonMises>=0);
  for(const e of s.elems.bush){assert.equal(set.stresses[e.eid].vonMises,undefined);assert.ok(set.elementForces[e.eid]);}
  const disp=Object.entries(set.displacements).map(([id,v])=>[+id,Math.hypot(v.t1,v.t2,v.t3)]).sort((a,b)=>b[1]-a[1])[0];
  const stress=shells.map(([id,v])=>[+id,v.vonMises]).sort((a,b)=>b[1]-a[1])[0];
  assert.ok(disp.every(Number.isFinite));cases.push({subcase:set.subcaseId,maxDisplacement:{grid:disp[0],mm:disp[1]},maxShellVonMises:{element:stress[0],MPa:stress[1]}});
 }

 const report={deckSHA256:run.deckDigest,solver:run.solver,counts,connectedComponents:1,structuralMassKg:structuralMass*1000,addedMassKg:addedMass*1000,totalMassKg:totalMass*1000,weightN:weight,autospc,diagnostics:d,cases};
 fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 console.log('PASS: browser remesh, repaired contacts, visibility persistence, saved-run integrity, connected assembly, mass, two MYSTRAN cases and post-processing coverage.');
}
verify().catch(e=>{console.error(e);process.exitCode=1;});
