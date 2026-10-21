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
  // Sessions the mock server holds besides the one imported here (left from before a reload), and errors to return once.
  const others = [{ cadId: 'd'.repeat(32), filename: 'old.step', steps: 3, kept: 4, label: 'Sliced the web', revision: 3, created: 0, lastUsed: Date.now() / 1000 - 600, bytes: 40 * 1048576, discrete: false },
    { cadId: 'e'.repeat(32), filename: 'scrap.step', steps: 0, kept: 1, label: 'Imported geometry', revision: 0, created: 0, lastUsed: Date.now() / 1000 - 7200, bytes: 5 * 1048576, discrete: false }];
  const failNext = {};
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
      if (failNext[action]) { const error = failNext[action]; delete failNext[action]; return { ok: false, json: async () => ({ error }) }; }
      let result;
      if (action === 'import') result = payload(imported, revision);
      else if (action === 'preview') result = { ...payload(prepared, revision), staged: true };
      else if (action === 'prepare') { assert.equal(data.revision, revision, 'prepare uses the current revision token'); revision++; result = payload(prepared, revision); }
      else if (action === 'undo') { revision++; result = payload(imported, revision); }
      else if (action === 'redo' || action === 'revert') { revision++; result = { ...payload(prepared, revision), cursor: action === 'revert' ? data.to : undefined }; }
      else if (action === 'export') result = { filename: 'part-prepared.brep', format: 'brep', content: btoa('brep'), history: [] };
      else if (action === 'sessions' || action === 'close') {
        if (action === 'close') { const at = others.findIndex(s => s.cadId === data.cadId); if (at >= 0) others.splice(at, 1); }
        result = { sessions: others.map(plain), bytes: others.reduce((sum, s) => sum + s.bytes, 0), budget: 512 * 1048576 };
      }
      else if (action === 'resume') {
        const other = others.find(s => s.cadId === data.cadId);
        result = { ...payload(prepared, other.revision), cadId: other.cadId, filename: other.filename, cursor: 1, original: { filename: other.filename, format: 'step', content: btoa('STEP') } };
      }
      else if (action === 'mesh') result = { mesh: { nodes: [{ id: 1, x: 0, y: 0, z: 0 }], elements: [{ id: 1, type: 'CTETRA', pid: 1, nodes: [1, 1, 1, 1] }] }, quality: { minScaledJacobian: 0.5 } };
      else if (action === 'shell') {
        const midsurface = data.placement === 'midsurface';
        result = { mesh: { nodes: [{ id: 1, x: 0, y: 0, z: 0 }, { id: 2, x: 1, y: 0, z: 0 }, { id: 3, x: 1, y: 1, z: 0 }, { id: 4, x: 0, y: 1, z: 0 }], elements: [{ id: 1, type: 'CQUAD4', pid: 1, nodes: [1, 2, 3, 4] }] },
          quality: { elements: 1, nodes: 4, freeEdges: 4, nonManifoldEdges: 0, minScaledJacobian: 1, meanScaledJacobian: 1, histogram: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1], faces: [{ face: 1, quads: 1, valid: true, issues: [] }], oddEdges: [],
            placement: midsurface ? { placement: 'midsurface', thickness: 2.5, minThickness: 2.5, maxThickness: 2.5 } : { placement: data.placement || 'surface' },
            pads: (data.pads || []).map((p, i) => ({ pad: i, face: 1, holeFaces: p.faces, diameter: 4.6, size: p.size || 8.6, perSide: p.perSide || 2, shrunk: !p.size, minScaledJacobian: 0.7 })) } };
      }
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
  return { workspace, calls, click, input, emit, owned, failNext, others, get revision() { return revision; }, setOwned: list => { owned.elements = list; } };
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
  assert.equal(f.workspace.getState().tool, null, 'applying ends the action: the next pick starts fresh');
  assert.equal(f.workspace.getState().pending, null);
});

test('when Auto-fix cannot finish it says so and points to fixing the rest by hand', async () => {
  // Every preview returns the same blocked L, so no step helps.
  const f = await imported({ imported: 'l-shape', prepared: 'l-shape' });
  f.click('auto-fix');
  for (let i = 0; i < 200 && !f.calls.messages.some(m => /^Auto-fix/.test(m.text)); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const message = f.calls.messages.find(m => /^Auto-fix/.test(m.text)).text;
  assert.match(message, /found no cut/);
  assert.match(message, /Continue by hand/);
  assert.match(message, /fuse/);
  assert.equal(f.workspace.getState().revision, 0, 'nothing was applied');
});

test('Auto-fix changes wait in the readiness card to be kept or discarded', async () => {
  const run = async () => {
    const f = await imported({ imported: 'l-shape', prepared: 'l-split' });
    const before = f.calls.messages.length;
    f.click('auto-fix');
    for (let i = 0; i < 200 && !f.calls.messages.slice(before).some(m => /^Auto-fix made/.test(m.text)); i++) await new Promise(resolve => setTimeout(resolve, 10));
    return f;
  };
  let f = await run();
  assert.equal(f.workspace.getState().revision, 1, 'the cut is applied for review');
  let view = f.workspace.render().body;
  assert.match(view, /Auto-fix made 1 change/);
  assert.match(view, /data-act="auto-keep"/);
  assert.match(view, /data-act="auto-discard"/);
  assert.doesNotMatch(view, /Undo Auto-fix/);
  f.click('auto-discard');
  for (let i = 0; i < 100 && !f.calls.requests.some(r => r.action === 'revert'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.requests.find(r => r.action === 'revert').data.to, 0, 'Discard returns to the state before Auto-fix');
  assert.doesNotMatch(f.workspace.render().body, /auto-keep/);

  f = await run();
  f.click('auto-keep');
  view = f.workspace.render().body;
  assert.doesNotMatch(view, /auto-keep/);
  assert.ok(!f.calls.requests.some(r => r.action === 'revert' || r.action === 'undo'), 'Keep changes nothing');
  assert.equal(f.workspace.getState().revision, 1);
});

test('Stop ends a running Auto-fix and Auto-fix keeps features by default', async () => {
  const f = await imported({ imported: 'l-shape', prepared: 'l-split' });
  assert.doesNotMatch(f.workspace.render().body, /data-field="auto-blends" checked/, 'feature removal is off by default');
  f.click('auto-fix');
  assert.match(f.workspace.render().body, /data-act="auto-stop"/);
  f.click('auto-stop');
  for (let i = 0; i < 200 && !f.calls.messages.some(m => /^Auto-fix/.test(m.text)); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(f.calls.messages.find(m => /^Auto-fix/.test(m.text)).text, /stopped/i);
  assert.equal(f.workspace.getState().revision, 0, 'it stopped before applying anything');
});

test('the shell method meshes picked faces at a midsurface and gives the PSHELL the measured thickness', async () => {
  const f = await imported({ imported: 'box', prepared: 'box' });
  f.click('step', { value: 'mesh' });
  f.click('mesh-method', { value: 'shell' });
  let view = f.workspace.render();
  assert.match(view.body, /Shell mesh/);
  assert.match(view.foot, /Generate shell mesh/);
  f.click('shell-placement', { value: 'midsurface' });
  f.workspace.api.select('face', [1]);
  f.click('shell-side', { value: 'a' });
  f.click('shell-opposite');
  assert.match(f.workspace.render().body, /Side B <strong>1 face/);
  f.click('shell-mesh');
  for (let i = 0; i < 200 && !f.calls.appends.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const request = f.calls.requests.find(r => r.action === 'shell').data;
  assert.equal(request.placement, 'midsurface');
  assert.deepEqual(plain(request.faceIds), [1]);
  assert.deepEqual(plain(request.facesB), [2], 'the box face across from face 1');
  assert.equal(request.element, 'quad');
  assert.equal(f.calls.appends[0].options.thickness, 2.5);
  assert.equal(f.calls.appends[0].options.topology, 'quad');
  // On the faces, the thickness entered is used.
  f.click('shell-placement', { value: 'surface' });
  f.input('shell-thickness', 1.25);
  f.click('shell-mesh');
  for (let i = 0; i < 200 && f.calls.appends.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.appends[1].options.thickness, 1.25);
  assert.equal(f.calls.requests.filter(r => r.action === 'shell')[1].data.faceIds, undefined, 'all faces');
});

test('pads are added from picked holes with their own size, sent with the shell mesh, reported and saved', async () => {
  const f = await imported({ imported: 'holed-wall', prepared: 'holed-wall' });
  const holes = require('../app/cad-features.js').recognize(f.workspace.getState().topology).features.filter(h => h.kind === 'hole').sort((a, b) => a.center[1] - b.center[1]);
  f.click('step', { value: 'mesh' });
  f.click('mesh-method', { value: 'shell' });
  f.click('shell-mesher', { value: 'paved' });
  assert.match(f.workspace.render().body, /Pads <strong>0 holes/);
  // A bore face with a size of 8 mm, then a hole by its rim edge with the guess.
  f.workspace.api.select('face', [holes[0].faces[0]]);
  assert.match(f.workspace.render().body, /Add 1 picked/);
  f.input('shell-pad-size', 8);
  f.click('shell-pad-add');
  const rim = f.workspace.getState().topology.faces.find(x => x.id === holes[1].faces[0]).edges[0];
  f.workspace.api.select('edge', [rim]);
  f.input('shell-pad-size', '');
  f.click('shell-pad-add');
  const body = f.workspace.render().body;
  assert.match(body, /Pads <strong>2 holes/);
  assert.match(body, /Ø4\.6 · 8 mm/);
  assert.match(body, /Ø4\.6 · auto/);
  f.click('shell-mesh');
  for (let i = 0; i < 200 && !f.calls.appends.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  const request = f.calls.requests.find(r => r.action === 'shell').data;
  assert.deepEqual(plain(request.pads), [{ faces: holes[0].faces.slice().sort((a, b) => a - b), size: 8 }, { faces: holes[1].faces.slice().sort((a, b) => a - b) }]);
  assert.match(f.workspace.getState().report.text, /Pads: Ø4\.6 → 8 mm, 2\/side; Ø4\.6 → 8\.6 mm, 2\/side \(shrunk to fit\)/);
  // Saved with the shell settings and restored.
  const saved = await f.workspace.serialize();
  const restored = setup({ imported: 'holed-wall', prepared: 'holed-wall' });
  restored.workspace.commitRestore(await restored.workspace.stageRestore(saved));
  restored.click('step', { value: 'mesh' });
  restored.click('mesh-method', { value: 'shell' });
  assert.match(restored.workspace.render().body, /Pads <strong>2 holes/);
  // The quadtree cannot keep a pad's nodes: the pads stay listed but are not sent.
  f.click('shell-mesher', { value: 'quadtree' });
  assert.match(f.workspace.render().body, /the quadtree leaves them out/);
  f.click('shell-mesh');
  for (let i = 0; i < 200 && f.calls.appends.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.requests.filter(r => r.action === 'shell')[1].data.pads, undefined);
  f.click('shell-pad-remove', { value: '0' });
  assert.match(f.workspace.render().body, /Pads <strong>1 hole/);
});

test('sessions on the server can be resumed after a reload, and closed with a confirming second click', async () => {
  const f = setup({ prepared: 'split-box' });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
  await settle();
  // No geometry open (a fresh page): the sessions are listed under Import.
  let body = f.workspace.render().body;
  assert.match(body, /Sessions on this server/);
  assert.match(body, /old\.step/);
  assert.match(body, /3 steps · Sliced the web · 40 MiB · 10 min ago/);
  f.click('session-resume', { value: 'd'.repeat(32) });
  await settle();
  const state = f.workspace.getState();
  assert.equal(state.cadId, 'd'.repeat(32));
  assert.equal(state.filename, 'old.step');
  assert.ok(f.calls.messages.some(m => /Resumed old\.step at “/.test(m.text)), JSON.stringify(f.calls.messages));
  // With a session open, Sessions lists them and marks this one.
  f.click('sessions');
  await settle();
  body = f.workspace.render().body;
  assert.match(body, /Open here/);
  f.click('session-close', { value: 'e'.repeat(32) });
  assert.match(f.workspace.render().body, /Confirm close/);
  assert.equal(f.calls.requests.filter(r => r.action === 'close').length, 0, 'one click only asks');
  f.click('session-close', { value: 'e'.repeat(32) });
  await settle();
  assert.equal(f.calls.requests.filter(r => r.action === 'close').length, 1);
  assert.doesNotMatch(f.workspace.render().body, /scrap\.step/);
  // Closing the open session clears the workspace.
  f.click('session-close', { value: 'd'.repeat(32) });
  f.click('session-close', { value: 'd'.repeat(32) });
  await settle();
  assert.equal(f.workspace.getState().cadId, undefined);
  assert.match(f.workspace.render().body, /Import CAD to start/);
});

test('full CAD storage opens the sessions list', async () => {
  const f = await imported();
  f.failNext.prepare = 'CAD storage is full (513 of 512 MiB). Close sessions you no longer need under Sessions, below the file name in CAD & mesh.';
  const faces = f.workspace.getState().topology.faces.filter(x => x.surface.kind === 'plane');
  f.workspace.api.select('face', [faces[0].id]);
  f.workspace.render();
  f.workspace.api.runAction(f.workspace.api.infer().findIndex(a => a.key === 'slice-parallel'));
  await f.workspace.api.waitForPreview();
  await assert.rejects(f.workspace.api.apply(), /CAD storage is full/);
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 2));
  const body = f.workspace.render().body;
  assert.match(body, /Sessions on this server/);
  assert.match(body, /old\.step/);
});

test('picked neighboring solids are fused through the preview and apply flow', async () => {
  const f = await imported({ imported: 'split-box', prepared: 'box' });
  const ids = f.workspace.getState().topology.volumes.map(v => v.id);
  f.workspace.api.pick('solid');
  f.workspace.api.select('solid', ids);
  const index = f.workspace.api.infer().findIndex(a => a.key === 'fuse');
  assert.equal(index, 0);
  f.workspace.api.runAction(index);
  await f.workspace.api.waitForPreview();
  await f.workspace.api.apply();
  const prepare = f.calls.requests.find(r => r.action === 'prepare');
  assert.deepEqual(plain(prepare.data.operation.volumeIds), ids.slice().sort((a, b) => a - b));
  assert.equal(prepare.data.operation.kind, 'fuse');
  assert.equal(f.workspace.getState().analysis.summary.volumes, 1);
});

test('history steps can be undone, redone and returned to, and Apply leaves nothing armed', async () => {
  const f = await imported();
  const faces = f.workspace.getState().topology.faces.filter(x => x.surface.kind === 'plane');
  f.workspace.api.select('face', [faces[0].id]);
  f.workspace.api.runAction(f.workspace.api.infer().findIndex(a => a.key === 'slice-parallel'));
  await f.workspace.api.waitForPreview();
  await f.workspace.api.apply();
  let state = f.workspace.getState();
  assert.equal(state.tool, null);
  assert.equal(state.pending, null);
  // Picking another face now offers fresh actions; nothing from the slice is still pending.
  f.workspace.api.select('face', [faces[1].id]);
  assert.equal(f.workspace.getState().pending, null);
  assert.equal(f.workspace.canUndo(), true);
  await f.workspace.api.history('undo');
  assert.equal(f.calls.requests.at(-1).action, 'undo');
  await f.workspace.api.history('revert', 0);
  const revert = f.calls.requests.at(-1);
  assert.equal(revert.action, 'revert');
  assert.equal(revert.data.to, 0);
  await f.workspace.api.history('redo');
  assert.equal(f.calls.requests.at(-1).action, 'redo');
  assert.match(f.workspace.render().body, /cad-history-list/);
});
