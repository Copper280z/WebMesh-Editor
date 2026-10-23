const {test}=require('node:test');
const assert=require('node:assert/strict');
const A=require('../app/connection-actions.js');
const nodes=[{id:1,x:0,y:0,z:0},{id:2,x:20,y:0,z:0},{id:3,x:0,y:20,z:0},{id:4,x:20,y:20,z:0}];
test('payload composition is the same point/mass/distribution action sequence and leaves inputs untouched',()=>{
  const steps=[{action:'point',id:5,position:[10,10,200]},{action:'mass',id:1,node:5,mass:.001},{action:'rbe3',id:2,node:5,groups:[{wt:1,c:'123',gids:[1,2]},{wt:2,c:'123',gids:[3,4]}]}],before=JSON.stringify({nodes,steps}),r=A.execute(nodes,steps);
  assert.deepEqual(r.cards.map(c=>c.family),['nodes','masses','elems']);assert.equal(r.cards[1].value.m,.001);assert.deepEqual(r.cards[2].value.groups,steps[2].groups);assert.equal(JSON.stringify({nodes,steps}),before);
  assert.deepEqual(r.actions,steps);
});
test('mass and length suffixes convert to stored model units and reject nonfinite/unsupported values',()=>{
  const units={mass:'t',length:'mm'};
  assert.equal(A.quantity('500 g','mass',units),.0005);assert.equal(A.quantity('1 kg','mass',units),.001);assert.equal(A.quantity('0.2 m','length',units),200);assert.equal(A.quantity('2 in','length',units),50.8);
  assert.equal(A.quantity('5e-4','mass',units),.0005);assert.equal(A.quantity('1 t','mass',{mass:'kg'}),1000);
  for(const v of ['','Infinity','5 kg rubbish','1 kg/s','NaN','1e999'])assert.throws(()=>A.quantity(v,'mass',units));
});
test('CONM2 inertia and offsets are validated physically about the mass COM',()=>{
  const r=A.massValue({id:1,node:1,mass:.001,offset:[1,2,200],inertia:[1,.1,2,.2,.3,2]});assert.deepEqual(r.x,[1,2,200]);assert.equal(r.cid,0);
  for(const values of [[-1,0,1,0,0,1],[10,0,1,0,0,1],[1,4,1,0,0,1],[1,0,1,0,0,NaN]])assert.throws(()=>A.inertia(values));
  for(const m of [0,-1,NaN,Infinity])assert.throws(()=>A.massValue({id:1,node:1,mass:m}));
  assert.deepEqual(A.inertia([1,0,1,0,0,0]),[1,0,1,0,0,0]);
});
test('RBE3 rejects invalid groups, overlap, self-support, nonbasic and collinear nodes',()=>{
  const base={action:'rbe3',id:2,node:5,groups:[{wt:1,c:'123',gids:[1,2,3]}]},source=[...nodes,{id:5,x:10,y:10,z:200}];
  for(const groups of [[{wt:0,c:'123',gids:[1,2,3]}],[{wt:1,c:'456',gids:[1,2,3]}],[{wt:1,c:'123',gids:[1,2,5]}],[{wt:1,c:'123',gids:[1,2,3]},{wt:1,c:'123',gids:[3,4]}]])assert.throws(()=>A.execute(source,[{...base,groups}]));
  assert.throws(()=>A.execute(source.map(n=>({...n,y:0})),[base]),/collinear/);
  assert.throws(()=>A.execute(source.map(n=>({...n,cd:1})),[base]),/basic/);
});
