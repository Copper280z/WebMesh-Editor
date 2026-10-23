const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const F=require('../app/coordinate-project.js'),R=require('../app/analysis-runs.js');
const semantic={nodes:[[10,{x:2,y:0,z:0,cp:0,cd:1234}]],coords:[[1234,{type:'CORD2R',rid:0,origin:[0,0,0],zAxisPt:[1,0,0],xzPlanePt:[0,0,1]}]]};
const table=(title,values)=>` OUTPUT FOR SUBCASE 1\n ${title}\n GRID COORD T1 T2 T3 R1 R2 R3\n SYS\n 10 1234 ${values}\n\n`;
const text=table('D I S P L A C E M E N T S','1 2 3 4 5 6')+table('A P P L I E D   F O R C E S','1 2 3 0 0 0')+table('S P C   F O R C E S','-1 -2 -3 0 0 0');
test('MYSTRAN output frames with four-digit CID parse and transform once to basic vectors',()=>{
 const c=vm.createContext({console,TextEncoder,TextDecoder,performance,setTimeout,clearTimeout,self:{postMessage(){}}});vm.runInContext(require('./helpers/worker-source.cjs'),c);
 const parsed=c.parseF06Results(text),row=parsed.resultSets[0].displacements[10];assert.equal(row.coord,1234);assert.equal(row.t1,1);assert.equal(row.r3,6);
 F.normalizeResults(parsed,semantic);assert.deepEqual([row.t1,row.t2,row.t3,row.r1,row.r2,row.r3],[3,-2,1,6,-5,4]);F.normalizeResults(parsed,semantic);assert.equal(row.t1,3);
 assert.equal(parsed.resultSets[0].oloadForces[10].t3,1);
});
test('reaction balance transforms printed local force/moment components about basic origin',()=>{
 const check=R.equilibrium(text,F.resultCoordinates(semantic));assert.equal(check.status,'passed');assert.deepEqual(check.cases[0].applied,[3,-2,1,0,-2,-4]);
 const bad=R.equilibrium(text,[[10,[2,0,0]]]);assert.equal(bad.status,'not-checked');
 assert.throws(()=>F.normalizeResults({displacements:{10:{coord:999,t1:1,t2:2,t3:3,r1:0,r2:0,r3:0}}},semantic),/unresolved/);
});
