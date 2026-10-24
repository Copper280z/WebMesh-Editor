const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const O=require('../app/engine-ownership.js'),source=fs.readFileSync(require('node:path').join(__dirname,'../app/editor-engine.js'),'utf8');
const funcs=source.slice(source.indexOf('  var showAnalysisExcluded ='),source.indexOf('  var contourField ='));
test('results visibility is an explicit display mask, retaining shared nodes and manual hidden choices',()=>{
 const semantic={nodes:[[1,{x:0,y:0,z:0}],[2,{x:1,y:0,z:0}],[3,{x:0,y:1,z:0}],[4,{x:0,y:0,z:1}]],elems:{tri:[{type:'CTRIA3',eid:1,pid:1,n:[1,2,3]},{type:'CTRIA3',eid:2,pid:1,n:[1,2,4]}]},properties:[[1,{type:'PSHELL',pid:1,mid1:1,t:1}]],materials:[[1,{type:'MAT1',mid:1,E:100,nu:.3}]],coords:[],masses:[],loads:{},spc:[],spc1:[],temperatures:[]};
 const P=require('../app/part-project.js');
 let state=O.preview({...semantic,nodes:semantic.nodes.slice(3),elems:{tri:[semantic.elems.tri[1]]}},null,{objects:[...P.part({id:'source',name:'Source'}).objects,{id:'mesh',kind:'mesh',name:'Reference triangle',dependsOn:['source'],definition:{part:'source',cards:[...semantic.nodes.slice(0,3).map(([id,value])=>({family:'nodes',id,role:'node'+id,value})),{family:'elems',bucket:'tri',id:1,role:'shell',value:semantic.elems.tri[0]}]}}]});
 state=O.preview(state.semantic,state.ownership,P.sourceReference(state.ownership,'source'));

 const model={...state.semantic,projectOwnership:state.ownership};for(const k of ['nodes','properties','materials','coords','masses'])model[k]=new Map(model[k]);
 const checkbox={checked:false},manual={elems:new Set([2]),nodes:new Set([4]),loads:new Set(),spc:new Set()},c=vm.createContext({Set,model,workerModel:{cardStream:[]},window:{WebMeshOwnership:O},solverResults:{},hidden:manual,document:{getElementById:()=>checkbox},buildGeometries(){c.builds++;},builds:0});
 vm.runInContext(funcs,c);c.refreshResultDisplayExclusions();const before=JSON.stringify(O.snapshot(model));
 let mask=c.getDisplayHidden();assert.deepEqual([...mask.elems].sort(),[1,2]);assert.deepEqual([...mask.nodes].sort(),[3,4]);assert.ok(!mask.nodes.has(1)&&!mask.nodes.has(2),'shared active GRIDs remain');
 c.setShowAnalysisExcluded(true);assert.equal(checkbox.checked,true);assert.equal(c.getDisplayHidden(),manual);assert.deepEqual([...manual.elems],[2]);assert.deepEqual([...manual.nodes],[4]);
 c.setShowAnalysisExcluded(false);assert.equal(checkbox.checked,false);assert.equal(c.builds,2);assert.equal(JSON.stringify(O.snapshot(model)),before);
 c.solverResults=null;c.refreshResultDisplayExclusions();assert.equal(c.getDisplayHidden(),manual,'editing restores source visibility without changing manual choices');assert.equal(c.resultDisplayExclusions.elems.size,0);
});
