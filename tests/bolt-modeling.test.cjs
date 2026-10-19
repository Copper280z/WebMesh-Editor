const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const modeling = require('../app/modeling.js');
const substrate = () => modeling.createPrimitive({ kind:'block', size:[24,12,2], divisions:[12,6,1], topology:'hex', order:1 });
const options = extra => ({ center:[4,4,1], axis:[0,0,1], grip:2, attachmentRadius:2.1, tolerance:1e-6, pid:2, stiffness:[1e6,2e5,2e5,3e4,4e4,4e4], ...extra });
const combined = (base, bolts) => ({ ...bolts, nodes:base.nodes.concat(bolts.nodes) });

test('CBUSH bolts attach two rigid discs to the existing surface and create an independent local connector', () => {
  const base = substrate(), original = JSON.stringify(base), bolts = modeling.createBoltPattern(base, options());
  assert.equal(JSON.stringify(base), original, 'generation never edits the substrate');
  assert.equal(bolts.nodes.length,2); assert.equal(bolts.elements.length,3);
  assert.equal(bolts.elements[0].type,'CBUSH');
  assert.deepEqual(bolts.elements[0].orient,{kind:'x',x:[1,0,0]});
  assert.deepEqual(bolts.elements.slice(1).map(e=>[e.type,e.cm]),[['RBE2','123'],['RBE2','123']]);
  assert.equal(bolts.bolts[0].headNodes.length,5); assert.equal(bolts.bolts[0].nutNodes.length,5);
  assert.equal(modeling.validateMesh(combined(base,bolts)).valid,true);
  assert.deepEqual(bolts.properties,[{id:2,type:'PBUSH',stiffness:options().stiffness}]);
});

test('linear bolt arrays use pitch vectors and retain disjoint attachment sets', () => {
  const base=substrate(), bolts=modeling.createBoltPattern(base,options({kind:'linear',count:3,pitch:[8,0,0]}));
  assert.deepEqual(bolts.bolts.map(b=>b.center),[[4,4,1],[12,4,1],[20,4,1]]);
  assert.equal(bolts.elements.length,9);
  const attached=bolts.bolts.flatMap(b=>b.headNodes.concat(b.nutNodes));
  assert.equal(new Set(attached).size,attached.length);
});

test('circular bolt centers honor radial direction, start angle, arbitrary axis and partial endpoints', () => {
  const positions=modeling.boltLocations({kind:'circular',center:[10,20,30],axis:[0,1,0],patternAxis:[0,2,0],radialDirection:[0,0,3],radius:5,count:4,startAngle:90,angle:360});
  const expected=[[15,20,30],[10,20,25],[5,20,30],[10,20,35]];
  positions.forEach((p,i)=>p.forEach((v,j)=>assert.ok(Math.abs(v-expected[i][j])<1e-12)));
  const half=modeling.boltLocations({kind:'circular',radius:2,count:3,angle:180,radialDirection:[1,0,0]});
  assert.ok(Math.abs(half[0][0]-2)<1e-12);assert.ok(Math.abs(half[2][0]+2)<1e-12);
  assert.throws(()=>modeling.boltLocations({kind:'circular',patternAxis:[0,0,1],radialDirection:[0,0,1]}),/perpendicular/);
});

test('explicit attachment candidates are filtered spatially without silently attaching unrelated nodes', () => {
  const base=substrate(), head=base.nodes.filter(n=>n.z===0).map(n=>n.id), nut=base.nodes.filter(n=>n.z===2).map(n=>n.id);
  const bolts=modeling.createBoltPattern(base,options({headNodes:head,nutNodes:nut}));
  assert.equal(bolts.bolts[0].headNodes.length,5);
  assert.throws(()=>modeling.createBoltPattern(base,options({headNodes:nut,nutNodes:head})),/head needs at least three/);
});

test('a rod bolt alternative is explicitly axial with zero torsion and a specified area', () => {
  const base=substrate(), bolts=modeling.createBoltPattern(base,options({connection:'CROD',area:12.5}));
  assert.equal(bolts.elements[0].type,'CROD');assert.equal(bolts.area,12.5);assert.equal(bolts.properties,undefined);
  assert.match(modeling.toBdf(combined(base,bolts)),/^PROD,2,1,12.5$/m);
});

test('bolt generation rejects empty discs, collinear attachments, reused IDs and overlapping rigid dependencies', () => {
  const base=substrate();
  for(const changes of [{attachmentRadius:0.1},{center:[100,0,1]},{tolerance:1},{startNode:1},{startElement:1},{stiffness:[0,0,0,0,0,0]},{components:'1123'}])assert.throws(()=>modeling.createBoltPattern(base,options(changes)));
  assert.throws(()=>modeling.createBoltPattern(base,options({kind:'linear',count:2,pitch:[2,0,0]})),/overlapping rigid spiders/);
  const bolts=modeling.createBoltPattern(base,options());
  assert.throws(()=>modeling.createBoltPattern({...base,nodes:base.nodes.concat(bolts.nodes),elements:base.elements.concat(bolts.elements)},options()),/overlapping rigid spiders/);
  const line=base.nodes.filter(n=>n.y===4&&n.z===0).map(n=>n.id);
  assert.throws(()=>modeling.createBoltPattern(base,options({headNodes:line})),/collinear/);
});

test('connector writer roundtrip preserves PBUSH stiffness, orientation and RBE2 components', async () => {
  const base=substrate(), bolts=modeling.createBoltPattern(base,options()), deck=modeling.toBdf(combined(base,bolts));
  assert.match(deck,/^PBUSH,2,K,1000000,200000,200000,30000,40000,40000/m);
  assert.match(deck,/^CBUSH,\d+,2,\d+,\d+,1\.,0\.,0\.,/m);
  const worker=vm.createContext({Map,Set,self:{postMessage(){}},TextEncoder,TextDecoder,performance,setTimeout,clearTimeout});
  vm.runInContext(require('./helpers/worker-source.cjs'),worker);
  const parsed=await worker.parseDeckToCardStream(deck,'bolts.bdf',{}, {strictMode:true,retainParseSession:true,retainSourceSession:false});
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.errors)),[]);
  const indexes=worker.getParseSession(parsed.model.parseSessionId).indexes;
  assert.equal(indexes.elements.size,3);
  const bush=[...indexes.elements.values()].find(e=>e.type==='CBUSH');
  assert.deepEqual(JSON.parse(JSON.stringify(bush.orient)),{kind:'x',x:[1,0,0]});
  const property=indexes.properties.get(2);
  assert.equal(property.K1,1e6);assert.equal(property.K6,4e4);
  assert.ok([...indexes.elements.values()].filter(e=>e.type==='RBE2').every(e=>e.cm==='123'));
});

test('rotating a connector assembly preserves orientations and rigid DOFs', () => {
  const base=substrate(), bolts=modeling.createBoltPattern(base,options()), mesh=combined(base,bolts);
  const patterned=modeling.circularPattern(mesh,{count:2,angle:180,axis:[0,0,1],center:[0,0,0],includeSeed:false,startNode:1000,startElement:1000});
  const bush=patterned.elements.find(e=>e.type==='CBUSH');
  assert.ok(Math.abs(bush.orient.x[0]+1)<1e-12);
  assert.ok(patterned.elements.filter(e=>e.type==='RBE2').every(e=>e.cm==='123'));
});
