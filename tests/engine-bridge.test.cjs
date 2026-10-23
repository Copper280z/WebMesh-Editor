const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'editor-engine.js'), 'utf8');
const bridgeSource = source.slice(source.indexOf('  // Small public bridge:'), source.indexOf('  var workbenchPreview = null;'));
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const model = {
    nodes: new Map([[100, { x: 2, y: 3, z: 4, cp: 7 }]]),
    elems: { tri: [], quad: [], tet: [], hex: [], rod: [] },
    properties: new Map(), materials: new Map(), masses: new Map(),
    loads: { force: [{ sid: 9, nid: 100, f: 25 }], pload: [], moment: [], combination: [] },
    spc: [{ sid: 8, g: 100, c: '123', d: 0 }], spc1: [],
    coords: new Map([[7, { type: 'CORD2R', rid: 0 }]]), temperatures: [{ sid: 5, values: [120] }]
  };
  const context = {
    Map, Set, model, workerModel: null, hidden: { nodes: new Set(), elems: new Set() }, semanticFamilyForCardName: () => "mixed", selection: { nodes: new Set(), elems: new Set(), props: new Set() }, selectionManager: { state: { mode: "node" } },
    window: { dispatchEvent() {} }, CustomEvent: class {}, queueMicrotask, structuredClone,
    collectAuthoritativeElementRefs: () => Object.values(model.elems).flat(),
    getTotalElementCount: () => Object.values(model.elems).flat().length,
    getAllElementIds: () => Object.values(model.elems).flat().map(e => e.eid),
    collectSemanticElementNodeIds: e => e.type==='RBE2'?[e.gn,...e.deps]:e.n.slice(),
    getExpandedSelection: () => ({ selNodes: new Set([100]), selElems: new Set() }),
    resolveAllTransforms: () => ({ globalPositions: new Map(Array.from(model.nodes, ([id, p]) => [id, { x: p.x + (p.cp === 7 ? 100 : 0), y: p.y, z: p.z }])) }),
    ensureRichEditableSemanticElementAuthority: async () => {},
    elementArrayKeyForType: type => ({ CTRIA3: 'tri', CTRIA6: 'tri', CQUAD4: 'quad', CQUAD8: 'quad', CHEXA: 'hex', CTETRA: 'tet', CROD: 'rod', CBUSH:'bush', RBE2:'rbe2' })[type],
    historyManager: { pointer: -1, stack: [], recordAction(fn) { fn(); this.stack.push({}); this.pointer++; } },
    markCoreNodeSnapshotDirty() {}, rebuildNodeIndexFromModel() {}, invalidateElementLookup() {},
    refreshSemanticRelationshipIndexes() {}, buildGeometries() {}, syncWorkerFromEditorModel() {},
    refreshCounts() {}, populateModelTree() {}, statusMsg() {}, workbenchPreviewMesh() {}, fitView() {}
  };
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  return context;
}
const mesh = (type = 'CQUAD8', count = 8) => ({
  nodes: Array.from({ length: count }, (_, i) => ({ id: i + 1, x: i % 2, y: i % 3, z: i % 5 })),
  elements: [{ id: 1, pid: 1, type, nodes: Array.from({ length: count }, (_, i) => i + 1) }]
});

test('append creates quadratic shell properties in one history entry and preserves existing analysis data', async () => {
  const c = fixture();
  const loads = plain(c.model.loads), constraints = plain(c.model.spc), temperatures = plain(c.model.temperatures);
  await c.workbenchAppendMesh(mesh(), { material: { id: 3, E: 70000, nu: 0.33, rho: 2.7e-9 }, thickness: 2 });
  assert.equal(c.model.nodes.size, 9);
  assert.equal(c.model.elems.quad[0].n.length, 8);
  assert.equal(c.model.elems.quad[0].type, 'CQUAD8');
  assert.equal(c.model.properties.get(1).type, 'PSHELL');
  assert.equal(c.model.properties.get(1).mid1, 3);
  assert.equal(c.model.properties.get(1).t, 2);
  assert.equal(c.model.materials.get(3).E, 70000);
  assert.equal(c.historyManager.stack.length, 1);
  assert.deepEqual(plain(c.model.loads), loads);
  assert.deepEqual(plain(c.model.spc), constraints);
  assert.deepEqual(plain(c.model.temperatures), temperatures);
  assert.equal(c.model.coords.get(7).type, 'CORD2R');
  assert.deepEqual(plain(c.workbenchNextIds()), { node: 101, element: 2, coordinate: 8, property: 2, material: 4 });
});

for (const [type, count, bucket] of [['CTRIA6', 6, 'tri'], ['CTETRA10', 10, 'tet'], ['CHEXA20', 20, 'hex']]) {
  test(`${type} retains all midside nodes and canonical Nastran type`, async () => {
    const c = fixture();
    await c.workbenchAppendMesh(mesh(type, count));
    const exported = c.workbenchGetMesh();
    assert.equal(exported.elements[0].nodes.length, count);
    assert.equal(c.model.elems[bucket][0].n.length, count);
    assert.equal(exported.nodes.find(n => n.id === 100).x, 102, 'mesh coordinates must be global');
    assert.equal(exported.elements[0].type, type.replace(/10$|20$/, ''));
    assert.equal(c.model.properties.get(1).type, bucket === 'tri' ? 'PSHELL' : 'PSOLID');
  });
}

test('existing compatible properties and materials are reused without replacing them', async () => {
  const c = fixture();
  const property = { type: 'PCOMP', pid: 1, plies: [{ mid: 5, t: 0.2 }] };
  c.model.properties.set(1, property);
  c.model.materials.set(5, { mid: 5, type: 'MAT8' });
  await c.workbenchAppendMesh(mesh());
  assert.equal(c.model.properties.get(1), property);
  assert.equal(c.model.materials.size, 1);
});

for (const [name, mutate, options] of [
  ['a node collision', m => { m.nodes[0].id = 100; }],
  ['an element collision', m => { m.elements.push({ ...m.elements[0] }); }],
  ['missing connectivity', m => { m.elements[0].nodes[7] = 999; }],
  ['repeated connectivity', m => { m.elements[0].nodes[7] = 1; }],
  ['an incorrect node count', m => { m.elements[0].nodes.pop(); }],
  ['nonfinite coordinates', m => { m.nodes[0].x = Infinity; }],
  ['an invalid material', () => {}, { material: { E: -2 } }],
  ['invalid thickness', () => {}, { thickness: 0 }],
]) {
  test(`append rejects ${name} before any model mutation`, async () => {
    const c = fixture(), candidate = mesh();
    mutate(candidate);
    await assert.rejects(c.workbenchAppendMesh(candidate, options));
    assert.equal(c.model.nodes.size, 1);
    assert.equal(c.workbenchState().elements, 0);
    assert.equal(c.model.properties.size, 0);
    assert.equal(c.model.materials.size, 0);
    assert.equal(c.historyManager.stack.length, 0);
  });
}

test('append rejects a property shared across shell and solid dimensions', async () => {
  const c = fixture();
  c.model.properties.set(1, { type: 'PSOLID', mid: 1 });
  await assert.rejects(c.workbenchAppendMesh(mesh()), /needs PSHELL/);
  assert.equal(c.model.nodes.size, 1);
});

test('selected mesh reads use resolved global coordinates', () => {
  const c = fixture();
  assert.deepEqual(plain(c.workbenchGetMesh({ selectedOnly: true })), { nodes: [{ id: 100, x: 102, y: 3, z: 4 }], elements: [] });
});

// Welding can legitimately map every generated vertex to an existing GRID.
test('a welded mesh may add elements without adding nodes', async () => {
  const c = fixture();
  c.model.nodes.set(101, { x: 0, y: 0, z: 0 });
  c.model.nodes.set(102, { x: 1, y: 0, z: 0 });
  await c.workbenchAppendMesh({ nodes: [], elements: [{ id: 1, pid: 1, type: 'CTRIA3', nodes: [100,101,102] }] });
  assert.equal(c.model.nodes.size, 3);
  assert.equal(c.model.elems.tri.length, 1);
  assert.equal(c.historyManager.stack.length, 1);
});

function nextMesh() {
  const next = mesh();
  next.nodes = next.nodes.map(row => ({ ...row, id: row.id + 20 }));
  next.elements = [{ ...next.elements[0], id: 2, nodes: next.elements[0].nodes.map(id => id + 20) }];
  return next;
}

test('CAD remeshing atomically replaces the owned mesh and prunes its unreferenced nodes', async () => {
  const c = fixture();
  await c.workbenchAppendMesh(mesh(), { ownerTag: 'cad-A' });
  const result = await c.workbenchAppendMesh(nextMesh(), { ownerTag: 'cad-A', replaceOwner: true, replaceElements: [1, 999] });
  assert.equal(c.workbenchState().elements, 1);
  assert.equal(c.model.elems.quad[0].eid, 2);
  assert.equal(c.model.nodes.size, 9, '8 replacement nodes and the unrelated GRID remain');
  for (let id = 1; id <= 8; id++) assert.equal(c.model.nodes.has(id), false);
  assert.equal(c.historyManager.stack.length, 2, 'each complete generation is one history operation');
  assert.equal(c.model.properties.size, 1); assert.equal(c.model.materials.size, 1);
  assert.deepEqual(plain(result.operation.replacedElements), [1]);
  assert.deepEqual(plain(c.workbenchGetMesh().elements.map(row => row.ownerTag)), ['cad-A']);
});

test('replacement preserves nodes referenced by unrelated elements, loads, supports, coordinates, masses and temperatures', async () => {
  const c = fixture(); await c.workbenchAppendMesh(mesh(), { ownerTag: 'cad-A' });
  c.model.elems.rod.push({ eid: 99, pid: 9, type: 'CROD', n: [1,100] });
  c.model.loads.force.push({ sid: 10, nid: 2 });
  c.model.spc.push({ sid: 11, g: 3, c: '123' });
  c.model.coords.set(8, { type: 'CORD1R', nodes: [4,100,1] });
  c.model.masses.set(70, { type: 'CONM2', g: 5 });
  c.model.temperatures.push({ sid: 12, nodeIds: [6], values: [100] });
  c.model.nodes.get(7).ps = '123';
  const result = await c.workbenchAppendMesh(nextMesh(), { ownerTag: 'cad-A', replaceOwner: true });
  for (let id = 1; id <= 7; id++) assert.equal(c.model.nodes.has(id), true, `referenced GRID ${id} remains`);
  assert.equal(c.model.nodes.has(8), false);
  assert.deepEqual(plain(result.operation.removedNodes), [8]);
  assert.equal(c.workbenchState().elements, 2, 'unrelated rod and new mesh remain');
});

test('unknown solver-card node references are retained during mesh replacement', async () => {
  const c = fixture(); await c.workbenchAppendMesh(mesh(), { ownerTag: 'cad-A' });
  c.workerModel = { cardStream: [{ kind: 'card', name: 'SUPORT', tokens: ['SUPORT', '8', '123'] }] };
  await c.workbenchAppendMesh(nextMesh(), { ownerTag: 'cad-A', replaceOwner: true });
  assert.equal(c.model.nodes.has(8), true);
});

test('remeshing rejects dangling element pressure loads without changing the previous mesh', async () => {
  const c = fixture(); await c.workbenchAppendMesh(mesh(), { ownerTag: 'cad-A' });
  c.model.loads.pload.push({ type: 'PLOAD2', sid: 13, eids: [1], p: 5 });
  await assert.rejects(c.workbenchAppendMesh(nextMesh(), { ownerTag: 'cad-A', replaceOwner: true }), /element-based loads/);
  assert.equal(c.model.elems.quad[0].eid, 1);
  assert.equal(c.model.nodes.has(21), false);
  assert.equal(c.historyManager.stack.length, 1);
});

test('replacement refuses elements owned by a different CAD source', async () => {
  const c = fixture(); await c.workbenchAppendMesh(mesh(), { ownerTag: 'cad-A' });
  await assert.rejects(c.workbenchAppendMesh(nextMesh(), { ownerTag: 'cad-B', replaceElements: [1] }), /another CAD source/);
  assert.equal(c.model.elems.quad[0].eid, 1);
});

test('invalid replacement connectivity rejects before removing the owned mesh', async () => {
  const c = fixture(); await c.workbenchAppendMesh(mesh(), { ownerTag: 'cad-A' });
  const next = nextMesh(); next.elements[0].nodes[0] = 900;
  await assert.rejects(c.workbenchAppendMesh(next, { ownerTag: 'cad-A', replaceOwner: true }), /missing node/);
  assert.equal(c.model.elems.quad[0].eid, 1);
  assert.equal(c.model.nodes.size, 9);
});

test('project-restored mesh ownership is present in the undo baseline', async () => {
  const c = fixture(); await c.workbenchAppendMesh(mesh());
  await c.workbenchBindMeshOwner('restored-cad', [1]);
  let previous;
  c.historyManager.recordAction = fn => { previous = plain(c.model.elems); fn(); };
  await c.workbenchAppendMesh(nextMesh(), { ownerTag: 'restored-cad', replaceElements: [1], replaceOwner: true });
  assert.equal(previous.quad[0].webmeshOwner, 'restored-cad');
  c.model.elems = previous;
  const next = nextMesh(); next.elements[0].id = 3; next.nodes = next.nodes.map(row => ({ ...row, id: row.id + 20 })); next.elements[0].nodes = next.elements[0].nodes.map(id => id + 20);
  await c.workbenchAppendMesh(next, { ownerTag: 'restored-cad', replaceElements: [2], replaceOwner: true });
  assert.deepEqual(plain(c.model.elems.quad.map(row => row.eid)), [3]);
});

test('CAD remeshing preserves unrelated elements that reuse IDs freed by undo', async () => {
  const c = fixture();
  await c.workbenchAppendMesh(mesh(), { ownerTag: 'cad-A' });
  // Undo the generation, then create an unrelated mesh that reuses its IDs.
  c.model.elems.quad = [];
  for (let id = 1; id <= 8; id++) c.model.nodes.delete(id);
  assert.deepEqual(plain(c.workbenchGetMeshOwner('cad-A').elements), []);
  await c.workbenchAppendMesh(mesh());
  const unrelated = c.model.elems.quad[0];
  const result = await c.workbenchAppendMesh(nextMesh(), { ownerTag: 'cad-A', replaceOwner: true, replaceElements: [1] });
  assert.equal(c.model.elems.quad.length, 2);
  assert.equal(c.model.elems.quad[0], unrelated);
  assert.equal(unrelated.webmeshOwner, undefined);
  for (let id = 1; id <= 8; id++) assert.equal(c.model.nodes.has(id), true);
  assert.deepEqual(plain(result.operation.replacedElements), []);
  assert.deepEqual(plain(c.workbenchGetMeshOwner('cad-A').elements), [2]);
  assert.deepEqual(plain(c.workbenchGetMeshOwner('cad-A').properties), [1]);
});

test('restored ownership is explicit metadata adoption and validates before tagging', async () => {
  const c = fixture(); await c.workbenchAppendMesh(mesh());
  const historyLength = c.historyManager.stack.length;
  const owner = await c.workbenchBindMeshOwner('restored-cad', [1, 999]);
  assert.deepEqual(plain(owner.elements), [1]);
  assert.deepEqual(plain(owner.nodes), [1,2,3,4,5,6,7,8]);
  assert.equal(c.historyManager.stack.length, historyLength, 'metadata adoption creates no solver edit');
  await assert.rejects(c.workbenchBindMeshOwner('other-cad', [1]), /another CAD source/);
  assert.equal(c.model.elems.quad[0].webmeshOwner, 'restored-cad');
  await assert.rejects(c.workbenchBindMeshOwner('restored-cad', [1, -2]), /positive element IDs/);
});

function boltFixture() {
  const c=fixture();c.model.nodes.clear();c.model.coords.clear();c.model.loads.force=[];c.model.spc=[];c.model.temperatures=[];
  return c;
}
const modeling=require('../app/modeling.js');
const boltSubstrate=()=>modeling.createPrimitive({kind:'block',size:[12,12,2],divisions:[6,6,1],topology:'hex',order:1});
function boltAssembly(c) {
  const next=c.workbenchNextIds();
  return modeling.createBoltPattern(plain(c.workbenchGetMesh()),{center:[4,4,1],axis:[0,0,1],grip:2,attachmentRadius:2.1,tolerance:1e-6,stiffness:[1e6,2e5,2e5,3e4,4e4,4e4],pid:next.property,startNode:next.node,startElement:next.element});
}

test('a complete simulated bolt appends atomically and preserves attachment nodes, definitions and connector semantics', async () => {
  const c=boltFixture();await c.workbenchAppendMesh(boltSubstrate());
  const beforeNodes=c.model.nodes.size,beforeElements=c.workbenchState().elements,beforeMaterials=c.model.materials.size;
  const assembly=boltAssembly(c);await c.workbenchAppendMesh(assembly);
  assert.equal(c.model.nodes.size,beforeNodes+2);assert.equal(c.workbenchState().elements,beforeElements+3);
  assert.equal(c.model.materials.size,beforeMaterials,'PBUSH creates no material');
  assert.equal(c.historyManager.stack.length,2,'one substrate operation and one complete bolt operation');
  const p=c.model.properties.get(assembly.properties[0].id);assert.equal(p.type,'PBUSH');assert.equal(p.K1,1e6);assert.equal(p.K6,4e4);
  const readback=plain(c.workbenchGetMesh()),bush=readback.elements.find(e=>e.type==='CBUSH');
  assert.deepEqual(bush.orient,{kind:'x',x:[1,0,0]});assert.equal(bush.nodes.length,2);
  assert.ok(readback.elements.filter(e=>e.type==='RBE2').every(e=>e.cm==='123'&&e.nodes.length===6));
  for(const id of assembly.bolts[0].headNodes)assert.equal(c.model.nodes.has(id),true);
});

test('actual semantic history undo and redo remove and restore a complete bolt assembly together', async () => {
  const c=boltFixture();
  Object.assign(c,{selectMode:'node',currentElemInput:null,semanticTx:{apply(spec,fn){return {tx:spec,result:fn({})};}},updateUndoRedoButtons(){},flushPendingSemanticWorkerTransactions(){},rebuildLabels(){},trySyncWorkerGridsFromEditorModel(){}});
  const start=source.indexOf('  var HISTORY_SEMANTIC_FAMILIES =');
  vm.runInContext(source.slice(start,source.indexOf('  function updateOpacity()',start)),c);
  c.restoreHistoryUiState=()=>{};
  await c.workbenchAppendMesh(boltSubstrate());const substrateState=plain(c.workbenchGetMesh()),materialCount=c.model.materials.size;
  const assembly=boltAssembly(c);await c.workbenchAppendMesh(assembly);const assembledState=plain(c.workbenchGetMesh());
  assert.equal(c.historyManager.stack.length,2);
  c.historyManager.undo();
  assert.deepEqual(plain(c.workbenchGetMesh()),substrateState);
  assert.equal(c.model.properties.has(assembly.properties[0].id),false);assert.equal(c.model.materials.size,materialCount);
  c.historyManager.redo();
  assert.deepEqual(plain(c.workbenchGetMesh()),assembledState);
  assert.equal(c.model.properties.get(assembly.properties[0].id).K1,1e6);
});

test('bolt dependency conflicts and invalid PBUSH stiffness reject before adding any model records', async () => {
  for(const conflict of ['spc','duplicate','stiffness']) {
    const c=boltFixture();await c.workbenchAppendMesh(boltSubstrate());const assembly=boltAssembly(c);
    if(conflict==='spc')c.model.spc.push({sid:5,g:assembly.bolts[0].headNodes[0],c:'123',d:0});
    if(conflict==='duplicate')assembly.elements.push({...assembly.elements[1],id:assembly.elements.at(-1).id+1});
    if(conflict==='stiffness')assembly.properties[0].stiffness[0]=-1;
    const beforeNodes=c.model.nodes.size,beforeProperties=c.model.properties.size,beforeElements=c.workbenchState().elements;
    await assert.rejects(c.workbenchAppendMesh(assembly),/constrained or dependent|nonnegative/);
    assert.equal(c.model.nodes.size,beforeNodes);assert.equal(c.model.properties.size,beforeProperties);assert.equal(c.workbenchState().elements,beforeElements);
    assert.equal(c.historyManager.stack.length,1);
  }
});

test('actual engine synchronization and worker export retain bolt PBUSH, CBUSH and RBE2 cards', async () => {
  const c=boltFixture();await c.workbenchAppendMesh(boltSubstrate());const assembly=boltAssembly(c);await c.workbenchAppendMesh(assembly);
  const sync=require('./helpers/editor-sync-context.cjs')(0,0);Object.assign(sync.model,c.model);
  const refs=()=>({elementRefsByEid:new Map(Object.values(sync.model.elems).flat().map(e=>[e.eid,e]))});
  sync.context.ensureSemanticRelationshipIndexes=refs;sync.context.refreshSemanticRelationshipIndexes=refs;
  sync.context.syncWorkerFromEditorModel();assert.deepEqual(sync.warnings,[]);
  let deck;const worker=vm.createContext({Map,Set,self:{postMessage(message){if(message.type==='WRITE_COMPLETE')deck=message.text;}},TextEncoder,TextDecoder,performance,setTimeout,clearTimeout});
  vm.runInContext(require('./helpers/worker-source.cjs'),worker);worker.handleWriteRequest({model:sync.context.workerModel,options:{writeFormat:'free'}});
  assert.match(deck,/^PBUSH,2,K,/m);assert.equal((deck.match(/^RBE2,/gm)||[]).length,2);assert.equal((deck.match(/^CBUSH,/gm)||[]).length,1);
  const parsed=await worker.parseDeckToCardStream(deck,'assembled-bolts.bdf',{}, {strictMode:true,retainParseSession:true,retainSourceSession:false});
  assert.deepEqual(plain(parsed.errors),[]);const indexes=worker.getParseSession(parsed.model.parseSessionId).indexes;
  assert.equal(indexes.properties.get(2).K1,1e6);assert.equal([...indexes.elements.values()].filter(e=>e.type==='RBE2').length,2);
  assert.deepEqual(plain([...indexes.elements.values()].find(e=>e.type==='CBUSH').orient),{kind:'x',x:[1,0,0]});
});

test('card synchronization removes replaced quadratic shell records from exported decks', () => {
  const start = source.indexOf('    const semanticIndexes = ensureSemanticRelationshipIndexes("sync-worker-cardstream-filter");');
  const end = source.indexOf('    indexWorkerCardStream(workerModel.cardStream);', start);
  const workerModel = { cardStream: [
    { kind: 'card', name: 'CQUAD8', tokens: ['CQUAD8', '1'] }, { kind: 'card', name: 'CQUAD8', tokens: ['CQUAD8', '2'] },
    { kind: 'card', name: 'CTRIA6', tokens: ['CTRIA6', '3'] }, { kind: 'card', name: 'CTRIA6', tokens: ['CTRIA6', '4'] },
    { kind: 'card', name: 'GRID', tokens: ['GRID', '1'] }, { kind: 'card', name: 'GRID', tokens: ['GRID', '20'] },
    { kind: 'card', name: 'OTHER', tokens: ['OTHER', '1'] }
  ] };
  const context = vm.createContext({ Map, Set, workerModel,
    model: { nodes: new Map([[20, {}]]), coords: new Map(), masses: new Map() },
    ensureSemanticRelationshipIndexes: () => ({ elementRefsByEid: new Map([[2, { type: 'CQUAD8' }], [4, { type: 'CTRIA6' }]]) })
  });
  vm.runInContext(source.slice(start, end), context);
  assert.deepEqual(plain(workerModel.cardStream.map(card => card.name + ':' + card.tokens[1])), ['CQUAD8:2', 'CTRIA6:4', 'GRID:20', 'OTHER:1']);
});

const quad = (first, eid, pid = 1, extra = {}) => ({
  nodes: Array.from({ length: 4 }, (_, i) => ({ id: first + i, x: i % 2, y: i > 1 ? 1 : 0, z: first })),
  elements: [{ id: eid, pid, type: 'CQUAD4', nodes: [first, first + 1, first + 3, first + 2], ...extra }]
});

test('meshes of one CAD source stay side by side; one append can replace several of them', async () => {
  const c = fixture();
  await c.workbenchAppendMesh(quad(1, 1), { ownerTag: 'cad#1' });
  await c.workbenchAppendMesh(quad(11, 2), { ownerTag: 'cad#2', replaceOwner: true });
  assert.deepEqual(plain(c.workbenchGetMesh().elements.map(row => row.ownerTag)), ['cad#1', 'cad#2'], 'a new owner does not replace another');
  await c.workbenchAppendMesh(quad(21, 3), { ownerTag: 'cad#2', replaceOwner: true, replaceOwners: ['cad#1'] });
  assert.deepEqual(plain(c.workbenchGetMesh().elements.map(row => [row.id, row.ownerTag])), [[3, 'cad#2']]);
  assert.equal(c.model.nodes.size, 5, 'both replaced meshes lose their nodes; the unrelated GRID stays');
  assert.equal(c.historyManager.stack.length, 3, 'the double replacement is one history step');
});

test('removing one CAD mesh takes its elements and unused nodes in one step and leaves the others', async () => {
  const c = fixture();
  await c.workbenchAppendMesh(quad(1, 1), { ownerTag: 'cad#1' });
  await c.workbenchAppendMesh(quad(11, 2), { ownerTag: 'cad#2' });
  const left = await c.workbenchRemoveMeshOwner('cad#1');
  assert.deepEqual(plain(left.elements), []);
  assert.deepEqual(plain(c.workbenchGetMesh().elements.map(row => row.ownerTag)), ['cad#2']);
  assert.equal(c.model.nodes.size, 5);
  assert.equal(c.historyManager.stack.length, 3);
  await c.workbenchRemoveMeshOwner('cad#1');
  assert.equal(c.historyManager.stack.length, 3, 'removing an empty owner records nothing');
  await assert.rejects(c.workbenchAppendMesh({ nodes: [], elements: [] }, { ownerTag: 'cad#2' }), /nonempty mesh/);
});

test('sheets of several thicknesses get one PSHELL thickness each, and offset shells keep ZOFFS', async () => {
  const c = fixture();
  const sheets = quad(1, 1, 4, { zoffs: -1.5 });
  sheets.nodes.push(...quad(11, 2).nodes); sheets.elements.push({ ...quad(11, 2, 5).elements[0] });
  await c.workbenchAppendMesh(sheets, { ownerTag: 'cad#3', thickness: 1, thicknessByProperty: { 4: 3, 5: 4 } });
  assert.deepEqual([c.model.properties.get(4).t, c.model.properties.get(5).t], [3, 4]);
  assert.equal(c.model.elems.quad.find(e => e.eid === 1).zoffs, -1.5);
  assert.equal('zoffs' in c.model.elems.quad.find(e => e.eid === 2), false);
  // Remeshing with new thicknesses updates the reused properties.
  const again = quad(21, 3, 4); again.nodes.push(...quad(31, 4).nodes); again.elements.push({ ...quad(31, 4, 5).elements[0] });
  await c.workbenchAppendMesh(again, { ownerTag: 'cad#3', replaceOwner: true, thicknessByProperty: { 4: 2.5, 5: 6 } });
  assert.deepEqual([c.model.properties.get(4).t, c.model.properties.get(5).t], [2.5, 6]);
});
