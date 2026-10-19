const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modeling = require('../app/modeling.js');
const {createPrimitive,linearPattern,circularPattern,validateMesh,toBdf}=modeling;

const close=(a,b,tolerance=1e-10)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} should equal ${b}`);
const xyz=n=>[n.x,n.y,n.z];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const tetVolume=p=>dot(sub(p[1],p[0]),cross(sub(p[2],p[0]),sub(p[3],p[0])))/6;
const coords=mesh=>new Map(mesh.nodes.map(n=>[n.id,xyz(n)]));
const tetraVolume=mesh=>{const p=coords(mesh);return mesh.elements.reduce((sum,e)=>sum+tetVolume(e.nodes.slice(0,4).map(id=>p.get(id))),0);};

test('UMD build exposes the same browser APIs without a bundler',()=>{
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../app/modeling.js'),'utf8'),context);
  assert.equal(typeof context.WebMeshModeling.createPrimitive,'function');
  const p=context.WebMeshModeling.createPrimitive({kind:'plate',divisions:[1,1,1]});
  assert.equal(p.nodes.length,4);
});

test('structured rectangular shell has analytic boundary count and conforming midsides',()=>{
  for(const topology of ['quad','tri']) for(const order of [1,2]) {
    const mesh=createPrimitive({kind:'plate',topology,order,size:[6,4,0],divisions:[3,2,1],origin:[1,-2,3],startNode:100,startElement:200,pid:9});
    const report=validateMesh(mesh);
    assert.equal(report.valid,true,report.errors.join('\n'));
    assert.equal(report.stats.freeEdges,10);
    assert.equal(mesh.elements.length,topology==='quad'?6:12);
    assert.equal(mesh.nodes[0].id,100);
    assert.deepEqual(xyz(mesh.nodes[0]),[1,-2,3]);
    assert.equal(mesh.elements[0].id,200);
    assert.ok(mesh.elements.every(e=>e.pid===9));
    if(topology==='quad'&&order===2) assert.equal(mesh.nodes.length,12+9+8);
    if(topology==='tri'&&order===2) assert.equal(mesh.nodes.length,12+9+8+6);
  }
});

test('hex block follows Nastran order with positive Jacobian and shared corner nodes',()=>{
  const mesh=createPrimitive({kind:'block',topology:'hex',size:[2,3,4],divisions:[2,1,1]});
  assert.equal(mesh.nodes.length,12);
  assert.equal(mesh.elements.length,2);
  assert.deepEqual(mesh.elements[0].nodes,[1,2,5,4,7,8,11,10]);
  const report=validateMesh(mesh);
  assert.equal(report.valid,true);
  assert.equal(report.stats.boundaryFaces,10);
  const p=coords(mesh), e=mesh.elements[0];
  close(dot(sub(p.get(e.nodes[1]),p.get(e.nodes[0])),cross(sub(p.get(e.nodes[3]),p.get(e.nodes[0])),sub(p.get(e.nodes[4]),p.get(e.nodes[0])))),12);
});

test('quadratic hex stores 12 Nastran edge nodes and shares interfaces',()=>{
  const mesh=createPrimitive({kind:'block',topology:'hex',order:2,size:[2,3,4],divisions:[2,1,1]});
  assert.equal(mesh.nodes.length,32);
  const p=coords(mesh),edges=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  for(const e of mesh.elements) {
    assert.equal(e.type,'CHEXA20');
    edges.forEach(([a,b],i)=>p.get(e.nodes[8+i]).forEach((v,j)=>close(v,(p.get(e.nodes[a])[j]+p.get(e.nodes[b])[j])/2)));
  }
  const a=new Set(mesh.elements[0].nodes), shared=mesh.elements[1].nodes.filter(id=>a.has(id));
  assert.equal(shared.length,8);
});

test('tetrahedra fill structured blocks exactly and agree on all internal face diagonals',()=>{
  for(const order of [1,2]) {
    const mesh=createPrimitive({kind:'block',topology:'tet',order,size:[2,3,4],divisions:[2,2,2]});
    const p=coords(mesh);
    mesh.elements.forEach(e=>assert.ok(tetVolume(e.nodes.slice(0,4).map(id=>p.get(id)))>0));
    close(tetraVolume(mesh),24);
    const report=validateMesh(mesh);
    assert.equal(report.valid,true);
    // Every exterior rectangular face is split into two triangles.
    assert.equal(report.stats.boundaryFaces,2*(2*2+2*2+2*2)*2);
    assert.equal(report.stats.nonManifoldFaces,0);
  }
});

test('CTETRA10 midsides follow Nastran ordering',()=>{
  const mesh=createPrimitive({kind:'block',topology:'tet',order:2,divisions:[1,1,1]});
  const p=coords(mesh),edges=[[0,1],[1,2],[2,0],[0,3],[1,3],[2,3]];
  for(const e of mesh.elements)edges.forEach(([a,b],i)=>p.get(e.nodes[4+i]).forEach((v,j)=>close(v,(p.get(e.nodes[a])[j]+p.get(e.nodes[b])[j])/2)));
});

test('mapped solid cylinders avoid center singularities and remain conforming',()=>{
  const segments=24, radius=3, length=5;
  const expectedArea=(()=>{const n=segments/4,angles=[];for(let i=0;i<n;i++)angles.push(Math.atan2(-1,-1+2*i/n));for(let j=0;j<n;j++)angles.push(Math.atan2(-1+2*j/n,1));for(let i=n;i>0;i--)angles.push(Math.atan2(1,-1+2*i/n));for(let j=n;j>0;j--)angles.push(Math.atan2(-1+2*j/n,-1));return angles.reduce((a,t,i)=>a+radius*radius*Math.sin(angles[(i+1)%angles.length]-t)/2,0);})();
  for(const topology of ['hex','tet'])for(const order of [1,2]) {
    const mesh=createPrimitive({kind:'cylinder',topology,order,radius,length,segments,radialDivisions:2,axialDivisions:3});
    const report=validateMesh(mesh);
    assert.equal(report.valid,true,report.errors.join('\n'));
    assert.equal(report.stats.nonManifoldFaces,0);
    if(topology==='tet')close(tetraVolume(mesh),expectedArea*length,1e-8);
    if(order===1) assert.ok(mesh.nodes.every(n=>Math.hypot(n.x,n.y)<=radius+1e-10));
  }
});

test('hollow cylinders have the expected polygonal volume and boundary topology',()=>{
  const mesh=createPrimitive({kind:'annulus',topology:'tet',radius:3,innerRadius:1,length:5,segments:16,radialDivisions:2,axialDivisions:3});
  close(tetraVolume(mesh),16/2*Math.sin(2*Math.PI/16)*(9-1)*5,1e-9);
  const report=validateMesh(mesh);
  assert.equal(report.valid,true);
  // Inner + outer walls, and two annular caps, two triangles per quad.
  assert.equal(report.stats.boundaryFaces,(2*16*3+2*16*2)*2);
});

test('cylinder shells close the seam and curved quadratic edges lie on the radius',()=>{
  for(const topology of ['quad','tri']) {
    const mesh=createPrimitive({kind:'cylinder',topology,order:2,radius:3,length:4,segments:12,axialDivisions:2});
    const report=validateMesh(mesh);
    assert.equal(report.valid,true);
    assert.equal(report.stats.freeEdges,24);
    const p=coords(mesh);
    mesh.elements.forEach(e=>{
      const corners=topology==='quad'?4:3;
      const edges=topology==='quad'?[[0,1],[1,2],[2,3],[3,0]]:[[0,1],[1,2],[2,0]];
      edges.forEach(([a,b],i)=>{if(p.get(e.nodes[a])[2]===p.get(e.nodes[b])[2])close(Math.hypot(...p.get(e.nodes[corners+i]).slice(0,2)),3);});
    });
  }
});

test('2D annuli retain both boundary loops',()=>{
  for(const topology of ['quad','tri']) {
    const mesh=createPrimitive({kind:'annulus',topology,segments:16,radialDivisions:3});
    assert.equal(validateMesh(mesh).stats.freeEdges,32);
    assert.ok(mesh.nodes.every(n=>n.z===0));
  }
});

test('linear pattern counts include seed and positive tolerance welds neighboring copies',()=>{
  const source=createPrimitive({kind:'plate',size:[1,1,0],divisions:[1,1,1],order:2});
  const options={counts:[2,3,1],vectors:[[1,0,0],[0,1,0],[0,0,1]]};
  const separate=linearPattern(source,options), welded=linearPattern(source,{...options,mergeTolerance:1e-8});
  assert.equal(separate.nodes.length,source.nodes.length*6);
  assert.equal(welded.elements.length,6);
  assert.equal(welded.nodes.length,29); // 12 corners, 9 horizontal + 8 vertical edge nodes
  assert.equal(validateMesh(welded).stats.freeEdges,10);
  assert.equal(validateMesh(welded).valid,true);
  assert.equal(source.nodes.length,8,'seed is unchanged');
});

test('linear 3D pattern merges a structured array into a conforming volume',()=>{
  const seed=createPrimitive({kind:'block',size:[1,1,1],divisions:[1,1,1]});
  const mesh=linearPattern(seed,{counts:[2,3,4],vectors:[[1,0,0],[0,1,0],[0,0,1]],mergeTolerance:1e-9});
  assert.equal(mesh.nodes.length,3*4*5);
  assert.equal(mesh.elements.length,24);
  assert.equal(validateMesh(mesh).stats.boundaryFaces,2*(2*3+2*4+3*4));
});

test('append-only patterns retain original IDs and weld to the seed',()=>{
  const seed=createPrimitive({kind:'plate',size:[1,1,0],divisions:[1,1,1],startNode:100,startElement:300});
  const copies=linearPattern(seed,{includeSeed:false,counts:[2,1,1],vectors:[[1,0,0],[0,1,0],[0,0,1]],mergeTolerance:1e-8});
  assert.equal(copies.nodes.length,2);
  assert.equal(copies.elements.length,1);
  assert.equal(copies.nodes[0].id,104);
  assert.equal(copies.elements[0].id,301);
  const combined={nodes:seed.nodes.concat(copies.nodes),elements:seed.elements.concat(copies.elements)};
  assert.equal(validateMesh(combined).valid,true);
  assert.equal(validateMesh(combined).stats.freeEdges,6);
  const none=linearPattern(seed,{includeSeed:false,counts:[1,1,1]});
  assert.equal(none.nodes.length,0);
  assert.equal(none.elements.length,0);
});

test('append-only selected patterns weld to unselected model nodes and can add zero nodes',()=>{
  const seed=createPrimitive({kind:'plate',size:[1,1,0],divisions:[1,1,1]});
  const otherNodes=[{id:20,x:2,y:0,z:0},{id:21,x:2,y:1,z:0}];
  const copies=linearPattern(seed,{includeSeed:false,counts:[2,1,1],vectors:[[1,0,0],[0,1,0],[0,0,1]],mergeTolerance:1e-9,mergeNodes:seed.nodes.concat(otherNodes)});
  assert.equal(copies.nodes.length,0);
  assert.equal(copies.elements.length,1);
  assert.ok(copies.elements[0].nodes.includes(20));
  assert.ok(copies.elements[0].nodes.includes(21));
  const combined={nodes:seed.nodes.concat(otherNodes),elements:seed.elements.concat(copies.elements)};
  assert.equal(validateMesh(combined).valid,true);
  assert.equal(validateMesh(combined).stats.freeEdges,6);
  assert.throws(()=>linearPattern(seed,{mergeNodes:otherNodes}),/includeSeed/);
  assert.throws(()=>linearPattern(seed,{includeSeed:false,mergeNodes:[{id:1,x:999,y:0,z:0}]}),/Conflicting coordinates/);
});

test('canonical imported solid names work after engine readback',()=>{
  for(const topology of ['hex','tet'])for(const order of [1,2]) {
    const source=createPrimitive({kind:'block',topology,order,size:[1,1,1],divisions:[1,1,1]});
    source.elements.forEach(e=>e.type=topology==='hex'?'CHEXA':'CTETRA');
    assert.equal(validateMesh(source).valid,true);
    const copies=linearPattern(source,{includeSeed:false,counts:[2,1,1],vectors:[[1,0,0],[0,1,0],[0,0,1]],mergeTolerance:1e-9});
    const combined={nodes:source.nodes.concat(copies.nodes),elements:source.elements.concat(copies.elements)};
    const report=validateMesh(combined);
    assert.equal(report.valid,true,report.errors.join('\n'));
    assert.equal(copies.elements.length,source.elements.length);
    assert.match(toBdf(source),topology==='hex'?/CHEXA,/:/CTETRA,/);
  }
});

test('rod patterns retain property assignment while advanced structural types give explicit limits',()=>{
  const rod={nodes:[{id:1,x:0,y:0,z:0},{id:2,x:1,y:0,z:0}],elements:[{id:1,type:'CROD',pid:1,nodes:[1,2]}]};
  assert.equal(validateMesh(rod).valid,true);
  const copies=linearPattern(rod,{counts:[3,1,1],mergeTolerance:1e-9});
  assert.equal(copies.nodes.length,4);
  assert.equal(copies.elements.length,3);
  assert.ok(copies.elements.every(e=>e.pid===1));
  assert.match(toBdf(copies,{area:2}),/PROD,1,1,2/);
  for(const type of ['CBAR','CBEAM','CBUSH','RBE2','RBE3']) {
    const unsupported={...rod,elements:[{...rod.elements[0],type}]};
    const report=validateMesh(unsupported);
    assert.equal(report.valid,false);
    assert.match(report.errors.join(' '),/card editor for other structural types/);
    assert.throws(()=>linearPattern(unsupported),/mesh checker and pattern tool support/);
  }
});

test('circular pattern rotates around an arbitrary axis and respects partial sweep endpoints',()=>{
  const seed=createPrimitive({kind:'plate',size:[1,1,0],divisions:[1,1,1],origin:[2,0,0]});
  const full=circularPattern(seed,{count:4,axis:[0,0,5],center:[1,0,0],angle:360,startNode:10,startElement:20});
  assert.equal(full.elements.length,4);
  assert.equal(full.nodes[0].id,10);
  close(full.nodes[4].x,1);close(full.nodes[4].y,1);
  close(full.nodes[12].x,1);close(full.nodes[12].y,-1);
  const arc=circularPattern(seed,{count:3,axis:[1,0,0],angle:90});
  close(arc.nodes[10].y,0);close(arc.nodes[10].z,1);
  const tinyAxis=circularPattern(seed,{count:4,axis:[0,0,5e-324]});
  const hugeAxis=circularPattern(seed,{count:4,axis:[0,0,1.7e308]});
  close(tinyAxis.nodes[4].x,0);close(tinyAxis.nodes[4].y,2);
  close(hugeAxis.nodes[4].x,0);close(hugeAxis.nodes[4].y,2);
  assert.equal(validateMesh(full).valid,true);
});

test('BDF export uses valid property cards and eight-field labeled continuations',()=>{
  const mesh=createPrimitive({kind:'block',topology:'hex',order:2,divisions:[1,1,1],pid:7});
  const text=toBdf(mesh,{material:{id:9,E:70000,nu:0.33,rho:2.7e-9}});
  assert.match(text,/MAT1,9,70000,,0.33,2.7e-9/);
  assert.match(text,/PSOLID,7,9/);
  assert.match(text,/CHEXA,1,7,1,2,4,3,5,6,\+W1\n\+W1,8,7,/);
  const lines=text.trim().split('\n');
  for(const line of lines)if(!line.startsWith('$'))assert.ok(line.split(',').length<=10);
  const deck=[];
  for(const line of lines) {
    if(line.startsWith('$')||line==='BEGIN BULK'||line==='ENDDATA')continue;
    const fields=line.split(','), last=fields[fields.length-1];
    if(last.startsWith('+'))fields.pop();
    if(fields[0].startsWith('+'))deck[deck.length-1].push(...fields.slice(1));
    else deck.push(fields);
  }
  const hex=deck.find(c=>c[0]==='CHEXA');
  assert.deepEqual(hex.slice(3).map(Number),mesh.elements[0].nodes);
  const shell=toBdf(createPrimitive({kind:'plate',order:2,divisions:[1,1,1]}),{thickness:0.5});
  assert.match(shell,/PSHELL,1,1,0.5/);
  assert.match(shell,/CQUAD8,1,1,/);
  const tet=toBdf(createPrimitive({kind:'block',topology:'tet',order:2,divisions:[1,1,1]}));
  assert.match(tet,/CTETRA,1,1,/);
  assert.doesNotMatch(tet,/CTETRA10/);
});

test('validation detects inverted cells, damaged midsides, missing references, and duplicate IDs',()=>{
  const mesh=createPrimitive({kind:'block',topology:'hex',divisions:[1,1,1]});
  [mesh.elements[0].nodes[0],mesh.elements[0].nodes[1]]=[mesh.elements[0].nodes[1],mesh.elements[0].nodes[0]];
  assert.equal(validateMesh(mesh).stats.degenerateElements,1);
  const shell=createPrimitive({kind:'plate',order:2,divisions:[2,1,1]});
  const p=coords(shell), edge=shell.elements[0].nodes[5], original=shell.nodes.find(n=>n.id===edge);
  shell.nodes.push({...original,id:1000});
  const sharedIndex=shell.elements[1].nodes.indexOf(edge);
  assert.ok(sharedIndex>=0);
  shell.elements[1].nodes[sharedIndex]=1000;
  assert.ok(validateMesh(shell).errors.some(e=>e.includes('Nonconforming midside')));
  shell.nodes.push({...shell.nodes[0]});
  shell.elements[0].nodes[0]=99999;
  const errors=validateMesh(shell).errors.join(' ');
  assert.match(errors,/Duplicate node ID/);
  assert.match(errors,/missing nodes/);
});

test('invalid input and excessive output fail before creating nonsensical meshes',()=>{
  const cases=[
    {kind:'plate',topology:'hex'}, {kind:'block',topology:'quad'},
    {kind:'cone'}, {kind:'annulus',radius:2,innerRadius:3},
    {kind:'cylinder',topology:'hex',segments:15},
    {kind:'block',size:[0,1,1]}, {kind:'plate',divisions:[2.5,1,1]},
    {kind:'block',divisions:[1000,1000,1000]}, {kind:'plate',order:3},
    {kind:'block',origin:[Infinity,0,0]}, {kind:'plate',origin:[1e30,0,0],size:[1,1,0]}
  ];
  cases.forEach(options=>assert.throws(()=>createPrimitive(options),Error));
  const seed=createPrimitive({kind:'plate',divisions:[1,1,1]});
  assert.throws(()=>linearPattern(seed,{counts:[2,1,1],vectors:[[0,0,0],[0,1,0],[0,0,1]]}),/zero spacing/);
  assert.throws(()=>linearPattern(seed,{counts:[1000000,1,1]}),/limit|Too many/);
  assert.throws(()=>linearPattern(seed,{mergeTolerance:-1}),/negative/);
  assert.throws(()=>linearPattern(seed,{mergeTolerance:100}),/invalid mesh/);
  assert.throws(()=>circularPattern(seed,{axis:[0,0,0]}),/cannot be zero/);
  assert.throws(()=>circularPattern(seed,{angle:361}),/360/);
  assert.throws(()=>toBdf(seed,{material:{nu:0.5}}),/Poisson/);
});
