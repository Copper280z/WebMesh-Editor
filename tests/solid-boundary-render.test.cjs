const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const modeling=require('../app/modeling.js');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'app/editor-engine.js'),'utf8');
const vendor=vm.createContext({window:{},console,performance});vm.runInContext(fs.readFileSync(path.join(root,'vendor/three-runtime.js'),'utf8'),vendor);
const THREE=vendor.window.WebMeshThree;
const helpers=source.slice(source.indexOf('  function semanticSolidFaceKey('),source.indexOf('  function buildGeometries(preserveView'));
const center=source.slice(source.indexOf('  function quadraticQuadCenter('),source.indexOf('  function buildGeometriesFromCoreSoa('));
const start=source.indexOf('    const workerSurf =',source.indexOf('  function buildGeometries(preserveView'));
const rendering=source.slice(start,source.indexOf('    try {\n      const surf = workerSurf;',start));
function render(mesh,{hiddenIds=[],shown={},clipping=false}={}) {
  const nodes=new Map(mesh.nodes.map(n=>[n.id,n])),indexToNid=[...nodes.keys()],nodeIndex=new Map(indexToNid.map((id,i)=>[id,i]));
  const elems={hex:[],tet:[],penta:[],pyram:[]};
  for(const e of mesh.elements){const bucket=e.type.startsWith('CHEXA')?'hex':e.type.startsWith('CTETRA')?'tet':e.type==='CPENTA'?'penta':'pyram';elems[bucket].push({eid:e.id,pid:e.pid,type:e.type,n:e.nodes});}
  const messages=[],context=vm.createContext({...THREE,Map,Set,window:{__WEBMESH_EDITOR_RENDER_STATS__:{}},model:{nodes,indexToNid,nodeIndex,elems},N:nodes.size,pos:Float32Array.from(mesh.nodes.flatMap(n=>[n.x,n.y,n.z])),
    coreSoa:null,hidden:{elems:new Set(hiddenIds)},visibility:{chexa:true,ctetra:true,cpenta:true,cpyram:true,edges:true,...shown},usePropColors:true,contourNodeColors:null,contourContinuous:true,contourElementColorByEid:new Map(),
    scene:new THREE.Scene(),renderer:{localClippingEnabled:clipping},meshSolid:null,clippingPlane:new THREE.Plane(new THREE.Vector3(1,0,0),0),shadingToggle:{},getToggleOn:()=>true,getPropColor:()=>[0.2,0.5,0.8],updateOpacity(){},statusMsg:msg=>messages.push(msg)});
  vm.runInContext(helpers+center+rendering+'\nglobalThis.result={meshSolid,solidFaceToElem,solidEdgePositions,triangles:solidIndices.length/3,skipSolids,semanticBoundary};',context);
  return {context,result:context.result,messages};
}

test('authored adjacent solids render only exposed faces and reveal a hidden neighbor interface',()=>{
  const mesh=modeling.createPrimitive({kind:'block',size:[2,1,1],divisions:[2,1,1],topology:'hex',order:1});
  const visible=render(mesh);assert.equal(visible.result.triangles,20);assert.equal(visible.result.semanticBoundary.faces.size,10);
  const hidden=render(mesh,{hiddenIds:[2]});assert.equal(hidden.result.triangles,12);assert.equal(hidden.result.semanticBoundary.faces.size,6);
  assert.ok(hidden.result.meshSolid.geometry.attributes.position.count>0);
  const section=render(mesh,{clipping:true});assert.equal(section.result.triangles,24,'section view retains cell faces within its clipping slab');
});

test('live authored HEX20 meshes above the former full-face limit retain shaded quadratic boundary surfaces',t=>{
  const mesh=modeling.createPrimitive({kind:'block',size:[24,24,20],divisions:[24,24,20],topology:'hex',order:2});
  assert.equal(mesh.elements.length,11520);assert.ok(mesh.elements.length*48>500000,'reproduces the previous live append cutoff');
  const start=performance.now(),{context,result,messages}=render(mesh);t.diagnostic(`Rendered ${mesh.elements.length} quadratic hexes in ${Math.round(performance.now()-start)} ms.`);
  const boundaryFaces=2*(24*24+24*20+24*20);
  assert.equal(result.skipSolids,false);assert.equal(result.semanticBoundary.faces.size,boundaryFaces);
  assert.equal(result.triangles,boundaryFaces*8,'each exposed eight-node face retains its midsides and quadratic center');
  assert.equal(result.meshSolid.material.isMeshPhongMaterial,true);
  assert.ok(result.meshSolid.geometry.attributes.normal.count>0);
  assert.equal(result.meshSolid.geometry.attributes.position.count,boundaryFaces*24);
  assert.ok(result.meshSolid.geometry.attributes.color.array.some(v=>v>0));
  assert.deepEqual(messages,[]);assert.equal(context.window.__WEBMESH_EDITOR_RENDER_STATS__.semanticSolidBoundaryFaces,boundaryFaces);
});

test('quadratic tetrahedra retain four subtriangles per exposed face',()=>{
  const mesh=modeling.createPrimitive({kind:'block',size:[1,1,1],divisions:[1,1,1],topology:'tet',order:2});
  const {result}=render(mesh);
  assert.equal(result.semanticBoundary.faces.size,12);assert.equal(result.triangles,48);
  const owners=new Set(result.solidFaceToElem.map(face=>face.eid));assert.ok(owners.size>0);
});
