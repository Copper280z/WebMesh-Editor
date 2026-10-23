const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../app/workbench.js'),'utf8');
test('owned remesh preview preserves RBE3 connectivity beside structural elements without treating rigids as material cells',()=>{
  let shown;
  const c=vm.createContext({Map,Set,modeling:()=>require('../app/modeling.js'),engine:()=>({previewMesh:m=>shown=m}),$:()=>null});
  vm.runInContext(source.slice(source.indexOf('  function ownedCardPreview('),source.indexOf('  async function addPrimitive(')),c);
  const nodes=[{id:1,x:0,y:0,z:0},{id:2,x:1,y:0,z:0},{id:3,x:0,y:1,z:0}],cards=[{family:'nodes',id:4,value:{x:0,y:0,z:200}},{family:'elems',id:1,value:{type:'CTRIA3',pid:1,n:[1,2,3]}},{family:'elems',id:2,value:{type:'RBE3',gn:4,inds:[1,2,3]}}];
  const mesh=c.ownedCardPreview(cards,nodes,'Mixed remesh');assert.deepEqual(Array.from(mesh.elements[1].nodes),[4,1,2,3]);assert.equal(mesh.nodes.length,4);
  c.previewInfo(mesh,true);assert.equal(shown.elements.length,2);
  const bad=structuredClone(mesh);bad.elements[0].nodes=[1,1,3];assert.throws(()=>c.previewInfo(bad,true));
});
