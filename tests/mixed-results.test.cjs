const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context=vm.createContext({self:{postMessage(){}},TextEncoder,TextDecoder,performance,setTimeout,clearTimeout});
vm.runInContext(require('./helpers/worker-source.cjs'),context);
const parse=vm.runInContext('parseF06Results',context);
test('Vibestran mixed-model F06 retains shell and solid stresses and both displacement cases',()=>{
  const result=parse(fs.readFileSync(path.join(__dirname,'../docs/design/validation/mixed-mesh/mixed.F06'),'utf8'));
  assert.equal(result.resultSets.length,2);
  for(const set of result.resultSets){
    assert.equal(Object.keys(set.displacements).length,324);
    const values=Object.values(set.stresses);
    assert.equal(values.filter(s=>s.type==='HEXA').length,24);
    assert.equal(values.filter(s=>s.type==='QUAD4').length,102);
    assert.ok(values.every(s=>Number.isFinite(s.vonMises)&&s.vonMises>=0));
  }
  assert.equal(result.resultSets[0].stresses[110].vonMises,1.1378,'adjacent fixed-width shell values must not be lost');
  const solid=result.resultSets[0].stresses[221];
  assert.equal(solid.normalX,-1.20725);assert.equal(solid.normalZ,-1.28953e-5);
  assert.equal(solid.shearXY,-.115665);assert.equal(solid.shearYZ,.0381598);assert.equal(solid.shearXZ,.00996213);
  assert.equal(solid.vonMises,1.15713,'use CENTER values, not extrapolated GRD values');
  assert.notEqual(result.resultSets[0].stresses[221].vonMises,result.resultSets[1].stresses[221].vonMises);
});

test('shell surface envelope accepts a second surface without transverse columns',()=>{
 const result=parse(`OUTPUT FOR SUBCASE 1
ELEMENT STRESSES IN LOCAL ELEMENT COORDINATE SYSTEM
FOR ELEMENT TYPE QUAD4
  4 CENTER -1.0000E+01-1.0E+00 2.0 0.1 0.0 3.0 2.0 2.5 0.2 0.3
           1.0000E+01 4.0 5.0 0.6 0.0 7.0 6.0 8.5
`);
 assert.equal(result.stresses[4].vonMises,8.5);assert.equal(result.stresses[4].normalX,4);
 assert.equal(result.stresses[4].shearXZ,.2);
});
