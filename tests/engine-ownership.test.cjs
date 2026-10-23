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
async function exportParsed(c) {
  const messages = [];
  const worker = vm.createContext({ Map, Set, self: { postMessage: m => messages.push(m) }, console, TextEncoder, TextDecoder, performance, setTimeout, clearTimeout });
  vm.runInContext(require('./helpers/worker-source.cjs'), worker);
  worker.handleWriteRequest({ model: c.workerModel, options: { writeFormat: 'free' } });
  const deck = messages.find(m => m.type === 'WRITE_COMPLETE').text;
  const result = await worker.parseDeckToCardStream(deck, 'ownership.bdf', {}, { strictMode: true, retainParseSession: true, retainSourceSession: false });
  assert.deepEqual(copy(result.errors), []);
  return { deck, indexes: worker.getParseSession(result.model.parseSessionId).indexes };
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
