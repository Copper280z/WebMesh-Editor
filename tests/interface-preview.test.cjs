const {test}=require('node:test');
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('reviewed RBE3 preview renders without passing through the primitive pattern checker',()=>{
  const source=fs.readFileSync(require.resolve('../app/workbench.js'),'utf8'),start=source.indexOf('  function previewInfo('),end=source.indexOf('  async function addPrimitive()',start),shown=[];
  const context=vm.createContext({modeling:()=>({validateMesh(){throw Error('primitive validator invoked');}}),$:()=>null,engine:()=>({previewMesh:m=>shown.push(m)})});
  vm.runInContext(source.slice(start,end),context);
  const mesh={nodes:[{id:1,x:0,y:0,z:0}],elements:[{id:10,type:'RBE3',nodes:[1,2,3,4]}]};
  assert.equal(context.previewInfo(mesh,true),mesh);assert.equal(shown.length,1);
  assert.throws(()=>context.previewInfo(mesh),/primitive validator/,'only a reviewed owned-card transaction can use the semantic validation path');
});
