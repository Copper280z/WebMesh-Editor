const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app/workbench.js'),'utf8');
const start=source.indexOf('  async function appendCadMesh(');
const appendSource=source.slice(start,source.indexOf('\n  function closeDialog(',start));
const plain=value=>JSON.parse(JSON.stringify(value));

function fixture({owned,properties,materials}){
  const calls=[];
  const engine={getMeshOwner:()=>owned,getNextIds:()=>({node:200,element:300,property:9,material:7}),getState:()=>({properties,materials}),async appendMesh(mesh,options){calls.push(plain({mesh,options}));},fitView(){}};
  const context=vm.createContext({engine:()=>engine,$:()=>null,logOperation(){},message(){}});
  vm.runInContext(appendSource,context);
  const result={mesh:{nodes:[{id:10,x:0,y:0,z:0},{id:20,x:1,y:0,z:0},{id:30,x:0,y:1,z:0}],elements:[{id:1,type:'CTRIA3',pid:11,nodes:[10,20,30]}]}};
  return {calls,result,append:(mesh=result,options={})=>context.appendCadMesh(mesh,'fixture.step',{topology:'tri',order:1,ownerTag:'cad-source',previousMesh:{elements:[5],properties:[3],material:4},...options})};
}

test('CAD regeneration after Undo does not reuse definitions whose freed IDs belong to unrelated geometry',async()=>{
  const f=fixture({owned:{elements:[],properties:[]},properties:[{id:3,type:'PSHELL'}],materials:[{id:4,type:'MAT1'}]});
  const generated=await f.append();const {mesh,options}=f.calls[0];
  assert.deepEqual(mesh.elements[0],{id:300,type:'CTRIA3',pid:9,nodes:[200,201,202]});
  assert.equal(options.material.id,7);assert.equal(options.ownerTag,'cad-source');assert.equal(options.replaceOwner,true);
  assert.deepEqual(plain(generated),{elements:[300],properties:[9],material:7});
});

test('CAD regeneration reuses authoritative live owner properties instead of stale generation IDs',async()=>{
  const f=fixture({owned:{elements:[50],properties:[6]},properties:[{id:3,type:'PSHELL'},{id:6,type:'PSHELL'}],materials:[{id:4,type:'MAT1'}]});
  f.result.mesh.elements.push({id:2,type:'CTRIA3',pid:22,nodes:[10,30,20]});
  await f.append();const {mesh,options}=f.calls[0];
  assert.deepEqual(mesh.elements.map(el=>el.pid),[6,9]);assert.equal(options.material.id,4);
});

test('changing CAD mesh dimension allocates a compatible property even with a live owner',async()=>{
  const f=fixture({owned:{elements:[50],properties:[6]},properties:[{id:6,type:'PSOLID'}],materials:[{id:4,type:'MAT1'}]});
  await f.append();assert.equal(f.calls[0].mesh.elements[0].pid,9);
});
