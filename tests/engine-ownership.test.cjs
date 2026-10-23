const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const O = require('../app/engine-ownership.js');
const Project = require('../app/project.js');
const source = fs.readFileSync(require.resolve('../app/editor-engine.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
function model() { return { nodes: new Map([[100, { x: 0, y: 0, z: 4, cp: 0, cd: 0, ps: '' }]]), elems: Object.fromEntries('tri tri6 quad quad8 tet hex penta pyram rod bar beam bush rbe2 rbe3'.split(' ').map(k => [k, []])), properties: new Map(), materials: new Map(), coords: new Map(), masses: new Map(), loads: { force: [{ sid: 9, nid: 100, mag: 10, cid: 0, dir: [0,0,1] }] }, spc: [], spc1: [], temperatures: [] }; }
function definition(id, kind, cards, dependsOn = []) { return { id, kind, dependsOn, definition: { cards } }; }
const node = (i, x = i) => ({ family: 'nodes', id: i, role: 'grid-' + i, value: { x, y: 0, z: 0, cp: 0, cd: 0, ps: '' } });
function request() { return { label: 'Generate shell', objects: [
  definition('pla', 'material', [{ family: 'materials', id: 1, role: 'isotropic', value: { type: 'MAT1', mid: 1, E: 3500, nu: .36, G: 3500 / 2.72, rho: 1.24e-9 } }]),
  definition('skin', 'section', [{ family: 'properties', id: 1, role: 'shell', value: { type: 'PSHELL', pid: 1, mid1: 1, mid2: 1, t: 2 } }], ['pla']),
  definition('chassis', 'mesh', [node(1), node(2), node(3), { family: 'elems', bucket: 'tri', id: 1, role: 'face', value: { type: 'CTRIA3', eid: 1, pid: 1, n: [1,2,3] } }], ['skin'])
] }; }
function fixture() {
  const sync = require('./helpers/editor-sync-context.cjs')(0, 0);
  const c = sync.context; Object.assign(c.model, model());
  Object.assign(c, {
    window: { WebMeshOwnership: O, WebMeshProject: Project }, structuredClone, TextEncoder, crypto: require('node:crypto').webcrypto,
    runtime: { protocol: { revision: 0, nextTxId: 1, pendingTransactions: [] } },
    hidden: {}, selection: {}, selectionManager: {}, selectMode: 'node', currentElemInput: null,
    ensureRichEditableSemanticElementAuthority: async () => {},
    invalidateElementLookup() {}, buildGeometries() {}, refreshCounts() {}, rebuildLabels() {}, populateModelTree() {},
    updateSelectionVisual() {}, highlightSelectedElementVisual() {}, updateSelectionUI() {},
    refreshTemperatureLoadSelector() {}, refreshContourFieldOptions() {}, statusMsg() {}, updateUndoRedoButtons() {},
    emitWorkbenchChange() {}, postSemanticWorkerSnapshot() {}, workbenchState() { return {}; }
  });
  c.ensureSemanticRelationshipIndexes = c.refreshSemanticRelationshipIndexes = () => ({ elementRefsByEid: new Map(Object.values(c.model.elems).flat().map(e => [e.eid, e])) });
  c.semanticTx = { apply(spec, fn) { const result = fn(); c.runtime.protocol.revision++; c.runtime.protocol.nextTxId++; return { tx: spec, result }; } };
  const start = source.indexOf('  var HISTORY_SEMANTIC_FAMILIES =');
  vm.runInContext(source.slice(start, source.indexOf('  function updateOpacity()', start)), c);
  c.restoreHistoryUiState = () => {};
  const bridge = source.indexOf('  // Project ownership adapter.');
  vm.runInContext(source.slice(bridge, source.indexOf('  // Small public bridge:', bridge)), c);
  return c;
}
async function exportParsed(c, format='free', retainedDeck=null) {
  const messages = [];
  const worker = vm.createContext({ Map, Set, self: { postMessage: m => messages.push(m) }, console, TextEncoder, TextDecoder, performance, setTimeout, clearTimeout });
  vm.runInContext(require('./helpers/worker-source.cjs'), worker);
  let writeModel=c.workerModel;
  if(retainedDeck){const retained=await worker.parseDeckToCardStream(retainedDeck,'reopened.bdf',{}, {strictMode:true,retainParseSession:true,retainSourceSession:true});writeModel={...writeModel,parseSessionId:retained.model.parseSessionId};}
  worker.handleWriteRequest({ model: writeModel, options: { writeFormat: format } });
  const deck = messages.find(m => m.type === 'WRITE_COMPLETE').text;
  const result = await worker.parseDeckToCardStream(deck, 'ownership.bdf', {}, { strictMode: true, retainParseSession: true, retainSourceSession: false });
  assert.deepEqual(copy(result.errors), []);
  return { deck, indexes: worker.getParseSession(result.model.parseSessionId).indexes, cards: copy(worker.getParseSession(result.model.parseSessionId).cardStream) };
}

test('preview creates complete owner/role metadata, preserves hand cards, and consumes no live IDs', () => {
  const before = O.snapshot(model()), text = JSON.stringify(before), r = request();
  const candidate = O.preview(before, null, r);
  assert.equal(JSON.stringify(before), text);
  assert.equal(candidate.changes.length, 6);
  assert.equal(candidate.ownership.owners.length, 6);
  assert.deepEqual(candidate.semantic.loads, before.loads);
  assert.deepEqual(candidate.semantic.nodes.find(([id]) => id === 100), before.nodes[0]);
  r.objects[0].definition.cards[0].value.E = 0;
  assert.equal(candidate.ownership.owners.find(e => e.owner === 'pla').card.value.E, 3500);
  assert.deepEqual(copy(O.validate(candidate.ownership, candidate.semantic).snapshot()), candidate.ownership.project);
});

test('generation refuses adoption, duplicate roles, undeclared dependencies and unsupported fields', () => {
  for (const mutate of [r => { r.objects[2].definition.cards[0] = node(100); }, r => { r.objects[2].definition.cards[1].role = 'grid-1'; }, r => { r.objects[1].dependsOn = []; }, r => { r.objects[0].definition.cards[0].value.unwritten = 4; }]) {
    const r = request(); mutate(r); assert.throws(() => O.preview(O.snapshot(model()), null, r));
  }
});

test('stable roles cannot move IDs, ownership cannot be transferred, and generated IDs remain reserved after removal', () => {
  const a = O.preview(O.snapshot(model()), null, { objects: [definition('point', 'point', [node(1)])] });
  assert.throws(() => O.preview(a.semantic, a.ownership, { objects: [definition('point', 'point', [{ ...node(2), role: 'grid-1' }])] }), /Stable role/);
  assert.throws(() => O.preview(a.semantic, a.ownership, { objects: [definition('other', 'point', [node(1)])] }), /another owner/);
  const removed = O.preview(a.semantic, a.ownership, { removeObjects: ['point'] });
  assert.throws(() => O.preview(removed.semantic, removed.ownership, { objects: [definition('other', 'point', [node(1)])] }), /Overlapping/);
});

test('shared PBUSH belongs to a template; updating it does not duplicate the property', () => {
  const property = { family: 'properties', id: 3, role: 'stiffness', value: { type: 'PBUSH', pid: 3, K: 'K', K1: 1000, K2: 1000, K3: 1000, K4: 10, K5: 10, K6: 10 } };
  const template = definition('motor', 'template', [property]);
  const a = O.preview(O.snapshot(model()), null, { objects: [template] });
  property.value.K1 = 2000;
  const b = O.preview(a.semantic, a.ownership, { objects: [template] });
  assert.equal(b.semantic.properties.length, 1); assert.equal(b.semantic.properties[0][1].K1, 2000);
  assert.equal(b.ownership.project.reservations.length, 1);
  assert.throws(() => O.preview(O.snapshot(model()), null, { objects: [definition('mesh', 'mesh', [property])] }), /cannot own/);
});

for (const [name, add] of [
  ['RBE3', s => { s.elems.rbe3 = [{ type: 'RBE3', eid: 20, gn: 100, groups: [{ wt: 1, c: '123', gids: [1] }], um: [] }]; }],
  ['CONM2', s => s.masses.push([20, { type: 'CONM2', g: 1, cid: 0, m: 0.5 }])],
  ['SPC1', s => s.spc1.push({ sid: 2, nodes: [1], components: '123' })],
  ['temperature', s => s.temperatures.push({ sid: 4, nodeIds: [1], values: [20] })],
  ['coordinate', s => s.coords.push([7, { type: 'CORD1R', nodes: [1,100,2] }])],
  ['FORCE', s => s.loads.force.push({ sid: 2, nid: 1, f: 1 })]
]) test('a hand ' + name + ' reference prevents deleting an owned GRID', () => {
  const a = O.preview(O.snapshot(model()), null, { objects: [definition('points', 'mesh', [node(1), node(2)])] });
  add(a.semantic);
  assert.throws(() => O.preview(a.semantic, a.ownership, { removeObjects: ['points'] }), /Dangling reference/);
});

test('unknown cards block generation; scalar values are never guessed to be IDs', () => {
  assert.throws(() => O.preview(O.snapshot(model()), null, request(), [{ kind: 'card', name: 'MPC', tokens: ['MPC', '1', '100', '1', '1.0'] }]), /Cannot prove references for MPC/);
  const a = O.preview(O.snapshot(model()), null, { objects: [definition('point', 'point', [node(1)])] });
  a.semantic.loads.force[0].f = 1;
  assert.doesNotThrow(() => O.preview(a.semantic, a.ownership, { removeObjects: ['point'] }));
});

test('convert to plain preserves cards and permits subsequent manual edits; conversion is explicit', () => {
  const a = O.preview(O.snapshot(model()), null, { objects: [definition('point', 'point', [node(1)])] });
  const b = O.preview(a.semantic, a.ownership, { convertToPlain: ['point'] });
  assert.equal(b.ownership.owners.length, 0); assert.deepEqual(b.semantic, a.semantic);
  const edited = copy(b.semantic); edited.nodes.find(([id]) => id === 1)[1].x = 9;
  assert.doesNotThrow(() => O.guard(b.ownership, b.semantic, edited));
});

test('real engine commit, undo and redo restore cards and definitions in one history entry', async () => {
  const c = fixture(), before = O.snapshot(c.model);
  const tx = await c.previewProjectChange(request());
  assert.deepEqual(O.snapshot(c.model), before); assert.equal(c.historyManager.stack.length, 0);
  tx.commit(); assert.equal(c.historyManager.stack.length, 1); O.validate(c.model.projectOwnership, O.snapshot(c.model));
  const saved = copy(c.model.projectOwnership);
  c.historyManager.undo(); assert.deepEqual(O.snapshot(c.model), before); assert.equal(c.model.projectOwnership, null);
  c.historyManager.redo(); assert.deepEqual(copy(c.model.projectOwnership), saved);
  const { deck, indexes } = await exportParsed(c);
  assert.match(deck, /^FORCE,9,100/m); assert.equal(indexes.nodes.size, 4);
  assert.equal(indexes.properties.get(1).t, 2); assert.equal(indexes.materials.get(1).E, 3500);
  assert.deepEqual(copy(indexes.elements.get(1).nids), [1,2,3]);
});

test('ordinary edits to owned cards roll back model, worker stream, revision and redo history', async () => {
  const c = fixture(); (await c.previewProjectChange(request())).commit();
  c.historyManager.recordAction(() => { c.model.nodes.get(100).x = 8; });
  c.historyManager.undo();
  const before = O.snapshot(c.model), worker = structuredClone(c.workerModel), protocol = structuredClone(c.runtime.protocol), stack = copy(c.historyManager.stack), pointer = c.historyManager.pointer;
  assert.throws(() => c.historyManager.recordAction(() => { c.model.nodes.get(1).x = 9; c.workerModel.cardStream.length = 0; }), /owned by chassis/);
  assert.deepEqual(O.snapshot(c.model), before); assert.deepEqual(c.workerModel, worker);
  assert.deepEqual(c.runtime.protocol, protocol); assert.deepEqual(copy(c.historyManager.stack), stack); assert.equal(c.historyManager.pointer, pointer);
  c.historyManager.redo(); assert.equal(c.model.nodes.get(100).x, 8);
});

test('serialization warnings abort the entire candidate, including allocated IDs and history', async () => {
  const c = fixture(), before = O.snapshot(c.model);
  const tx = await c.previewProjectChange(request());
  c.syncWorkerFromEditorModel = warn => { c.workerModel = { cardStream: [] }; warn('bad generated card'); };
  assert.throws(() => tx.commit(), /Card generation failed/);
  assert.deepEqual(O.snapshot(c.model), before); assert.equal(c.model.projectOwnership, null);
  assert.equal(c.historyManager.stack.length, 0); assert.equal(c.runtime.protocol.revision, 0);
});

test('intervening hand edits, undo/redo and discard invalidate candidates', async () => {
  const c = fixture(); const pending = await c.previewProjectChange(request());
  c.historyManager.recordAction(() => { c.model.nodes.get(100).x = 4; });
  c.historyManager.undo();
  assert.throws(() => pending.commit(), /Outdated/);
  const fresh = await c.previewProjectChange(request()); fresh.discard(); assert.throws(() => fresh.commit(), /closed/);
  assert.equal(c.model.nodes.size, 1);
});

test('saved metadata is bound to its deck; corrupted projects reject before load', async () => {
  const c = fixture(); (await c.previewProjectChange(request())).commit();
  c.writeCardEngine = async () => (await exportParsed(c)).deck;
  const saved = await c.saveProjectModel(); let loaded = false;
  c.loadFromText = async () => { loaded = true; };
  await assert.rejects(c.loadProjectModel({ ...saved, deck: saved.deck + '$ changed' }), /disagree/);
  assert.equal(loaded, false);
  await c.loadProjectModel(saved); assert.equal(loaded, true);
  O.validate(c.model.projectOwnership, O.snapshot(c.model));
  const pending = await c.previewProjectChange(request()); assert.deepEqual(copy(pending.preview().changes), []);
});

test('retained PLOAD4 selectors and coordinate references protect identities omitted by compact hydration', () => {
  const a = O.preview(O.snapshot(model()), null, { objects: [definition('points', 'mesh', [node(1), node(2)])] });
  a.semantic.elems.tri.push({ eid: 20, type: 'CTRIA3', pid: 4, n: [100,1,2] });
  a.semantic.properties.push([4,{type:'PSHELL',pid:4,mid1:4,t:1}]);a.semantic.materials.push([4,{type:'MAT1',mid:4}]);
  const index=O.references(a.semantic,[{kind:'card',name:'PLOAD4',tokens:['PLOAD4','9','20','1.','1.','1.','1.','1','2','7']}]);
  assert.ok(index.refs.some(r=>r.from==='PLOAD4:9:20'&&r.to==='node:1'));
  assert.ok(index.missing.some(r=>r.to==='coordinate:7'));
});

test('manual deletion of a hand material required by an owned property is rejected', () => {
  const s=O.snapshot(model());s.materials.push([4,{type:'MAT1',mid:4,E:1000,nu:.3,rho:0}]);
  const a=O.preview(s,null,{objects:[definition('section','section',[{family:'properties',id:1,role:'shell',value:{type:'PSHELL',pid:1,mid1:4,t:2}}])]});
  const deleted=copy(a.semantic);deleted.materials=[];
  assert.throws(()=>O.guard(a.ownership,a.semantic,deleted),/Dangling reference/);
});

test('repeated generation consumes no engine revision or history entry',async()=>{
  const c=fixture();(await c.previewProjectChange(request())).commit();
  const revision=c.runtime.protocol.revision,size=c.historyManager.stack.length;
  (await c.previewProjectChange(request())).commit();
  assert.equal(c.runtime.protocol.revision,revision);assert.equal(c.historyManager.stack.length,size);
});

test('ownership metadata corruption rejects before replacing the current model',async()=>{
  const c=fixture();(await c.previewProjectChange(request())).commit();c.writeCardEngine=async()=>(await exportParsed(c)).deck;
  const saved=await c.saveProjectModel();
  saved.ownership.project.objects.find(o=>o.id==='pla').definition.cards[0].value.E=9000;
  saved.ownership.owners.find(o=>o.owner==='pla').card.value.E=9000;
  let loaded=false;c.loadFromText=async()=>{loaded=true;};
  await assert.rejects(c.loadProjectModel(saved),/disagree/);assert.equal(loaded,false);
});

test('preview includes old/new card values and metadata-only conversion effects', () => {
  const a=O.preview(O.snapshot(model()),null,{objects:[definition('point','point',[node(1)])]});
  const b=O.preview(a.semantic,a.ownership,{objects:[definition('point','point',[node(1,9)])]});
  assert.equal(b.changes[0].before.value.x,1);assert.equal(b.changes[0].after.value.x,9);
  const c=O.preview(b.semantic,b.ownership,{convertToPlain:['point']});
  assert.equal(c.changes.length,0);assert.deepEqual(c.ownershipChanges,[{key:'node:1',before:{owner:'point',role:'grid-1'},after:null}]);
});

test('shared writer blocks a suspended project for both export and solver consumers', async () => {
  const c=fixture();const point=definition('point','point',[node(1)]);
  (await c.previewProjectChange({objects:[point]})).commit();
  point.facts={suspendedReason:'Region lost during remeshing'};
  (await c.previewProjectChange({objects:[point]})).commit();
  const start=source.indexOf('  function writeCardEngine(');
  vm.runInContext(source.slice(start,source.indexOf('  function ensureWorkerBackedModelReady()',start)),c);
  assert.throws(()=>c.writeCardEngine(c.workerModel,{writeFormat:'free'}),/Suspended: Region lost/);
  assert.equal(c.model.nodes.has(1),false);assert.ok(c.model.projectOwnership.project.objects[0].definition.cards.length);
});

test('real parser case control and ordinary parameters are not mistaken for unsupported bulk cards', async()=>{
  const worker=vm.createContext({Map,Set,self:{postMessage(){}},console,TextEncoder,TextDecoder,performance,setTimeout,clearTimeout});
  vm.runInContext(require('./helpers/worker-source.cjs'),worker);
  const parsed=await worker.parseDeckToCardStream('SOL 101\nCEND\nTITLE = ROVER\nSUBCASE 1\n  SPC=1\n  LOAD=9\nBEGIN BULK\nGRID,100,,0.,0.,4.\nPARAM,WTMASS,1.\nGRAV,9,0,9810.,0.,0.,-1.\nENDDATA','case.bdf',{}, {strictMode:true,retainParseSession:true});
  const cards=worker.getParseSession(parsed.model.parseSessionId).cardStream;
  assert.doesNotThrow(()=>O.preview(O.snapshot(model()),null,request(),cards));
  assert.throws(()=>O.preview(O.snapshot(model()),null,request(),[{kind:'card',name:'SET 1',tokens:['SET 1','=','100']},...cards]),/case control SET 1/);
  assert.throws(()=>O.preview(O.snapshot(model()),null,request(),[{kind:'card',name:'PARAM',tokens:['PARAM','GRDPNT','100']}]),/Cannot prove references for PARAM/);
});

test('restoring a duplicate role hidden in definition data is rejected',()=>{
  const a=O.preview(O.snapshot(model()),null,{objects:[definition('point','point',[node(1)])]});
  a.ownership.project.objects[0].definition.cards.push(node(1));
  assert.throws(()=>O.validate(a.ownership,a.semantic),/Duplicate definition role/);
});

test('legacy project loading retains the existing empty/invalid deck safeguard',async()=>{
  const c=fixture();let loaded=false;c.loadFromText=async()=>{loaded=true;};
  await assert.rejects(c.loadProjectModel({deck:'not a deck'}),/no recognizable/);
  assert.equal(loaded,false);assert.equal(c.model.nodes.size,1);
});

const Plate = require('../app/primitive-project.js');
const plateInput = () => ({ id:'plate', name:'Chassis', parameters:{size:[100,60,0],origin:[0,0,0],divisions:[4,3,1],topology:'quad',order:1}, thickness:2, material:{E:3500,nu:.36,rho:1.24e-9} });
const nextPlateIds = {node:101,element:1,material:1,property:1};
function platePreview(input=plateInput(), previous=null, semantic=O.snapshot(model())) {
  return O.preview(semantic, previous, Plate.build(input,previous,nextPlateIds).request);
}
test('editable plate reserves exact blocks, restores inputs, and regenerates without changes', () => {
  const a=platePreview();
  assert.equal(a.ownership.project.reservations.length,4);
  const block=a.ownership.project.reservations.find(r=>r.namespace==='node');assert.equal(block.end-block.start+1,20);
  assert.equal(a.ownership.owners.length,34);
  assert.deepEqual(Plate.inputs(a.ownership,'plate/section'),plateInput());
  const b=platePreview(Plate.inputs(a.ownership,'plate'),a.ownership,a.semantic);
  assert.deepEqual(b.changes,[]); assert.deepEqual(b.project.changes,[]);
});
test('plate geometry and material updates preserve mesh identity; section diff is explicit', () => {
  const a=platePreview(), input=Plate.inputs(a.ownership,'plate');input.parameters.size[0]=130;input.thickness=3;input.material.E=4000;
  const b=platePreview(input,a.ownership,a.semantic);
  assert.deepEqual(b.ownership.owners.map(o=>o.key),a.ownership.owners.map(o=>o.key));
  assert.equal(b.changes.find(c=>c.key==='property:1').before.value.t,2);
  assert.equal(b.changes.find(c=>c.key==='property:1').after.value.t,3);
  assert.ok(b.project.checks.every(c=>['ok','changed'].includes(c.status)));
});
for(const change of ['divisions','topology','order'])test('changing plate '+change+' creates fresh identities and protects existing node loads',()=>{
  const a=platePreview(), input=Plate.inputs(a.ownership,'plate');
  if(change==='divisions')input.parameters.divisions[0]=6;else input.parameters[change]=change==='topology'?'tri':2;
  const b=platePreview(input,a.ownership,a.semantic);
  const oldKeys=new Set(a.ownership.owners.filter(o=>o.owner==='plate').map(o=>o.key));
  assert.ok(b.ownership.owners.filter(o=>o.owner==='plate').every(o=>!oldKeys.has(o.key)));
  a.semantic.loads.force.push({sid:1,nid:101,mag:1,dir:[0,0,1],cid:0});
  assert.throws(()=>platePreview(input,a.ownership,a.semantic),/Dangling reference/);
});
test('quadratic triangles round trip through actual writer/parser and project history',async()=>{
  const c=fixture(), input=plateInput();input.parameters.topology='tri';input.parameters.order=2;
  (await c.previewProjectChange(Plate.build(input,null,nextPlateIds).request)).commit();
  const before=copy(c.model.projectOwnership), parsed=await exportParsed(c);
  assert.equal(parsed.indexes.elements.size,24);
  assert.ok([...parsed.indexes.elements.values()].every(e=>e.type==='CTRIA6'&&e.nids.length===6));
  assert.equal(parsed.indexes.properties.get(1).t,2);
  c.historyManager.undo();assert.equal(c.model.nodes.size,1);
  c.historyManager.redo();assert.deepEqual(copy(c.model.projectOwnership),before);
  const noop=await c.previewProjectChange(Plate.build(Plate.inputs(before,'plate'),before,nextPlateIds).request);
  noop.commit();assert.equal(c.historyManager.stack.length,1);
});
test('plate bundle conversion keeps all cards and reservations, prevents reuse, and rejects external dependents',()=>{
  const a=platePreview(), converted=O.preview(a.semantic,a.ownership,Plate.conversion(a.ownership,'plate/material'));
  assert.deepEqual(converted.semantic,a.semantic);assert.equal(converted.ownership.owners.length,0);
  assert.equal(converted.ownership.project.reservations.length,4);
  const input=plateInput();input.id='another';
  const built=Plate.build(input,converted.ownership,nextPlateIds);
  assert.equal(built.mesh.nodes[0].id,121);
  a.ownership.project.objects.push({id:'uses-section',name:'External mesh',dependsOn:['plate/section'],definition:{}});
  assert.throws(()=>Plate.conversion(a.ownership,'plate'),/External mesh/);
});
test('plate rejects invalid geometry, discretization, material and thickness before changing the model',()=>{
  for(const mutate of [i=>i.parameters.size[2]=1,i=>i.parameters.size[0]=0,i=>i.parameters.divisions[0]=1.5,i=>i.parameters.order=3,i=>i.thickness=0,i=>i.material.rho=-1]){
    const i=plateInput();mutate(i);assert.throws(()=>platePreview(i));
  }
});
function motorsRequest(){
  const points=definition('shafts','point',[node(121),node(122),node(123),node(124)]);
  const template=definition('motor-template','template',[{family:'properties',id:2,role:'stiffness',value:{type:'PBUSH',pid:2,K:'K',K1:1000,K2:1000,K3:1000,K4:100,K5:100,K6:100}}]);
  const motors=[0,1].map(i=>definition('motor-'+i,'connection',[
    {family:'elems',bucket:'rbe2',id:13+i*2,role:'mount',value:{type:'RBE2',eid:13+i*2,gn:121+i*2,cm:'123',deps:[101+i*2,102+i*2]}},
    {family:'elems',bucket:'bush',id:14+i*2,role:'shaft',value:{type:'CBUSH',eid:14+i*2,pid:2,n:[121+i*2,122+i*2],orient:{kind:'x',x:[1,0,0]}}}
  ],['plate','shafts','motor-template']));
  return {objects:[points,template,...motors]};
}
test('plate with two motor attachments shares a single PBUSH and exports real rigids/bushes',async()=>{
  const c=fixture();(await c.previewProjectChange(Plate.build(plateInput(),null,nextPlateIds).request)).commit();
  (await c.previewProjectChange(motorsRequest())).commit();
  const {indexes,deck}=await exportParsed(c);
  assert.equal(indexes.properties.size,2);assert.equal(indexes.elements.size,16);
  assert.equal((deck.match(/^PBUSH,/gm)||[]).length,1);assert.equal((deck.match(/^RBE2,/gm)||[]).length,2);assert.equal((deck.match(/^CBUSH,/gm)||[]).length,2);
  const edited=Plate.inputs(c.model.projectOwnership,'plate');edited.thickness=3;
  const candidate=await c.previewProjectChange(Plate.build(edited,c.model.projectOwnership,nextPlateIds).request);
  assert.ok(candidate.preview().project.checks.some(c=>c.id==='motor-0'&&c.status==='invalid'));
  candidate.discard();assert.equal(c.model.properties.get(1).t,2);
});
for(const [name,mutate] of [
  ['SPC',s=>s.spc.push({sid:1,g:101,c:'1',d:0})],
  ['SPC1',s=>s.spc1.push({sid:1,nodes:[101],components:'1'})],
  ['GRID PS',s=>s.nodes.find(([id])=>id===101)[1].ps='1'],
  ['hand RBE2',s=>s.elems.rbe2.push({type:'RBE2',eid:90,gn:100,cm:'1',deps:[101]})],
  ['RBE3 reference',s=>s.elems.rbe3.push({type:'RBE3',eid:90,gn:101,refc:'1',groups:[{wt:1,c:'123',gids:[100]}],um:[]})],
  ['RBE3 UM',s=>s.elems.rbe3.push({type:'RBE3',eid:90,gn:100,refc:'123',groups:[{wt:1,c:'123',gids:[102]}],um:[{gm:101,cm:'1'}]})]
])test('generated motor RBE2 rejects dependent DOF conflict with '+name,()=>{
  const a=platePreview();mutate(a.semantic);
  // Permanent constraints on a generated GRID are defined by its owner.
  if(name==='GRID PS'){const card=a.ownership.owners.find(o=>o.key==='node:101');card.card.value.ps='1';a.ownership.project.objects.find(o=>o.id==='plate').definition.cards.find(c=>c.id===101&&c.family==='nodes').value.ps='1';}
  assert.throws(()=>O.preview(a.semantic,a.ownership,motorsRequest()),/dependent|already constrained/i);
});
test('generated motor RBE2 rejects overlapping generated dependents',()=>{
  const a=platePreview(),r=motorsRequest();r.objects[3].definition.cards[0].value.deps=[101,104];
  assert.throws(()=>O.preview(a.semantic,a.ownership,r),/dependent|already constrained/i);
});
for(const topology of ['tri','quad'])for(const format of ['source','free','small','large'])test('generated quadratic '+topology+' plate survives '+format+' export with all midsides',async()=>{
  const c=fixture(),input=plateInput();input.parameters.topology=topology;input.parameters.order=2;
  const built=Plate.build(input,null,nextPlateIds);(await c.previewProjectChange(built.request)).commit();
  const {indexes,deck}=await exportParsed(c,format);
  assert.doesNotMatch(deck,/unwritable/);
  assert.equal(indexes.elements.size,built.mesh.elements.length);
  for(const e of built.mesh.elements)assert.deepEqual(copy(indexes.elements.get(e.id).nids),e.nodes);
});
test('hand constraints added after motor generation cannot invalidate owned dependent DOFs',()=>{
  const plate=platePreview(),motors=O.preview(plate.semantic,plate.ownership,motorsRequest()),after=copy(motors.semantic);
  after.spc1.push({sid:9,nodes:[101],components:'123'});
  assert.throws(()=>O.guard(motors.ownership,motors.semantic,after),/already constrained or dependent/);
});
test('owner summary and lookup update through undo, redo and conversion; next IDs skip retired blocks',async()=>{
  const c=fixture();c.getAllElementIds=()=>Object.values(c.model.elems).flat().map(e=>e.eid);
  (await c.previewProjectChange(Plate.build(plateInput(),null,nextPlateIds).request)).commit();
  assert.equal(c.workbenchProjectSummary().objects.length,3);
  assert.equal(c.workbenchCardOwner('node',101).id,'plate');
  (await c.previewProjectChange(Plate.conversion(c.model.projectOwnership,'plate'))).commit();
  assert.equal(c.workbenchProjectSummary().objects.length,0);assert.equal(c.workbenchCardOwner('node',101),null);
  c.historyManager.undo();assert.equal(c.workbenchCardOwner('node',101).id,'plate');
  c.historyManager.redo();c.model.nodes.clear();c.model.elems.quad=[];
  vm.runInContext(source.slice(source.indexOf('  function workbenchNextIds()'),source.indexOf('  function workbenchGetMesh(')),c);
  assert.equal(c.workbenchNextIds().node,121);assert.equal(c.workbenchNextIds().element,13);
});

 test('plate remeshing removes retired IDs from selection in the same undo entry',async()=>{
  const c=fixture();(await c.previewProjectChange(Plate.build(plateInput(),null,nextPlateIds).request)).commit();
  c.selection.nodes=new Set([100,101]);c.selection.elems=new Set([1]);c.hidden.nodes=new Set([101]);
  const input=Plate.inputs(c.model.projectOwnership,'plate');input.parameters.order=2;
  (await c.previewProjectChange(Plate.build(input,c.model.projectOwnership,nextPlateIds).request)).commit();
  assert.deepEqual([...c.selection.nodes],[100]);assert.equal(c.selection.elems.size,0);assert.equal(c.hidden.nodes.size,0);
  const history=c.historyManager.stack.at(-1);assert.ok(history);
});

const Cad = require('../app/cad-project.js');
function cadInput({ name='box', size=3, order=1, perSolid=false }={}) {
  const H=require('../app/hex-mapping.js'),data=JSON.parse(fs.readFileSync(require.resolve('./fixtures/mapping/'+name+'.json'),'utf8'));
  const analysis=H.analyze(data.topology),intervals=H.solveIntervals(analysis,{size});
  const mesh=H.generateMesh(analysis,intervals,H.createGeometry(data.topology,data.preview),{order});
  return {id:'cad',name:'CAD part',snapshot:{filename:'part.step',content:btoa('STEP'),prepared:{filename:'part.brep',format:'brep',content:btoa('BREP')}},topology:data.topology,mesh,volumes:data.topology.volumes.map(v=>v.id),perSolid,settings:{version:2,step:'mesh',mesh:{method:'mapped',order,pidPerSolid:perSolid},sizing:{size,minCount:1,edges:[]}}};
}
async function cadPreview(input=cadInput(),previous=null,semantic=O.snapshot(model())) {
  return O.preview(semantic,previous,(await Cad.build(input,previous,nextPlateIds)).request);
}
test('mapped CAD owns explicit source/solid regions and unchanged generation is a no-op',async()=>{
  const input=cadInput({name:'split-box',perSolid:true}),a=await cadPreview(input);
  assert.equal(a.ownership.project.objects.filter(o=>o.kind==='source').length,1);
  assert.equal(a.ownership.project.objects.filter(o=>o.kind==='section').length,2);
  const b=await cadPreview(input,a.ownership,a.semantic);
  assert.deepEqual(b.changes,[]);assert.deepEqual(b.project.changes,[]);
  const restored=Cad.restoreData(a.ownership,'cad/material');
  assert.deepEqual(restored.settings,input.settings);assert.deepEqual(restored.prepared,input.snapshot.prepared);
  assert.equal(restored.meshes[0].projectOwner,'cad');assert.deepEqual(restored.meshes[0].elements,a.semantic.elems.hex.map(e=>e.eid));
});
for(const changed of [{size:2},{order:2},{name:'split-box',perSolid:true}])test('mapped CAD remesh '+JSON.stringify(changed)+' allocates fresh mesh IDs and protects hand loads',async()=>{
  const a=await cadPreview(),input=cadInput(changed),b=await cadPreview(input,a.ownership,a.semantic);
  const oldIds=new Set(a.ownership.owners.filter(o=>o.owner==='cad').map(o=>o.key));
  assert.ok(b.ownership.owners.filter(o=>o.owner==='cad').every(o=>!oldIds.has(o.key)));
  assert.ok(b.semantic.nodes.some(([id])=>id===100));
  if(!changed.name)assert.equal(b.semantic.elems.hex[0].pid,a.semantic.elems.hex[0].pid);
  else assert.notEqual(b.semantic.elems.hex[0].pid,a.semantic.elems.hex[0].pid);
  a.semantic.loads.force.push({sid:1,nid:101,mag:10,dir:[0,0,1],cid:0});
  await assert.rejects(cadPreview(input,a.ownership,a.semantic),/Dangling reference/);
});
test('CAD material review invalidates an external connection and removal/conversion require resolution',async()=>{
  const a=await cadPreview();
  const r=definition('mount','connection',[{family:'elems',bucket:'rbe2',id:10000,role:'mount',value:{type:'RBE2',eid:10000,gn:100,cm:'123',deps:[101,102]}}],['cad']);
  const b=O.preview(a.semantic,a.ownership,{objects:[r]});
  const edited=O.preview(b.semantic,b.ownership,Cad.materialChange(b.ownership,'cad/material',{E:3500,nu:.36,rho:1.24e-9}));
  assert.ok(edited.project.checks.some(c=>c.id==='mount'&&c.status==='invalid'));
  for(const convert of [false,true])assert.throws(()=>Cad.removal(b.ownership,'cad',convert),/Resolve dependent/);
  const converted=O.preview(a.semantic,a.ownership,Cad.removal(a.ownership,'cad',true));
  assert.deepEqual(converted.semantic,a.semantic);assert.equal(converted.ownership.owners.length,0);
  assert.equal(converted.ownership.project.objects.length,0);
});
for(const order of [1,2])test('mapped HEX'+(order===2?20:8)+' actual writer/parser, history and saved ownership round trip',async()=>{
  const c=fixture(),input=cadInput({order}),built=await Cad.build(input,null,nextPlateIds);
  (await c.previewProjectChange(built.request)).commit();
  const before=copy(c.model.projectOwnership);
  for(const format of ['free','small','large']){
    const {indexes}=await exportParsed(c,format);
    assert.equal(indexes.elements.size,built.mesh.elements.length);
    for(const e of built.mesh.elements)assert.deepEqual(copy(indexes.elements.get(e.id).nids),e.nodes);
  }
  c.historyManager.undo();assert.equal(c.model.elems.hex.length,0);
  c.historyManager.redo();assert.deepEqual(copy(c.model.projectOwnership),before);
  (await c.previewProjectChange((await Cad.build(input,before,nextPlateIds)).request)).commit();
  assert.equal(c.historyManager.stack.length,1);
  c.writeCardEngine=async()=>(await exportParsed(c)).deck;
  const saved=await c.saveProjectModel();let loaded=false;c.loadFromText=async()=>{loaded=true;};
  await c.loadProjectModel(saved);assert.equal(loaded,true);
  assert.deepEqual(copy(O.validate(c.model.projectOwnership,O.snapshot(c.model)).snapshot()),before.project);
});

test('returning to a retired CAD region allocates a new section identity',async()=>{
  const a=await cadPreview(cadInput({name:'split-box'}));
  const b=await cadPreview(cadInput({name:'split-box',perSolid:true}),a.ownership,a.semantic);
  const c=await cadPreview(cadInput({name:'split-box'}),b.ownership,b.semantic);
  assert.notEqual(c.semantic.elems.hex[0].pid,a.semantic.elems.hex[0].pid);
  const original=Cad.rootFor(a.ownership,'cad').definition.sections[0].id;
  assert.notEqual(Cad.rootFor(c.ownership,'cad').definition.sections[0].id,original);
});

test('remeshing a reopened CAD deck retires old source properties; removal and undo still export',async()=>{
  const c=fixture();(await c.previewProjectChange((await Cad.build(cadInput(),null,nextPlateIds)).request)).commit();
  const original=await exportParsed(c);
  c.Int32Array=Int32Array;c.model.coreSoa={active:false,elemIds:new Int32Array([...original.indexes.elements.keys()])};
  vm.runInContext(source.slice(source.indexOf('  function getTotalElementCount()'),source.indexOf('  function onResize()',source.indexOf('  function getTotalElementCount()'))),c);
  // Reopened projects carry parsed source cards as well as semantic indexes.
  c.workerModel.cardStream=original.cards;c.indexWorkerCardStream(c.workerModel.cardStream);
  const built=await Cad.build(cadInput({name:'split-box',order:2,perSolid:true}),c.model.projectOwnership,nextPlateIds);
  (await c.previewProjectChange(built.request)).commit();
  for(const format of ['source','free']){
    const parsed=await exportParsed(c,format,original.deck);
    assert.deepEqual([...parsed.indexes.properties.keys()].sort(),[2,3]);
    assert.equal(parsed.indexes.elements.size,built.mesh.elements.length);
    for(const e of built.mesh.elements)assert.deepEqual(copy(parsed.indexes.elements.get(e.id).nids),e.nodes);
  }
  (await c.previewProjectChange(Cad.removal(c.model.projectOwnership,'cad'))).commit();
  assert.equal(c.getTotalElementCount(),0,'removed elements cannot reappear through inactive compact counts');
  const empty=await exportParsed(c,'free',original.deck);assert.equal(empty.indexes.properties.size,0);assert.equal(empty.indexes.materials.size,0);assert.equal(empty.indexes.elements.size,0);assert.equal(empty.indexes.nodes.size,1);
  c.historyManager.undo();const undone=await exportParsed(c,'free',original.deck);assert.deepEqual([...undone.indexes.properties.keys()].sort(),[2,3]);assert.equal(undone.indexes.elements.size,built.mesh.elements.length);
});

const Mount=require('../app/attachment-project.js');
function applyMount(previous,request){return O.preview(previous.semantic,previous.ownership,Mount.rebuild(previous.ownership,request));}
async function mountedPair(){
  let a=await cadPreview();
  for(const [id,face] of [['left',1],['right',2]])a=applyMount(a,Mount.region({id,name:id+' mount',mesh:'cad',faces:[face]},a.ownership));
  for(const [id,region,x] of [['motor-left','left',0],['motor-right','right',10]]){
    const input={id,name:id,region,mount:[x,3,2],shaft:[x+(x?20:-20),3,2],components:'123',template:'motor-stiffness'};
    if(id==='motor-left')input.newTemplate={id:'motor-stiffness',name:'Motor stiffness',stiffness:[1e5,2e5,3e5,1e4,2e4,3e4]};
    a=applyMount(a,Mount.attachment(input,a.ownership,nextPlateIds));
  }
  return a;
}
test('named mounting regions and two attachments share one PBUSH with independent stable points',async()=>{
  const a=await mountedPair();assert.equal(a.semantic.elems.rbe2.length,2);assert.equal(a.semantic.elems.bush.length,2);
  assert.equal(a.semantic.properties.filter(([,v])=>v.type==='PBUSH').length,1);
  const roots=a.ownership.project.objects.filter(o=>o.definition.generator===Mount.ATTACHMENT);
  assert.equal(roots.length,2);assert.ok(a.semantic.elems.bush.every(e=>e.pid===a.semantic.elems.bush[0].pid&&e.cid===0));
  assert.ok(a.semantic.elems.rbe2.every(e=>e.cm==='123'));
  const left=a.ownership.project.objects.find(o=>o.id==='left');
  assert.deepEqual(left.definition.selector.faces,[1]);assert.deepEqual(left.definition.resolved.nodes,a.semantic.elems.rbe2[0].deps);
  const same=applyMount(a,{objects:[copy(roots[0])]});assert.deepEqual(same.changes,[]);assert.deepEqual(same.project.changes,[]);
});
test('remesh re-resolves both regions and RBE2s atomically, retaining point, element and PBUSH IDs',async()=>{
  const a=await mountedPair(),before=copy(a),built=await Cad.build(cadInput({size:2,order:2}),a.ownership,nextPlateIds);
  const b=applyMount(a,built.request);
  assert.deepEqual(a,before,'pure builders leave the committed project intact');
  const changedNodes=new Set(b.semantic.elems.hex.flatMap(e=>e.n));
  for(let i=0;i<2;i++){
    const r=b.semantic.elems.rbe2[i],old=a.semantic.elems.rbe2[i];assert.equal(r.eid,old.eid);assert.equal(r.gn,old.gn);
    assert.ok(r.deps.length>old.deps.length);assert.ok(r.deps.every(id=>changedNodes.has(id)));assert.ok(r.deps.every(id=>!old.deps.includes(id)));
  }
  assert.deepEqual(b.semantic.elems.bush,a.semantic.elems.bush);
  assert.ok(b.project.checks.every(c=>c.status!=='invalid'));
  const hand=copy(a);hand.semantic.loads.force.push({sid:7,nid:a.semantic.elems.rbe2[0].deps[0],mag:20,cid:0,dir:[1,0,0]});
  assert.throws(()=>applyMount(hand,built.request),/Dangling reference/);
});
test('material and shared stiffness changes re-evaluate both attachments without duplicating cards',async()=>{
  const a=await mountedPair(),b=applyMount(a,Cad.materialChange(a.ownership,'cad',{E:3500,nu:.36,rho:1.24e-9}));
  assert.ok(b.project.checks.every(c=>c.status!=='invalid'));assert.deepEqual(a.semantic.elems,b.semantic.elems);
  const request={label:'Edit motor stiffness',objects:[Mount.template({id:'motor-stiffness',name:'PLA motor mount',stiffness:[200,300,400,500,600,700]},b.ownership,nextPlateIds)]};
  const c=applyMount(b,request);assert.equal(c.changes.length,1);assert.equal(c.changes[0].after.value.K1,200);assert.ok(c.project.checks.every(c=>c.status!=='invalid'));
  assert.deepEqual(c.semantic.elems.bush,a.semantic.elems.bush);
});
test('topology replacement, missing face resolution and unsupported downstream consumers stay blocked',async()=>{
  const a=await mountedPair();
  const topology=await Cad.build(cadInput({name:'split-box'}),a.ownership,nextPlateIds);
  assert.throws(()=>Mount.rebuild(a.ownership,topology.request),/Mounting region.*left mount.*geometry changed/);
  const scope=await Cad.build(cadInput({size:2}),a.ownership,nextPlateIds);scope.request.objects.find(o=>o.id==='cad').definition.faces=scope.request.objects.find(o=>o.id==='cad').definition.faces.filter(f=>f.id!==1);
  assert.throws(()=>Mount.rebuild(a.ownership,scope.request),/left mount.*not meshed/);
  const external=applyMount(a,{objects:[definition('future','connection',[],['motor-left'])]});
  const edited=applyMount(external,Cad.materialChange(external.ownership,'cad',{E:3500,nu:.36,rho:1.24e-9}));
  assert.equal(edited.project.checks.find(c=>c.id==='future').status,'invalid');
});
test('region edits are reviewed even without solver-card changes; support conflicts and invalid geometry fail',async()=>{
  const a=await mountedPair();
  const renamed=applyMount(a,Mount.region({id:'left',name:'Left motor flange',mesh:'cad',faces:[1]},a.ownership));
  assert.equal(renamed.changes.length,0);assert.ok(renamed.project.changes.some(c=>c.id==='left'));
  assert.throws(()=>applyMount(a,Mount.region({id:'right',name:'Right',mesh:'cad',faces:[1]},a.ownership)),/dependent|constrained/);
  assert.throws(()=>Mount.region({id:'empty',name:'Empty',mesh:'cad',faces:[]},a.ownership),/select one/);
  assert.throws(()=>Mount.region({id:'bad',name:'Bad',mesh:'cad',faces:[99]},a.ownership),/not meshed/);
  const malformed=copy(a.ownership),mesh=malformed.project.objects.find(o=>o.id==='cad');mesh.definition.faces[0].nodes=mesh.definition.faces[0].nodes.slice(0,2);
  assert.throws(()=>Mount.region({id:'tiny',name:'Tiny',mesh:'cad',faces:[1]},malformed),/three support/);
});
test('attachments reject invalid inputs and constrained supports without altering the model',async()=>{
  const a=await mountedPair(),base={id:'motor-left',name:'Motor',region:'left',mount:[0,3,2],shaft:[-20,3,2],components:'123',template:'motor-stiffness'};
  for(const change of [{components:'123456'},{components:'11'},{mount:[NaN,0,0]},{shaft:[0,3,2]},{template:'missing'}])assert.throws(()=>Mount.attachment({...base,...change},a.ownership,nextPlateIds));
  const constrained=copy(a);constrained.semantic.spc1.push({sid:3,nodes:[a.semantic.elems.rbe2[0].deps[0]],components:'1'});
  assert.throws(()=>applyMount(constrained,Mount.attachment(base,constrained.ownership,nextPlateIds)),/dependent|constrained/);
});
test('attachment removal retains shared templates/regions and protects shaft loads',async()=>{
  const a=await mountedPair();
  for(const id of ['left','motor-stiffness'])assert.throws(()=>Mount.removal(a.ownership,id),/Resolve dependent/);
  const loaded=copy(a),shaft=a.semantic.elems.bush[0].n[1];loaded.semantic.loads.force.push({sid:3,nid:shaft,mag:10,cid:0,dir:[0,0,1]});
  assert.throws(()=>applyMount(loaded,Mount.removal(loaded.ownership,'motor-left')),/Dangling reference/);
  const b=applyMount(a,Mount.removal(a.ownership,'motor-left'));assert.equal(b.semantic.elems.bush.length,1);assert.ok(b.ownership.project.objects.some(o=>o.id==='motor-stiffness'));assert.ok(b.ownership.project.objects.some(o=>o.id==='left'));
  assert.equal(b.semantic.nodes.some(([id])=>id===shaft),false);
});
test('attachment history, real source/free/small/large writer and saved ownership survive remesh',async()=>{
  const c=fixture();(await c.previewProjectChange((await Cad.build(cadInput(),null,nextPlateIds)).request)).commit();
  for(const [id,face] of [['left',1],['right',2]])(await c.previewProjectChange(Mount.rebuild(c.model.projectOwnership,Mount.region({id,name:id,mesh:'cad',faces:[face]},c.model.projectOwnership)))).commit();
  for(const [id,region,x] of [['motor-left','left',0],['motor-right','right',10]]){
    const input={id,name:id,region,mount:[x,3,2],shaft:[x+(x?20:-20),3,2],components:'123',template:'stiffness'};
    if(id==='motor-left')input.newTemplate={id:'stiffness',name:'NEMA17',stiffness:[1e5,2e5,3e5,1e4,2e4,3e4]};
    (await c.previewProjectChange(Mount.rebuild(c.model.projectOwnership,Mount.attachment(input,c.model.projectOwnership,nextPlateIds)))).commit();
  }
  const original=await exportParsed(c);c.workerModel.cardStream=original.cards;c.indexWorkerCardStream(original.cards);
  const before=copy(c.model.projectOwnership),depth=c.historyManager.stack.length;
  const built=await Cad.build(cadInput({size:2,order:2}),before,nextPlateIds);
  (await c.previewProjectChange(Mount.rebuild(before,built.request))).commit();
  assert.equal(c.historyManager.stack.length,depth+1);const after=copy(c.model.projectOwnership);
  c.historyManager.undo();assert.deepEqual(copy(c.model.projectOwnership),before);c.historyManager.redo();assert.deepEqual(copy(c.model.projectOwnership),after);
  for(const format of ['source','free','small','large']){
    const {indexes}=await exportParsed(c,format,original.deck);
    for(const e of c.model.elems.rbe2){const parsed=indexes.elements.get(e.eid);assert.equal(parsed.gn,e.gn);assert.equal(parsed.cm,e.cm);assert.deepEqual(copy(parsed.gmi),copy(e.deps));}
    for(const e of c.model.elems.bush){const parsed=indexes.elements.get(e.eid);assert.equal(parsed.cid,0);assert.deepEqual(copy(parsed.nids),copy(e.n));assert.equal(parsed.pid,e.pid);}
    assert.equal([...indexes.properties.values()].filter(p=>p.type==='PBUSH').length,1);
  }
  c.writeCardEngine=async()=>(await exportParsed(c)).deck;const saved=await c.saveProjectModel();c.loadFromText=async()=>{};await c.loadProjectModel(saved);
  assert.deepEqual(copy(O.validate(c.model.projectOwnership,O.snapshot(c.model)).snapshot()),after.project);
  const again=Mount.rebuild(c.model.projectOwnership,(await Cad.build(cadInput({size:2,order:2}),c.model.projectOwnership,nextPlateIds)).request);
  const tx=await c.previewProjectChange(again);assert.equal(tx.preview().changes.length,0);tx.discard();
});

test('explicit point and component edits retain identities and hand constraints on the independent shaft',async()=>{
  const a=await mountedPair(),before=copy(a.semantic.elems.bush),shaft=before[0].n[1];
  a.semantic.spc1.push({sid:8,nodes:[shaft],components:'123456'});
  const request=Mount.attachment({id:'motor-left',name:'Left motor moved',region:'left',mount:[-2,3,2],shaft:[-25,3,2],components:'12',template:'motor-stiffness'},a.ownership,nextPlateIds);
  const b=applyMount(a,request);assert.deepEqual(b.semantic.elems.bush.slice().sort((a,b)=>a.eid-b.eid),before.slice().sort((a,b)=>a.eid-b.eid));assert.equal(b.semantic.elems.rbe2.find(e=>e.gn===before[0].n[0]).cm,'12');
  assert.equal(b.semantic.nodes.find(([id])=>id===shaft)[1].x,-25);assert.deepEqual(b.semantic.spc1,a.semantic.spc1);
  const refined=applyMount(b,(await Cad.build(cadInput({size:2}),b.ownership,nextPlateIds)).request);
  assert.deepEqual(refined.semantic.spc1,a.semantic.spc1);assert.equal(refined.semantic.elems.bush.find(e=>e.eid===before[0].eid).n[1],shaft);
});
test('union regions deduplicate shared nodes and older meshes require face provenance before authoring',async()=>{
  const a=await cadPreview(),mesh=a.ownership.project.objects.find(o=>o.id==='cad');
  const request=Mount.region({id:'union',name:'Multi-face mount',mesh:'cad',faces:[1,3,1]},a.ownership),d=request.objects[0].definition;
  assert.deepEqual(d.selector.faces,[1,3]);assert.deepEqual(d.resolved.nodes,[...new Set(mesh.definition.faces.filter(f=>[1,3].includes(f.id)).flatMap(f=>f.nodes))].sort((a,b)=>a-b));
  const older=copy(a.ownership);delete older.project.objects.find(o=>o.id==='cad').definition.faces;
  assert.throws(()=>Mount.region({id:'old',name:'Legacy mount',mesh:'cad',faces:[1]},older),/reviewed mesh regeneration/);
  const regenerated=O.preview(a.semantic,older,(await Cad.build(cadInput(),older,nextPlateIds)).request);
  assert.equal(regenerated.changes.length,0);assert.doesNotThrow(()=>Mount.region({id:'old',name:'Legacy mount',mesh:'cad',faces:[1]},regenerated.ownership));
});
