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

function setup({ imported = 'box', prepared = 'split-box', gmsh = true, projectReview = false } = {}) {
  const calls = { requests: [], messages: [], appends: [], selections: [], overlays: [], removed: [] };
  const listeners = new Map(), elements = new Map();
  for (const id of ['wb-panel-body', 'wb-panel-foot', 'cad-tool', 'cad-context', 'cad-edge-editor', 'cad-equations', 'cad-mesh-report', 'app', 'wb-cad-file']) elements.set(id, element(id));
  const owned = { elements: [], properties: [] }, owners = new Map();
  let nextElement = 1000;
  let revision = 0, busy = false, visible = true;
  // Sessions the mock server holds besides the one imported here (left from before a reload), and errors to return once.
  const others = [{ cadId: 'd'.repeat(32), filename: 'old.step', steps: 3, kept: 4, label: 'Sliced the web', revision: 3, created: 0, lastUsed: Date.now() / 1000 - 600, bytes: 40 * 1048576, discrete: false },
    { cadId: 'e'.repeat(32), filename: 'scrap.step', steps: 0, kept: 1, label: 'Imported geometry', revision: 0, created: 0, lastUsed: Date.now() / 1000 - 7200, bytes: 5 * 1048576, discrete: false }];
  const failNext = {}, transform = { fn: null };
  const payload = (name, rev) => ({ ...plain(fixture(name)), cadId: 'c'.repeat(32), revision: rev, filename: 'part.step', history: Array.from({ length: rev + 1 }, (_, i) => ({ revision: i, label: i ? 'Changed' : 'Imported geometry' })) });
  const viewport = new Proxy({}, { get: (_, key) => key === 'section' ? () => new Float32Array() : key === 'volumeFaces' || key === 'faceVolumes' ? () => [] : (...args) => { if (key === 'setOverlay') calls.overlays.push(args[0]); } });
  const engine = {
    setCadGeometry() {}, clearCadGeometry() {}, setCadSelectionMode() {}, setCadSplitPlane() {}, setCadVisible(v) { visible = v; },
    getCadState: () => ({ visible }), getCadViewport: () => viewport, getMeshOwner: tag => ({ elements: (owners.get(tag) || []).slice(), properties: [5] }),
    selectCad(selection) { calls.selections.push(selection); }
  };
  const document = {
    getElementById: id => elements.get(id) || null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => element('created'), activeElement: null
  };
  const window = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } };
  const context = { window, document, location: { protocol: 'http:' }, File, btoa, atob, structuredClone, AbortController, setTimeout, clearTimeout, performance, console, crypto: require('node:crypto').webcrypto,
    async fetch(url, request) {
      // The service reports which optional plugins it has (the Gmsh plugin may be missing).
      if (url === '/api/health') return { ok: true, json: async () => ({ cad: { available: true }, plugins: { gmsh: { available: gmsh } } }) };
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
      if (transform.fn) result = transform.fn(action, data, result) || result;
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
    async appendMesh(result, name, options) {
      calls.appends.push({ result, name, options });
      // Each owner tag keeps its own elements; replaced owners lose theirs.
      for (const tag of options.replaceOwners || []) owners.delete(tag);
      const elements = result.mesh.elements.map(() => nextElement++);
      owners.set(options.ownerTag, elements); Object.assign(owned, { elements, properties: [5] });
      return { elements: elements.slice(), properties: [5] };
    },
    async removeMesh(tag) { calls.removed.push(tag); owners.delete(tag); }
  };
  let projectState=null,semantic={nodes:[],elems:{hex:[]},materials:[],properties:[],masses:[],coords:[],loads:{},spc:[],spc1:[],temperatures:[]};
  const O=require('../app/engine-ownership.js'),Cad=require('../app/cad-project.js');
  engine.getProjectOwnership=()=>projectState;
  if(projectReview)hooks.reviewMappedMesh=async(input,callbacks)=>{
    const built=await Cad.build(plain(input),projectState,{node:1,element:1,property:1,material:1});
    const candidate=O.preview(semantic,projectState,built.request);
    calls.review={input:plain(input),candidate,apply(){callbacks.beforeCommit();projectState=candidate.ownership;semantic=candidate.semantic;callbacks.onApplied();}};
  };
  const workspace = window.WebMeshCadWorkspace.create(hooks);
  workspace.bind();
  workspace.activate(true);
  const panel = elements.get('wb-panel-body');
  const click = (act, data = {}) => panel.listeners.click[0]({ target: { closest: () => ({ dataset: { act, ...data }, disabled: false, setAttribute() {} }) }, preventDefault() {} });
  const input = (field, value, kind = 'change') => (kind === 'change' ? panel.listeners.change[0] : panel.listeners.input[0])({ target: { closest: selector => selector.includes('data-field') ? { dataset: { field }, value: String(value), type: 'text' } : null } });
  const emit = (name, detail) => (listeners.get(name) || []).forEach(fn => fn({ detail }));
  return { workspace, calls, click, input, emit, owned, failNext, others, transform, get revision() { return revision; }, setOwned: list => { owned.elements = list; if (!list.length) owners.clear(); } };
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
  assert.equal(append.options.ownerTag, 'c'.repeat(32) + '#1', 'each mesh has its own owner tag');
  assert.equal(append.options.topology, 'hex');
  assert.equal(append.result.mesh.elements.length, quality.elements);
  assert.ok(append.result.mesh.elements.every(e => e.type === 'CHEXA' && e.nodes.length === 8 && !('volume' in e)));
  assert.match(f.workspace.getState().report.text, /HEX8 elements/);
  const saved = await f.workspace.serialize();
  assert.equal(saved.meshes.length, 1);
  assert.equal(saved.meshes[0].elements.length, quality.elements);
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
  assert.equal(saved.meshes, undefined);
});

test('meshes of different bodies stay side by side; a new one replaces only the mesh of the same bodies', async () => {
  const f = await imported({ imported: 'split-box' });
  const t = f.workspace.getState().topology, settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
  f.workspace.api.step('mesh');
  await f.workspace.api.addMesh();
  // A shell mesh of two picked faces joins the hex mesh instead of replacing it.
  f.click('mesh-method', { value: 'shell' });
  f.click('shell-scope', { value: 'selected' });
  f.workspace.api.select('face', [t.faces[0].id, t.faces[1].id]);
  f.click('shell-mesh'); await settle();
  let appends = f.calls.appends;
  assert.equal(appends.length, 2);
  assert.equal(appends[1].options.ownerTag, 'c'.repeat(32) + '#2');
  assert.deepEqual(plain(appends[1].options.replaceOwners), []);
  assert.equal(appends[1].options.previousMesh, null, 'the hex mesh is not replaced');
  let body = f.workspace.render().body;
  assert.match(body, /Mesh regions <small>2/);
  assert.match(body, /Mapped HEX8 · 2 solids/);
  assert.match(body, /Quad shell · 1 face/, 'the mock shell result meshes face 1');
  // Meshing the same faces again replaces the shell mesh only.
  f.click('shell-mesh'); await settle();
  appends = f.calls.appends;
  assert.equal(appends[2].options.ownerTag, 'c'.repeat(32) + '#2');
  assert.ok(appends[2].options.previousMesh, 'the shell mesh is replaced in place');
  assert.match(f.workspace.render().body, /Mesh regions <small>2/);
  // Both are saved, and a restored project rebinds each to the new CAD session.
  const saved = await f.workspace.serialize();
  assert.deepEqual(plain(saved.meshes.map(m => [m.id, m.kind])), [[1, 'hex'], [2, 'shell']]);
  const restored = setup({ imported: 'split-box' });
  const staged = await restored.workspace.stageRestore(saved);
  assert.deepEqual(plain(restored.workspace.savedOwners(staged)).map(([tag, elements]) => [tag, elements.length]), [['c'.repeat(32) + '#1', saved.meshes[0].elements.length], ['c'.repeat(32) + '#2', 1]]);
  // An old project's single mesh comes back as one mesh covering everything.
  const legacy = { ...saved, meshes: undefined, mesh: { elements: [7, 8], properties: [5] } };
  assert.deepEqual(plain(restored.workspace.savedOwners(await restored.workspace.stageRestore(legacy))), [['c'.repeat(32) + '#1', [7, 8]]]);
  // Remove asks for a second click, then takes only that mesh out of the model.
  f.click('mesh-remove', { value: '1' });
  assert.match(f.workspace.render().body, /Confirm remove/);
  assert.equal(f.calls.removed.length, 0);
  f.click('mesh-remove', { value: '1' }); await settle();
  assert.deepEqual(f.calls.removed, ['c'.repeat(32) + '#1']);
  body = f.workspace.render().body;
  assert.match(body, /Mesh regions <small>1/);
  assert.doesNotMatch(body, /Mapped HEX8/);
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

test('without the Gmsh plugin its choices are shown disabled with the reason; mapped hexes and quad shells stay on', async () => {
  const f = await imported({ gmsh: false });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
  await settle();
  f.workspace.api.step('mesh');
  let body = f.workspace.render().body;
  assert.match(body, /data-act="mesh-method" data-value="gmsh"[^>]*disabled/, 'the Gmsh method cannot be chosen');
  assert.doesNotMatch(body, /data-act="mesh-method" data-value="mapped"[^>]*disabled/);
  assert.doesNotMatch(body, /data-act="mesh-method" data-value="shell"[^>]*disabled/);
  assert.match(body, /Gmsh methods \(tets, triangle shells, sweeps\) are off: The Gmsh plugin is not installed/);
  f.click('mesh-method', { value: 'shell' });
  body = f.workspace.render().body;
  assert.match(body, /data-act="shell-element" data-value="tri"[^>]*disabled/, 'triangle shells are Gmsh\'s');
  assert.doesNotMatch(body, /data-act="shell-element" data-value="quad"[^>]*disabled/);
  assert.doesNotMatch(f.workspace.render().foot, /shell-mesh[^>]*disabled/, 'the quad shell can be generated');
  // A project saved with triangles still says why it cannot mesh them here.
  f.workspace.api.step('mesh');
  f.click('shell-element', { value: 'tri' });
  assert.match(f.workspace.render().body, /Switch to quad elements/);
  assert.match(f.workspace.render().foot, /shell-mesh[^>]*disabled/);
});

test('with the Gmsh plugin its methods are offered', async () => {
  const f = await imported({ gmsh: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  f.workspace.api.step('mesh');
  const body = f.workspace.render().body;
  assert.doesNotMatch(body, /data-act="mesh-method" data-value="gmsh"[^>]*disabled/);
  assert.doesNotMatch(body, /Gmsh methods \(tets/);
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

test('the surface tool stays on: each pair of picked faces makes a sheet, listed with its thickness and offset', async () => {
  const f = await imported({ imported: 'box', prepared: 'box' });
  const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
  let made = 0;
  // The mock kernel: every surface operation adds a sheet face (a box face freed from its solid stands in for it).
  f.transform.fn = (action, data, result) => {
    if (action !== 'prepare' || data.operation.kind !== 'surface') return result;
    made++;
    const topology = result.topology, face = topology.faces[made - 1];
    face.volumes = [];
    topology.sheets = topology.faces.slice(0, made).map((x, i) => ({ face: x.id, sheet: i + 1, thickness: 4, offset: i ? -2 : 0, label: i ? 'Surface on face 3' : 'Midsurface of faces 1 and 2' }));
    for (const x of topology.faces.slice(0, made)) x.volumes = [];
    return result;
  };
  const faces = f.workspace.getState().topology.faces.map(x => x.id);
  f.workspace.api.tool('surface');
  assert.match(f.workspace.render().body, /Pick a face of the wall, then the face across it/);
  f.workspace.api.select('face', [faces[0]]);
  assert.match(f.workspace.render().body, new RegExp(`Face ${faces[0]} picked: now pick the face across the wall`));
  f.workspace.api.select('face', [faces[1]]);
  await settle();
  let requests = f.calls.requests.filter(r => r.action === 'prepare');
  assert.deepEqual(plain(requests[0].data.operation), { kind: 'surface', faces: [faces[0], faces[1]], place: 'mid', label: `Midsurface of faces ${faces[0]} and ${faces[1]}` });
  assert.equal(f.workspace.getState().tool, 'surface', 'the tool stays on');
  // The next pair, placed on its first face.
  f.click('surface-place', { value: 'first' });
  f.workspace.api.select('face', [faces[2]]); f.workspace.api.select('face', [faces[3]]);
  await settle();
  requests = f.calls.requests.filter(r => r.action === 'prepare');
  assert.equal(requests[1].data.operation.place, 'first');
  // One face: an offset and a thickness.
  f.click('surface-mode', { value: 'one' });
  f.input('surface-offset', -1); f.input('surface-thickness', 3);
  f.workspace.api.select('face', [faces[4]]);
  await settle();
  requests = f.calls.requests.filter(r => r.action === 'prepare');
  assert.deepEqual(plain(requests[2].data.operation), { kind: 'surface', faces: [faces[4]], offset: -1, thickness: 3, label: `Offset of face ${faces[4]} by -1` });
  // The sheets are listed with their thickness and offset, and a picked sheet gets its own card.
  f.workspace.api.tool('surface');
  let body = f.workspace.render().body;
  assert.match(body, /Sheets<\/span><small>3/);
  assert.match(body, /Surface on face 3<\/strong><span>T 4 · ZOFFS -2 · 1 face/);
  f.workspace.api.select('face', [faces[1]]);
  body = f.workspace.render().body;
  assert.match(body, /Sheet 2 · T 4 · ZOFFS -2/);
  assert.match(body, /Remove sheet/);
  // Hiding a sheet hides its face only.
  f.click('toggle-sheet', { id: '2' });
  assert.ok(f.calls.overlays !== undefined);
  // Shell meshing offers the sheets as a scope.
  f.click('step', { value: 'mesh' });
  f.click('mesh-method', { value: 'shell' });
  body = f.workspace.render().body;
  assert.match(body, /Sheets 3/);
  assert.match(body, /Sheets use their own thickness and offset/);
  f.click('shell-scope', { value: 'sheets' });
  f.click('shell-mesh'); await settle();
  const shell = f.calls.requests.find(r => r.action === 'shell').data;
  assert.deepEqual(plain(shell.faceIds), faces.slice(0, 3));
});

test('Extend takes sheet edges, then the face to reach; Join fuses the sheets', async () => {
  const f = await imported({ imported: 'box', prepared: 'box' });
  const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 2)); };
  // Two of the box's faces stand in for sheets.
  const withSheets = result => { const t = result.topology; t.faces[0].volumes = []; t.faces[1].volumes = []; t.sheets = [{ face: t.faces[0].id, sheet: 1, thickness: 4, offset: 0, label: 'A' }, { face: t.faces[1].id, sheet: 2, thickness: 4, offset: 0, label: 'B' }]; return result; };
  f.transform.fn = (action, data, result) => (action === 'prepare' ? withSheets(result) : result);
  f.workspace.api.tool('surface');
  f.click('surface-mode', { value: 'one' });
  const first = f.workspace.getState().topology.faces[0].id;
  f.workspace.api.select('face', [first]); await settle();
  const t = f.workspace.getState().topology;
  f.workspace.api.tool('extend');
  assert.match(f.workspace.render().body, /Pick straight edges of a flat sheet/);
  const sheetEdge = t.faces[0].edges[0], solidEdge = t.edges.find(e => !e.faces.some(x => x === t.faces[0].id || x === t.faces[1].id))?.id;
  f.workspace.api.select('edge', [sheetEdge, ...(solidEdge ? [solidEdge] : [])]);
  assert.match(f.workspace.render().body, /1 sheet edge picked: now pick the face to extend to/, 'only sheet edges count');
  f.workspace.api.select('face', [t.faces[1].id]); await settle();
  const extend = f.calls.requests.filter(r => r.action === 'prepare').pop().data.operation;
  assert.deepEqual(plain(extend), { kind: 'extend', edges: [sheetEdge], target: t.faces[1].id, label: `Extended 1 sheet edge to face ${t.faces[1].id}` });
  assert.equal(f.workspace.getState().tool, 'extend', 'the tool stays on');
  f.click('sheets-join'); await settle();
  assert.equal(f.calls.requests.filter(r => r.action === 'prepare').pop().data.operation.kind, 'join');
  // A flat sheet's card splits the other sheets along its plane (control curves for a brace on a floor).
  f.workspace.api.tool('extend');
  const now = f.workspace.getState().topology;
  f.workspace.api.select('face', [now.faces[0].id]);
  assert.match(f.workspace.render().body, /Split sheets along its plane/);
  f.click('sheet-split'); await settle();
  const split = f.calls.requests.filter(r => r.action === 'prepare').pop().data.operation;
  assert.equal(split.kind, 'split-sheets');
  assert.deepEqual(plain(split.plane), { origin: plain(now.faces[0].surface.origin), normal: plain(now.faces[0].surface.normal) });
  assert.deepEqual(plain(split.faces), [now.faces[1].id], 'the other sheets');
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

test('owned mapped meshes wait for Apply, persist source/settings and never bind legacy tags',async()=>{
  const f=await imported({projectReview:true});f.workspace.api.step('mesh');f.workspace.api.setSize(3);
  await f.workspace.api.addMesh();assert.equal(f.calls.appends.length,0);
  const draft=await f.workspace.serialize();assert.equal(draft.meshes,undefined);
  assert.equal(f.calls.review.input.snapshot.prepared.format,'brep');
  f.calls.review.apply();const saved=await f.workspace.serialize();
  assert.ok(saved.meshes[0].projectOwner);assert.ok(saved.meshes[0].elements.length>0);
  const staged=await f.workspace.stageRestore(saved);assert.deepEqual(plain(f.workspace.savedOwners(staged)),[]);
  f.workspace.commitRestore(staged);await f.workspace.api.addMesh();
  assert.equal(f.calls.review.candidate.changes.length,0);
  f.workspace.api.setSize(2);await f.workspace.api.addMesh();
  assert.ok(f.calls.review.candidate.changes.some(c=>c.action==='remove'));
  const before=await f.workspace.serialize();assert.deepEqual(plain(before.meshes[0].elements),plain(saved.meshes[0].elements));
  assert.match(f.workspace.render().body,/committed mesh retained/);
  f.calls.review.apply();assert.notDeepEqual(plain((await f.workspace.serialize()).meshes[0].elements),plain(saved.meshes[0].elements));
});
test('a mapped CAD review rejects a changed sizing draft before applying',async()=>{
  const f=await imported({projectReview:true});f.workspace.api.step('mesh');f.workspace.api.setSize(3);
  await f.workspace.api.addMesh();f.workspace.api.setSize(2);
  assert.throws(()=>f.calls.review.apply(),/CAD draft changed/);
  assert.equal((await f.workspace.serialize()).meshes,undefined);
});

test('selected mapped solid targets survive save/reopen and selection edits invalidate cached previews',async()=>{
  const f=await imported({projectReview:true,imported:'split-box'});f.workspace.api.step('mesh');f.workspace.api.setSize(3);
  f.workspace.api.select('solid',[1]);f.click('mesh-scope',{value:'selected'});
  await f.workspace.api.addMesh();assert.deepEqual(f.calls.review.input.volumes,[1]);f.calls.review.apply();
  const saved=await f.workspace.serialize();assert.deepEqual(plain(saved.settings.mesh.selectedVolumes),[1]);
  f.workspace.commitRestore(await f.workspace.stageRestore(saved));await f.workspace.api.addMesh();
  assert.equal(f.calls.review.candidate.changes.length,0);
  f.workspace.api.select('solid',[2]);await f.workspace.api.addMesh();assert.deepEqual(f.calls.review.input.volumes,[2]);
  assert.ok(f.calls.review.candidate.changes.some(c=>c.action==='remove'));
});

test('owned shell and solid regions share source, restore separate settings, and only dirty the edited region',async()=>{
  const f=await imported({imported:'split-box',projectReview:true}),settle=async()=>{for(let i=0;i<40;i++)await new Promise(resolve=>setTimeout(resolve,2));};
  f.workspace.api.step('mesh');f.workspace.api.select('solid',[1]);f.click('mesh-scope',{value:'selected'});f.input('region-name','Solid root');
  await f.workspace.api.addMesh();f.calls.review.apply();const first=f.calls.review.input.id,savedSolid=plain(f.calls.review.candidate.ownership);
  f.click('mesh-new');f.input('region-name','Shell span');f.click('mesh-method',{value:'shell'});f.workspace.api.select('face',[11]);f.click('shell-scope',{value:'selected'});
  f.transform.fn=(action,data,r)=>{if(action==='shell'){r.mesh.elements[0].face=11;r.mesh.faceNodes={11:[1,2,3,4]};r.mesh.edgeNodes={6:[1,2]};r.quality.faces[0].face=11;}return r;};
  f.click('shell-mesh');await settle();assert.equal(f.calls.review.input.kind,'shell');assert.equal(f.calls.review.input.sourceId,first+'/source');
  assert.equal(f.calls.review.candidate.ownership.project.objects.filter(o=>o.kind==='source').length,1);
  assert.deepEqual(f.calls.review.candidate.ownership.owners.filter(o=>o.owner===first),savedSolid.owners.filter(o=>o.owner===first));f.calls.review.apply();
  const saved=await f.workspace.serialize();assert.equal(saved.meshes.length,2);assert.equal(saved.meshes.find(m=>m.projectOwner===first).stale,false);assert.deepEqual(plain(saved.settings.shell.selectedFaces),[11]);
  const staged=await f.workspace.stageRestore(saved);f.workspace.commitRestore(staged);assert.deepEqual(plain(f.workspace.getState().selection),{kind:'face',ids:[11]});
  f.input('shell-size','1');const dirty=await f.workspace.serialize();assert.equal(dirty.meshes.find(m=>m.projectOwner===first).stale,false);assert.equal(dirty.meshes.find(m=>m.kind==='shell').stale,true);
  f.click('shell-mesh');await settle();assert.equal(f.calls.review.input.id,saved.editingOwner);assert.equal(f.calls.review.candidate.changes.length,0,'unchanged mocked mesh is a card no-op');
});

test('restoring a midsurface region ignores leftover solid-scope selections',async()=>{
  const f=await imported({projectReview:true});f.workspace.api.step('mesh');await f.workspace.api.addMesh();f.calls.review.apply();
  const saved=await f.workspace.serialize();saved.settings.mesh={method:'shell',scope:'selected',selectedVolumes:[]};saved.settings.shell={placement:'midsurface',scope:'all',faces:[1],facesB:[2]};
  f.workspace.commitRestore(await f.workspace.stageRestore(saved));
  assert.equal((await f.workspace.serialize()).meshes[0].stale,false);
});
