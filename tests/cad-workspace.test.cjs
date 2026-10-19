const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/cad-workspace.js'), 'utf8');
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mapping', name + '.json'), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));

function element(id) {
  const listeners = {};
  return { id, innerHTML: '', className: '', dataset: {}, hidden: false, style: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn), listeners, querySelector: () => null, querySelectorAll: () => [], appendChild() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
}

function setup({ imported = 'box', prepared = 'split-box' } = {}) {
  const calls = { requests: [], messages: [], appends: [], selections: [], overlays: [] };
  const listeners = new Map(), elements = new Map();
  for (const id of ['wb-panel-body', 'wb-panel-foot', 'cad-tool', 'cad-context', 'cad-edge-editor', 'cad-equations', 'cad-mesh-report', 'app', 'wb-cad-file']) elements.set(id, element(id));
  const owned = { elements: [], properties: [] };
  let revision = 0, busy = false, visible = true;
  const payload = (name, rev) => ({ ...plain(fixture(name)), cadId: 'c'.repeat(32), revision: rev, filename: 'part.step', history: Array.from({ length: rev + 1 }, (_, i) => ({ revision: i, label: i ? 'Changed' : 'Imported geometry' })) });
  const viewport = new Proxy({}, { get: (_, key) => key === 'section' ? () => new Float32Array() : key === 'volumeFaces' || key === 'faceVolumes' ? () => [] : (...args) => { if (key === 'setOverlay') calls.overlays.push(args[0]); } });
  const engine = {
    setCadGeometry() {}, clearCadGeometry() {}, setCadSelectionMode() {}, setCadSplitPlane() {}, setCadVisible(v) { visible = v; },
    getCadState: () => ({ visible }), getCadViewport: () => viewport, getMeshOwner: () => owned,
    selectCad(selection) { calls.selections.push(selection); }
  };
  const document = {
    getElementById: id => elements.get(id) || null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => element('created'), activeElement: null
  };
  const window = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } };
  const context = { window, document, location: { protocol: 'http:' }, File, btoa, atob, structuredClone, AbortController, setTimeout, clearTimeout, performance, console,
    async fetch(url, request) {
      const data = JSON.parse(request.body), action = url.split('/').pop();
      calls.requests.push({ action, data });
      let result;
      if (action === 'import') result = payload(imported, revision);
      else if (action === 'preview') result = { ...payload(prepared, revision), staged: true };
      else if (action === 'prepare') { assert.equal(data.revision, revision, 'prepare uses the current revision token'); revision++; result = payload(prepared, revision); }
      else if (action === 'undo') { revision++; result = payload(imported, revision); }
      else if (action === 'export') result = { filename: 'part-prepared.brep', format: 'brep', content: btoa('brep'), history: [] };
      else if (action === 'mesh') result = { mesh: { nodes: [{ id: 1, x: 0, y: 0, z: 0 }], elements: [{ id: 1, type: 'CTETRA', pid: 1, nodes: [1, 1, 1, 1] }] }, quality: { minScaledJacobian: 0.5 } };
      else throw Error('Unexpected API ' + url);
      return { ok: true, json: async () => result };
    } };
  vm.createContext(context);
  // The browser loads these modules into the same realm as the workspace.
  for (const file of ['hex-mapping.js', 'cad-features.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../app', file), 'utf8'), context);
  Object.assign(window, { WebMeshHexMapping: context.WebMeshHexMapping, WebMeshCadFeatures: context.WebMeshCadFeatures });
  vm.runInContext(source, context);
  const hooks = {
    engine: () => engine, isBusy: () => busy, render() { workspace.render(); workspace.bind(); }, refresh() {}, name() {}, log() {},
    message: (text, error) => calls.messages.push({ text, error: !!error }),
    async run(fn) { busy = true; try { await fn(); } finally { busy = false; } },
    async appendMesh(result, name, options) { calls.appends.push({ result, name, options }); Object.assign(owned, { elements: result.mesh.elements.map((_, i) => 1000 + i), properties: [5] }); return { elements: owned.elements.slice(), properties: [5] }; }
  };
  const workspace = window.WebMeshCadWorkspace.create(hooks);
  workspace.bind();
  workspace.activate(true);
  const panel = elements.get('wb-panel-body');
  const click = (act, data = {}) => panel.listeners.click[0]({ target: { closest: () => ({ dataset: { act, ...data }, disabled: false, setAttribute() {} }) }, preventDefault() {} });
  const input = (field, value, kind = 'change') => (kind === 'change' ? panel.listeners.change[0] : panel.listeners.input[0])({ target: { closest: selector => selector.includes('data-field') ? { dataset: { field }, value: String(value), type: 'text' } : null } });
  const emit = (name, detail) => (listeners.get(name) || []).forEach(fn => fn({ detail }));
  return { workspace, calls, click, input, emit, owned, get revision() { return revision; }, setOwned: list => { owned.elements = list; } };
}

async function imported(options) {
  const f = setup(options);
  await f.workspace.importFile(new File(['STEP'], 'part.step'));
  return f;
}

test('import analyzes every solid and renders the three-step workflow', async () => {
  const f = await imported();
  const state = f.workspace.getState();
  assert.deepEqual(plain(state.analysis.summary), { volumes: 1, mappable: 1, blocked: 0 });
  const view = f.workspace.render();
  assert.match(view.body, /cad-steps/);
  assert.match(view.body, /Mapped-mesh readiness/);
  assert.match(view.body, /Every solid is a mapped block/);
  assert.match(view.foot, /Next: Size/);
});

test('a picked face infers a slice; its preview is staged and Apply commits the same operation', async () => {
  const f = await imported();
  // An exterior box face cannot cut the box, so the inferred action is a parallel slice through its center.
  const faces = f.workspace.getState().topology.faces.filter(x => x.surface.kind === 'plane');
  f.workspace.api.select('face', [faces[0].id]);
  f.workspace.render();
  assert.ok(f.workspace.api.infer().some(a => a.key === 'slice-parallel'), 'exterior faces offer a parallel slice, not a useless one');
  f.workspace.api.select('face', [faces[0].id]);
  f.workspace.render();
  const actions = f.workspace.api.infer();
  const index = actions.findIndex(a => a.key === 'slice-parallel');
  assert.ok(index >= 0);
  f.workspace.api.runAction(index);
  const pending = f.workspace.getState().pending;
  assert.equal(pending.operation.kind, 'slice');
  await f.workspace.api.waitForPreview();
  assert.equal(f.workspace.getState().preview.status, 'ready');
  const preview = f.calls.requests.find(r => r.action === 'preview');
  assert.deepEqual(plain(preview.data.operation), plain(pending.operation));
  assert.equal(preview.data.revision, 0);
  assert.equal(pending.operation.planes[0].origin[0], 5, 'the parallel slice starts through the part center');
  await f.workspace.api.apply();
  const prepare = f.calls.requests.find(r => r.action === 'prepare');
  assert.deepEqual(plain(prepare.data.operation), plain(pending.operation));
  assert.equal(f.workspace.getState().revision, 1);
  assert.equal(f.workspace.getState().analysis.summary.volumes, 2);
  assert.equal(f.workspace.getState().pending, null);
});

test('defeature previews show the faces that will be removed', async () => {
  const f = await imported({ imported: 'plate-hole', prepared: 'box' });
  const hole = f.workspace.getState().topology.faces.find(x => x.surface.kind === 'cylinder').id;
  f.workspace.api.select('face', [hole]);
  f.workspace.render();
  const index = f.workspace.api.infer().findIndex(a => a.key === 'remove-feature');
  f.workspace.api.runAction(index);
  assert.deepEqual(plain(f.workspace.getState().pending.operation.faceIds), [hole]);
  assert.ok(f.calls.overlays.includes('pending-faces'));
  await f.workspace.api.waitForPreview();
  assert.ok(f.calls.overlays.includes('result'));
});

test('edge counts are hard controls that propagate, persist and restore', async () => {
  const f = await imported({ imported: 'split-box' });
  f.workspace.api.step('size');
  const edge = f.workspace.getState().topology.edges[0].id;
  f.workspace.api.setCount([edge], 7);
  const counts = f.workspace.getState().intervals.counts;
  assert.equal(counts[edge], 7);
  assert.ok(Object.values(counts).filter(n => n === 7).length >= 2, 'opposite edges follow');
  const saved = await f.workspace.serialize();
  assert.deepEqual(plain(saved.settings.sizing.edges), [{ id: edge, count: 7 }]);
  saved.settings.sizing.edges.push({ id: 99999, count: 3 }, { id: edge + 1, count: 2.5 });
  const restored = setup({ imported: 'split-box' });
  restored.workspace.commitRestore(await restored.workspace.stageRestore(saved));
  assert.equal(restored.workspace.getState().intervals.counts[edge], 7);
  assert.ok(restored.calls.messages.some(m => m.error && /do not match this CAD revision/.test(m.text)));
});

test('saved sizing with too many controls is rejected before any request', async () => {
  const f = await imported();
  const saved = await f.workspace.serialize();
  saved.settings.sizing.edges = Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, count: 2 }));
  const before = f.calls.requests.length;
  await assert.rejects(f.workspace.stageRestore(saved), /exceeds 2000 edge controls/);
  assert.equal(f.calls.requests.length, before);
});

test('conflicting fixed counts block meshing and are reported', async () => {
  const f = await imported({ imported: 'split-box' });
  f.workspace.api.step('size');
  const state = f.workspace.getState();
  // Two edges of one equality group fixed differently.
  const H = require('../app/hex-mapping.js');
  const group = H.solveIntervals(H.analyze(state.topology), { size: 1 }).groups.find(g => g.edges.length > 1);
  f.workspace.api.setCount([group.edges[0]], 4);
  f.workspace.api.setCount([group.edges[1]], 6);
  assert.equal(f.workspace.getState().intervals.conflicts, 1);
  f.workspace.api.step('mesh');
  f.workspace.api.preview();
  assert.match(f.workspace.getState().meshError, /Resolve the edge-count conflicts/);
});

test('native mapped meshes are previewed, then added with CAD ownership', async () => {
  const f = await imported({ imported: 'split-box' });
  f.workspace.api.step('mesh');
  f.workspace.api.preview();
  const quality = f.workspace.getState().mesh;
  assert.ok(quality.elements > 0 && quality.inverted === 0);
  await f.workspace.api.addMesh();
  const append = f.calls.appends[0];
  assert.equal(append.options.ownerTag, 'c'.repeat(32));
  assert.equal(append.options.topology, 'hex');
  assert.equal(append.result.mesh.elements.length, quality.elements);
  assert.ok(append.result.mesh.elements.every(e => e.type === 'CHEXA' && e.nodes.length === 8 && !('volume' in e)));
  assert.match(f.workspace.getState().report.text, /HEX8 elements/);
  const saved = await f.workspace.serialize();
  assert.equal(saved.mesh.elements.length, quality.elements);
});

test('model edits after meshing mark the CAD mesh stale; restoring requires complete ownership', async () => {
  const f = await imported({ imported: 'split-box' });
  f.workspace.api.step('mesh');
  await f.workspace.api.addMesh();
  for (const reason of ['view', 'selection']) f.emit('webmesh:change', { reason, reasons: [reason] });
  assert.ok(f.workspace.getState().report);
  f.setOwned([]);
  f.emit('webmesh:change', { reason: 'undo', reasons: ['model', 'undo'] });
  assert.equal(f.workspace.getState().report, null);
  const saved = await f.workspace.serialize();
  assert.equal(saved.mesh, undefined);
});

test('the Gmsh methods reuse fixed edge counts as exact divisions', async () => {
  const f = await imported({ imported: 'split-box' });
  f.workspace.api.step('size');
  const edge = f.workspace.getState().topology.edges[0].id;
  f.workspace.api.setCount([edge], 3);
  f.workspace.api.step('mesh');
  f.click('mesh-method', { value: 'gmsh' });
  f.input('legacy-method', 'tet');
  f.click('gmsh-mesh');
  await new Promise(resolve => setTimeout(resolve, 20));
  const mesh = f.calls.requests.find(r => r.action === 'mesh');
  assert.ok(mesh, 'mesh request sent');
  assert.deepEqual(mesh.data.edgeDivisions, [{ id: edge, divisions: 3 }]);
  assert.equal(mesh.data.cadId, 'c'.repeat(32));
  assert.equal(mesh.data.topology, 'tet');
});

test('undo returns to the previous revision and clears staged operations', async () => {
  const f = await imported();
  f.workspace.api.tool('heal');
  assert.equal(f.workspace.getState().pending.operation.kind, 'heal');
  f.click('undo');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(f.calls.requests.some(r => r.action === 'undo'));
  assert.equal(f.workspace.getState().pending, null);
});

test('the Cut tool collects edge and vertex picks into one bounded cut', async () => {
  const f = await imported({ imported: 't-junction', prepared: 't-junction' });
  const t = f.workspace.getState().topology;
  const vertex = p => t.vertices.find(v => v.point.every((x, i) => Math.abs(x - p[i]) < 1e-9)).id;
  const imprint = t.edges.find(e => e.curve?.kind === 'line' && e.vertices.every(v => { const p = t.vertices.find(x => x.id === v).point; return Math.abs(p[0] - 4) < 1e-9 && Math.abs(p[2] - 2) < 1e-9; }));
  f.workspace.api.pick('edge');
  f.workspace.api.select('edge', [imprint.id]);
  const along = f.workspace.api.infer().findIndex(a => a.key === 'cut-edges');
  assert.ok(along >= 0, 'an edge pick offers a bounded cut');
  f.workspace.api.runAction(along);
  let state = f.workspace.getState();
  assert.equal(state.tool, 'cut');
  assert.equal(state.pending.operation.rays.length, 1);
  assert.deepEqual(plain(state.selection.ids), [], 'the pick is consumed so the next one can follow');
  // While the cut is open, two picked vertices extend it.
  f.workspace.api.pick('vertex');
  f.workspace.api.select('vertex', [vertex([0, 0, 2]), vertex([4, 6, 2])]);
  const actions = f.workspace.api.infer();
  assert.equal(actions[0].label, 'Add to cut');
  f.workspace.api.runAction(0);
  state = f.workspace.getState();
  assert.equal(state.pending.operation.rays.length, 2);
  assert.match(f.workspace.render().body, /Vertices \d+ → \d+/);
  await f.workspace.api.waitForPreview();
  assert.deepEqual(plain(f.calls.requests.find(r => r.action === 'preview').data.operation), plain(state.pending.operation));
  f.click('cut-remove', { index: '1' });
  assert.equal(f.workspace.getState().pending.operation.rays.length, 1);
  await f.workspace.api.apply();
  assert.equal(f.calls.requests.find(r => r.action === 'prepare').data.operation.rays.length, 1);
  assert.equal(f.workspace.getState().tool, 'cut', 'the tool stays open for the next cut');
  assert.equal(f.workspace.getState().pending, null);
});
