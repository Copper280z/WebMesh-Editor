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
    model, selection: { nodes: new Set(), elems: new Set(), props: new Set() }, selectionManager: { state: { mode: "node" } },
    window: { dispatchEvent() {} }, CustomEvent: class {}, queueMicrotask,
    collectAuthoritativeElementRefs: () => Object.values(model.elems).flat(),
    getTotalElementCount: () => Object.values(model.elems).flat().length,
    getAllElementIds: () => Object.values(model.elems).flat().map(e => e.eid),
    collectSemanticElementNodeIds: e => e.n.slice(),
    getExpandedSelection: () => ({ selNodes: new Set([100]), selElems: new Set() }),
    resolveAllTransforms: () => ({ globalPositions: new Map(Array.from(model.nodes, ([id, p]) => [id, { x: p.x + (p.cp === 7 ? 100 : 0), y: p.y, z: p.z }])) }),
    ensureRichEditableSemanticElementAuthority: async () => {},
    elementArrayKeyForType: type => ({ CTRIA3: 'tri', CTRIA6: 'tri', CQUAD4: 'quad', CQUAD8: 'quad', CHEXA: 'hex', CTETRA: 'tet', CROD: 'rod' })[type],
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
  assert.deepEqual(plain(c.workbenchNextIds()), { node: 101, element: 2, property: 2, material: 4 });
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
